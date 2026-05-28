# Memory Layer

The memory layer gives Archie persistent cross-task knowledge — organizational facts, user preferences, and a rolling activity index. It is a self-contained subsystem under `src/memory/`, gated by the `ARCHIE_MEMORY` feature flag, and designed to be removable as a single unit.

This document describes the implementation as-built. The capability spec lives at `openspec/specs/memory-layer/spec.md` and includes hardening requirements that are not yet implemented (tracked under `openspec/changes/harden-memory-layer/`).

## Goals

- Eliminate "new hire every task" behavior — agents should arrive informed.
- Stay simple and ejectable — Markdown files, no database, one feature flag.
- Keep a one-way dependency: `src/memory/` imports from core; core never imports from `src/memory/`.

## Two-Path Architecture

```
                ┌──────────────── READ PATH (push) ────────────────┐
                │                                                  │
  spawnAgent ──▶│  extractTaskUsernames(taskId)                    │
  (PM / repo /  │      └─ scans knowledge.log for Slack mentions   │
   plugin track)│                                                  │
                │  enrichPromptWithMemory(systemPrompt, users)     │
                │      ├─ readOrg()      ─▶ <organizational_…>     │
                │      ├─ readUser(u)    ─▶ <user_preferences …>   │
                │      └─ readActivity() ─▶ <recent_activity>      │
                │                                                  │
                │  appended under "## Organizational Memory"       │
                │  header in the agent's system prompt             │
                └──────────────────────────────────────────────────┘
                                       │
                                       ▼
                ┌────────── workdir/memory/ (Markdown store) ──────┐
                │   org.md                ── ## Section / bullets  │
                │   users/<id>.md         ── ## Section / bullets  │
                │   recent-activity.md    ── markdown table        │
                │   sessions/<taskId>/shared/summary.md (per-task) │
                └──────────────────────────────────────────────────┘
                                       ▲
                                       │
                ┌─────────────── WRITE PATH (extraction) ──────────┐
                │                                                  │
  task:completed│  initMemory() subscribes:                        │
  event ──────▶ │      onEvent('task:completed') →                 │
                │      handleTaskCompleted(taskId)                 │
                │                                                  │
                │  Sequential in-memory promise queue              │
                │      ↓                                           │
                │  processExtraction(taskId):                      │
                │   1. loadMetadata, readKnowledgeLog              │
                │   2. extract Slack user mentions                 │
                │   3. read current org + (first-user) user mem    │
                │   4. runExtraction()  ── Sonnet side-agent       │
                │       maxTurns: 1, allowedTools: []              │
                │       prompts/memory-extractor.md                │
                │   5. applyOrgUpdates + applyUserUpdates          │
                │   6. write sessions/<taskId>/shared/summary.md   │
                │   7. appendActivity + trimActivity(50)           │
                │   8. postSlackMessage to originating threads     │
                └──────────────────────────────────────────────────┘
```

## Components

```
src/memory/
├── index.ts        — initMemory(): bootstrap + event subscription
├── types.ts        — MemoryUpdate, ExtractionResult, ActivityEntry
├── paths.ts        — getMemoryDir, getOrgPath, getUserPath, getRecentActivityPath
├── store.ts        — readOrg, writeOrg, readUser, writeUser, applyUpdate, applyOrgUpdates, applyUserUpdates
├── context.ts      — buildMemoryContext, enrichPromptWithMemory (read path)
├── activity.ts     — readActivity, appendActivity, trimActivity (recent-activity.md)
├── extractor.ts    — buildExtractionPrompt, parseExtractionResponse, runExtraction (Sonnet)
├── lifecycle.ts    — handleTaskCompleted, processExtraction (write path orchestrator)
└── __tests__/      — store, context, extractor, lifecycle (integration), activity tests

prompts/
└── memory-extractor.md — extraction prompt template (Sonnet side-agent)

workdir/memory/                                  (runtime, gitignored)
├── org.md
├── users/<id>.md
└── recent-activity.md

workdir/sessions/<taskId>/shared/summary.md      (runtime, gitignored)
```

## Read Path — Memory Injection at Spawn

`src/agents/spawn.ts` calls `enrichPromptWithMemory()` after assembling the track-specific system prompt for every agent it spawns. Three call sites, one per track:

| Track | Location | Trigger |
|-------|----------|---------|
| PM | `spawn.ts:256-257` | Every PM agent spawn |
| Repo | `spawn.ts:384-385` | Every repo agent spawn |
| Plugin | `spawn.ts:482-483` | Every plugin agent spawn |

The helper `extractTaskUsernames(taskId)` (`spawn.ts:125-146`) parses the task's `knowledge.log` for Slack mention markers `[@<UID:First Last>]` and returns the unique set of lowercase first names — the same identifiers used as user-memory filenames. These names are the only users for whom `<user_preferences>` blocks are injected.

`buildMemoryContext(usernames)` (`src/memory/context.ts`) assembles up to three XML-tagged blocks:

```
<organizational_knowledge>
{contents of org.md}
</organizational_knowledge>

<user_preferences user="alice">
{contents of users/alice.md}
</user_preferences>

<recent_activity>
{contents of recent-activity.md}
</recent_activity>
```

`enrichPromptWithMemory()` appends the block to the prompt under a fixed `## Organizational Memory` header with a short instruction line. If the layer is disabled or no memory exists, the original prompt is returned unchanged.

## Write Path — Extraction on Task Completion

### Trigger

`initMemory()` (`src/memory/index.ts`) runs once at startup, after `initEventPersistence()` in `src/index.ts:98`. It:

1. Returns immediately if `ARCHIE_MEMORY=false`.
2. Creates `workdir/memory/` and `workdir/memory/users/`.
3. Subscribes a listener via `onEvent()` to the `task:completed` event emitted by `Task.complete()` (`src/tasks/task.ts:546`).

When the event fires, `handleTaskCompleted(taskId)` is invoked. It is fire-and-forget — no caller awaits the result.

### Sequential Queue

`lifecycle.ts` maintains a module-level `extractionQueue: Promise<void>` that chains every new extraction onto the previous one. This serializes writes to `org.md`, `users/*.md`, and `recent-activity.md` across concurrent task completions.

> ⚠️ **Not durable.** If the process exits between `task:completed` and queue drain, the pending extraction is lost. See `openspec/changes/harden-memory-layer/` REQ-M4.

### Extraction Pipeline (`processExtraction`)

```
1. loadMetadata(taskId)                  ──▶ task metadata (participants, channels, status)
2. readKnowledgeLog(taskId)              ──▶ transcript
3. extractUsernames(transcript)          ──▶ Slack mention first names
4. readOrg() + readUser(usernames[0])    ──▶ existing memory (only first user — see L2)
5. runExtraction({...})                  ──▶ Sonnet side-agent (maxTurns: 1, no tools)
6. applyOrgUpdates(result.org_updates)
7. applyUserUpdates(user, updates) per user
8. writeFile(summary.md) with YAML frontmatter
9. appendActivity({...}) + trimActivity(50)
10. postSlackMessage("📝 Learned from this task: ...") per originating Slack thread
```

### The Extraction Side-Agent

`runExtraction()` (`extractor.ts:187`) invokes the Claude Agent SDK's `query()` with:

- `model: 'sonnet'`
- `maxTurns: 1` — no multi-turn behavior; one prompt, one response.
- `allowedTools: []` — no tool calls.
- `executable: 'node'`, `pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || 'claude'`.
- A fresh subprocess env limited to `NODE_ENV`, `ANTHROPIC_API_KEY`, `PATH`.

The agent's prompt comes from `prompts/memory-extractor.md` (substituted via `loadPrompt()`). The expected response is a JSON object matching `ExtractionResult`:

```ts
interface ExtractionResult {
  org_updates: MemoryUpdate[];
  user_updates: Record<string, MemoryUpdate[]>;
  task_summary: string;
  activity_summary: string;
  domain: string;
}

interface MemoryUpdate {
  action: 'add' | 'update';
  section?: string;
  content: string;
  old?: string;   // 'update' only
}
```

`parseExtractionResponse()` strips Markdown code fences, parses JSON, validates the top-level shape and every `MemoryUpdate`, and returns `null` on any failure. Failure is logged and skipped — extraction is best-effort.

The transcript is truncated to 100,000 characters before being substituted; longer transcripts get a `[truncated]` sentinel.

## Storage Formats

### `org.md`

```markdown
## Engineering
- Backend uses NestJS with PostgreSQL (Prisma ORM)
- Feature flags via LaunchDarkly

## Marketing
- Blog posts require Sarah's approval before publishing
```

`applyUpdate()` (`store.ts:59`) handles two actions:

- **`add`** — Find `## {section}` header. If found, append `- {content}` at the section's last non-empty line. If missing, append a new `## {section}` block at file end. If no section is given, append at file end.
- **`update`** — Find the first line containing `old`. If found, replace it with `- {content}`. If not found, fall through to `add` behavior (⚠️ see the "Unmatched update actions SHALL NOT silently append" requirement).

### `users/<id>.md`

Identical structure to `org.md`. Today the filename is `<lowercase-first-name>.md` (see paths.ts:32). Stable-ID keying is in `harden-memory-layer/M1`.

### `recent-activity.md`

```markdown
# Recent Activity

| Date | Task ID | Summary | Domain | User |
|------|---------|---------|--------|------|
| 2026-04-10 | task-20260410-1000-abc | Fixed login validation bug | engineering | egor |
| 2026-04-09 | task-20260409-1530-def | Updated blog copy | marketing | sarah |
```

`appendActivity()` inserts new rows immediately after the separator (newest first). `trimActivity(50)` rewrites the file with only the most recent 50 rows when the cap is exceeded.

### `sessions/<taskId>/shared/summary.md`

```markdown
---
task_id: task-20260410-1000-abc123
status: completed
created_at: 2026-04-10T10:00:00Z
updated_at: 2026-04-10T10:30:00Z
domain: engineering
---

Investigated and fixed the login bug. Root cause was missing input validation in the auth handler. Backend agent added the validation, opened PR, and merged after review.
```

## Feature Flag

`ARCHIE_MEMORY` is the single off-switch:

- `ARCHIE_MEMORY=false` — every entry point becomes a no-op:
  - `initMemory()` returns immediately without creating dirs or subscribing to events.
  - `enrichPromptWithMemory()` returns its input unchanged.
  - `handleTaskCompleted()` returns immediately.
- `ARCHIE_MEMORY` unset, or any value other than `false` — enabled. The default state.

`.env.example` documents the variable.

## Ejection

The plan was built to support clean removal in five steps:

1. `rm -rf src/memory/`
2. `rm prompts/memory-extractor.md`
3. Remove `import { initMemory } from './memory/index.js'` and the `await initMemory();` call from `src/index.ts`.
4. Remove `import { enrichPromptWithMemory, isMemoryEnabled }`, the `extractTaskUsernames()` helper, and the three memory-injection call sites from `src/agents/spawn.ts`.
5. `rm -rf workdir/memory/`

No type changes propagate to other modules, no database migrations, no external service cleanup. Core never imports from `src/memory/`.

## Testing

| File | Surface tested |
|------|----------------|
| `store.test.ts` | `readOrg`, `writeOrg`, `readUser`, `writeUser`, `applyUpdate` (add/update against fixtures) |
| `context.test.ts` | `buildMemoryContext`, `enrichPromptWithMemory` (XML block assembly, disabled-flag passthrough) |
| `extractor.test.ts` | `buildExtractionPrompt` (placeholder substitution), `parseExtractionResponse` (valid/invalid/fenced JSON) |
| `lifecycle.test.ts` | End-to-end integration: mocks `runExtraction` + persistence + slack client, verifies all four writes and the Slack post |
| `activity.test.ts` | `readActivity`, `appendActivity`, `trimActivity` (table parsing, newest-first ordering, cap behavior) |

Run with `npx vitest run src/memory/__tests__/` or `npm test`.

## Known Gaps

These are formalised as requirements in `openspec/specs/memory-layer/spec.md` and bundled as work in `openspec/changes/harden-memory-layer/`:

| ID | Gap | Spec requirement |
|----|-----|------------------|
| M1 | User memory keyed by first name (collides for same first names) | User memory MUST be keyed by stable identifier |
| M2 | No sanitization before Markdown writes (model can corrupt files) | Sanitization MUST run before any Markdown write |
| M3 | Unmatched `update` actions silently become root-level `add`s | Unmatched update actions SHALL NOT silently append |
| M4 | Extraction queue is in-memory only (lost on restart) | Extraction MUST be durable across restarts |
| M5 | Weak prompt-injection defense in extractor | Prompt-injection defense in extractor |
| L1 | "Learned" Slack message posts even when no learnings extracted | Learned-from-this-task Slack post (REMOVED by harden-memory-layer) |
| L2 | Only first user's existing memory loaded into extraction | Existing memory for ALL involved users SHALL be passed to extraction |

## Future Enhancements (Not in scope)

- **Pull retrieval via MCP** (`memory_search`, `memory_get_recent`) — the original Feb-2026 design favored pull-on-demand over push-on-spawn. Deferred until injection scaling becomes a problem.
- **Channel visibility / access control** — public-vs-private filtering at retrieval time. Deferred until a concrete leak surface is identified.
- **Domain-split org files** — split `org.md` into `org/engineering.md`, `org/marketing.md` once a single file becomes context-heavy.
- **Embedding search over summaries** — vector retrieval over `sessions/*/summary.md` for relevant past-task lookup.
- **Slack reaction → revert** — let users react ❌ on a "Learned" message to remove the just-applied entries.
- **Periodic consolidation** — monthly Sonnet pass over `org.md` to dedupe and flag stale entries.

## Related Documentation

- [Spec](../../openspec/specs/memory-layer/spec.md) — target capability spec with numbered requirements
- [Hardening proposal](../../openspec/changes/harden-memory-layer/proposal.md) — bundled improvements to close the gaps above
- [Agents](agents.md) — agent prompt composition (memory is appended last)
- [Orchestration](orchestration.md) — task lifecycle and event emission
- [Persistence](persistence.md) — `knowledge.log` and metadata storage that extraction reads from
