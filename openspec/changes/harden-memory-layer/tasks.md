## 1. Pre-flight

- [ ] 1.1 Re-read `proposal.md`, `design.md`, and the delta spec at `specs/memory-layer/spec.md`.
- [ ] 1.2 Verify `npm run typecheck` and `npm test` are green on `feature/memory-layer` before starting.
- [ ] 1.3 `grep -rn "shared/summary.md" src/` to confirm `lifecycle.ts` is the only writer/reader of the old per-task summary path.

## 2. Sanitizer (sanitization + prompt-injection defense requirements)

- [ ] 2.1 Create `src/memory/sanitize.ts` with `sanitizeUpdate(update): MemoryUpdate | null`, `sanitizeActivityEntry(entry): ActivityEntry | null`, `isAllowedSection(s)`, `isAllowedDomain(d)`, `escapeTableCell(v)`.
- [ ] 2.2 Add prompt-injection heuristics in the same module: `looksLikeInstruction(content)` (matches `/^(always|never|must|do not)\b/i` + imperative verb, and bypass-shaped tokens like `system prompt`, `ignore previous`, `you are`, `act as`) and `looksLikeSecret(content)` (long alphanumeric runs after `=`, `Bearer `, `sk-`, `xoxb-`, `ghp_`, etc.). Wire both into `sanitizeUpdate` rejection path.
- [ ] 2.3 Route `applyOrgUpdates` and `applyUserUpdates` in `src/memory/store.ts` through `sanitizeUpdate`. Drop+log rejected entries via `logger.warn('memory', …)`.
- [ ] 2.4 Route `appendActivity` in `src/memory/activity.ts` through `sanitizeActivityEntry`.
- [ ] 2.5 Add `src/memory/__tests__/sanitize.test.ts`. Table-driven, one row per rule, positive + negative. Include adversarial fixtures: instruction-shaped lines, role-play directives, API-key-shaped strings.
- [ ] 2.6 Confirm existing `store.test.ts`, `activity.test.ts`, `lifecycle.test.ts` still pass.

## 3. Skip unmatched updates (unmatched-update requirement)

- [ ] 3.1 In `src/memory/store.ts:applyUpdate`, when `action === 'update'` and `old` is not found, return the input string unchanged and `logger.warn('memory', …)`.
- [ ] 3.2 Add a case to `store.test.ts`: `applyUpdate("## Eng\n- A\n", {action:'update', old:'B', content:'C'})` returns input unchanged; logger is invoked.
- [ ] 3.3 Tighten `prompts/memory-extractor.md` Rules section: discourage `update` actions without a confidently-matched `old`.

## 4. Raw Slack ID identity (user-memory identifier requirement)

- [ ] 4.1 Tighten `src/memory/paths.ts:getUserPath()` signature to `getUserPath(id: string): string`. Guard with regex `^(U|W|B|T)[A-Z0-9]{6,}$` for Slack IDs OR `^(cli|local):[A-Za-z0-9_-]+$` for fallback. Throw on mismatch.
- [ ] 4.2 Update mention parsing in `src/memory/lifecycle.ts:extractUsernames` and `src/agents/spawn.ts:extractTaskUsernames` to return raw IDs (drop the `.split(' ')[0].toLowerCase()` transformation). New return shape: `{ userId, displayName }[]`.
- [ ] 4.3 Add `resolveFallbackId(metadata): string` — for CLI channels return `cli:<sessionId>`; absent a session id, return `cli:<taskId>`.
- [ ] 4.4 When `writeUser` creates a new file, prepend YAML frontmatter (`slack_user_id`, `display_name`, `aliases`). Existing files keep their existing frontmatter.
- [ ] 4.5 Update `src/memory/context.ts:buildMemoryContext` to render `<user_preferences user_id="U…" display_name="...">` (fall back to user_id only if no frontmatter).
- [ ] 4.6 At `initMemory()` startup, scan `users/` for non-`U/W/B/T/cli:/local:` filenames and `logger.warn('memory', 'legacy user file: <name>')` — do not auto-rename.
- [ ] 4.7 Add `src/memory/__tests__/paths.test.ts` covering accepted and rejected IDs (Slack prefixes, fallback prefix, bare first name, empty string).
- [ ] 4.8 Update `lifecycle.test.ts` fixtures to use raw `U…` IDs.
- [ ] 4.9 Update `src/memory/__tests__/context.test.ts` to assert the new `<user_preferences>` attributes.

## 5. Multi-user existing memory in extraction

- [ ] 5.1 In `lifecycle.ts:processExtraction`, build `userMemory` by concatenating each involved user's existing memory (labelled with `## <userId> (<displayName>)` headers) instead of only the first user. Use `Promise.all`.
- [ ] 5.2 In `extractor.ts:parseExtractionResponse`, drop any `user_updates[key]` whose `key` is not in the involved-users list. Log the drop. (Need to thread the allowed set into the parser; either via closure or as a second arg.)
- [ ] 5.3 Update `lifecycle.test.ts` to mock two users; assert the extractor receives both blocks and that an update for a third user is dropped.

## 6. Remove the "Learned from this task" Slack post (REMOVED requirement)

- [ ] 6.1 Delete `postLearnings()` from `src/memory/lifecycle.ts`.
- [ ] 6.2 Remove the call site for `postLearnings()` in `processExtraction`.
- [ ] 6.3 Remove the import of `postSlackMessage` from `lifecycle.ts` (only used for the now-deleted post).
- [ ] 6.4 Remove `import type { SlackChannel, SlackThreadRef }` if no longer used elsewhere in `lifecycle.ts`.
- [ ] 6.5 Remove the corresponding test case `'calls postSlackMessage with the learnings message'` from `lifecycle.test.ts` and the `postSlackMessage` mock if no other test depends on it.
- [ ] 6.6 Update `docs/architecture/memory.md` to remove the step "8. Post learnings to Slack threads" from the extraction pipeline diagram, and remove the "Posts to Slack" mention from the feature description. Note that visibility is now via logs + per-task summary.

## 7. Housekeeping (new ADDED requirement)

- [ ] 7.1 Create `src/memory/housekeeping.ts` exposing `runHousekeeping(target: 'org' | 'all' | string): Promise<void>`. Internal helpers: `consolidateFile(path)`, `traceBackOutput(input, output): boolean` (per-bullet edit-distance ≤ 40%).
- [ ] 7.2 Create `prompts/memory-housekeeper.md` — Sonnet prompt instructing the side-agent to merge / drop / reorder bullets but never paraphrase or introduce new content. Include explicit examples.
- [ ] 7.3 Add inline `<!-- touched: YYYY-MM-DD -->` annotation support in `src/memory/store.ts:applyUpdate` (add on `add`, refresh on matched `update`). Strip during section parsing so the bullet's visible text is unchanged.
- [ ] 7.4 Add `parseLastTouched(line: string): string | null` and `stripLastTouched(line: string): string` helpers (probably co-located in `store.ts` or a new `annotations.ts`).
- [ ] 7.5 Soft-cap detection in `applyOrgUpdates` / `applyUserUpdates`: after writing, count bullets per section and total; if over the configured cap, enqueue a housekeeping job on `extractionQueue`. Debounce so a target already queued does not re-enqueue.
- [ ] 7.6 Wire the housekeeping queue through the same `extractionQueue` from `lifecycle.ts` to serialize with extraction.
- [ ] 7.7 Add env flags to `paths.ts`: `isHousekeepingEnabled()` (default `true`), `getOrgCap()` / `getUserCap()` / `getSectionCap()` / `getStalenessDays()`. Document in `.env.example`.
- [ ] 7.8 Add manual entry point: `scripts/memory-housekeeping.ts` that imports and calls `runHousekeeping`. Document via `npm run memory:housekeeping -- --target org`.
- [ ] 7.9 Pipe housekeeping consequences into the next task's summary `## Memory Updates` section (a `**housekeeping**` line, e.g., `dropped 3 stale entries, merged 2 duplicates`). Coordination is via a small in-memory queue read by `buildSummaryMarkdown`.
- [ ] 7.10 Tests in `src/memory/__tests__/housekeeping.test.ts`:
  - `traceBackOutput` accepts verbatim-preserved bullet, rejects paraphrased.
  - `parseLastTouched` / `stripLastTouched` round-trip with `applyUpdate`'s annotation.
  - Soft-cap auto-trigger: write 31 bullets in a single section (cap 30); housekeeping enqueued.
  - Disabled flag: same scenario, flag off, no housekeeping enqueued, warning logged.
  - Stale-window drop: bullet annotated 200 days ago in 180-day window is removed by consolidation.

## 8. Summary location + content (per-task summary requirement)

- [ ] 8.1 In `src/memory/paths.ts`: add `getSummaryPath(taskId): string` → `workdir/memory/summaries/<taskId>.md`. Remove `getTaskSummaryPath`'s old session-dir resolution (or repoint it; confirm via grep this is the only caller).
- [ ] 8.2 In `initMemory()`, also create `workdir/memory/summaries/` at startup.
- [ ] 8.3 Refactor `buildSummaryMarkdown(taskId, metadata, result, appliedUpdates)` in `lifecycle.ts` to produce the schema from design.md §D9: frontmatter (`task_id`, `status`, `created_at`, `updated_at`, `domain`, `extraction_at`, `links` with slack/github/cli arrays), `# Summary`, `## Memory Updates` (grouped per target file with action + section + content/diff bullets, including housekeeping notes from §7.9), `## Related Tasks`.
- [ ] 8.4 Implement `selectRelatedTasks(activitySummary, domain, activityIndex): ActivityEntry[]` — filter by domain, score by token-overlap (stopword-removed), top 5 with minimum 2-token overlap.
- [ ] 8.5 Render `## Memory Updates` with the explicit literal `_no durable learnings_` when both update lists are empty.
- [ ] 8.6 Render `## Related Tasks` with the explicit literal `_no related tasks found_` when zero candidates clear the threshold.
- [ ] 8.7 Build the `links` block by introspecting `metadata.channels`: Slack threads produce `{channel_id, thread_id, url}`; GitHub PRs produce `{url}`; CLI sessions produce session IDs.
- [ ] 8.8 Update `lifecycle.test.ts` to assert: new path is written, old path is not, frontmatter has expected keys, memory-updates section reflects mocked updates and a mocked housekeeping note, related-tasks section reflects mocked activity index.

## 9. Durable extraction queue (durable-extraction requirement)

- [ ] 9.1 Add `src/memory/pending-queue.ts`:
  - `enqueuePending(taskId)` — append `- {taskId}` to `workdir/memory/pending-extractions.md` via tmp-then-rename.
  - `dequeuePending(taskId)` — rewrite file without that line.
  - `readPending(): string[]` — return all queued task IDs.
- [ ] 9.2 Wire `handleTaskCompleted` to `enqueuePending` before scheduling; wire `processExtraction` to `dequeuePending` on success.
- [ ] 9.3 At `initMemory()` startup, call `readPending()` and re-schedule each via `handleTaskCompleted` (or equivalent that doesn't re-enqueue).
- [ ] 9.4 Add `src/memory/__tests__/pending-queue.test.ts`: enqueue/dequeue/read round-trip on a temp dir; concurrent enqueue does not lose entries.
- [ ] 9.5 Add restart-resilience integration test in `lifecycle.test.ts`: enqueue, simulate process exit (don't drain), call `initMemory()` fresh, observe extraction runs.

## 10. Docs + spec alignment

- [ ] 10.1 Update `docs/architecture/memory.md`:
  - Remove the "Known Gaps" table (all gaps closed).
  - Storage section: new `summaries/` directory entry, new `pending-extractions.md` entry, raw Slack ID filename rule, frontmatter shape for user files.
  - Feature-flag section: add `ARCHIE_MEMORY_HOUSEKEEPING` + the four caps; remove any reference to the now-deleted Slack post.
  - New "Housekeeping" section between "Storage Formats" and "Feature Flag" covering trigger, mechanism, side-agent constraint, env flags.
  - Update the extraction-pipeline diagram to drop step 8 (Slack post) and clarify summary path.
- [ ] 10.2 Once this change archives, ensure `openspec/specs/memory-layer/spec.md` no longer carries the `*(Currently violated — see harden-memory-layer.)*` markers on the affected requirements, and the "Learned-from-this-task Slack post" requirement is removed.

## 11. Verification

- [ ] 11.1 `npm run typecheck` — green.
- [ ] 11.2 `npm test` — green; new test count delta ≈ +25.
- [ ] 11.3 Manual smoke run:
  - `ARCHIE_MEMORY=true ARCHIE_MEMORY_HOUSEKEEPING=true npm run dev`.
  - Drive a Slack task mentioning two distinct users to completion.
  - Observe `workdir/memory/users/U<id1>.md` and `users/U<id2>.md` with YAML frontmatter and `<!-- touched: -->` annotations.
  - Observe `workdir/memory/summaries/<taskId>.md` with `# Summary`, populated `## Memory Updates`, populated `## Related Tasks` (or the empty placeholder).
  - Observe NO "Learned from this task" message in the originating Slack thread.
  - Observe `workdir/memory/pending-extractions.md` is empty after extraction completes.
- [ ] 11.4 Restart-resilience smoke run:
  - Temporarily insert `await new Promise(r => setTimeout(r, 60_000))` at the start of `processExtraction` (dev only).
  - Trigger `task:completed`. Observe `pending-extractions.md` has the entry.
  - `kill -9` the process. Confirm the entry remains.
  - Restart. Observe extraction runs and the entry is removed.
  - Revert the artificial delay.
- [ ] 11.5 Housekeeping smoke run:
  - Pre-seed `workdir/memory/org.md` with 31 bullets in one section (cap 30).
  - Trigger a task completion that touches that section.
  - Observe consolidation runs and `<!-- touched: -->` annotations remain on surviving bullets.
  - Observe the resulting summary's `## Memory Updates` contains a `**housekeeping**` line.

## 12. Archive

- [ ] 12.1 Move `openspec/changes/harden-memory-layer/` to `openspec/changes/archive/<date>-harden-memory-layer/`.
- [ ] 12.2 Confirm `openspec list` no longer reports the change as active.
- [ ] 12.3 Confirm `openspec/specs/memory-layer/spec.md` has been updated by the archive process to reflect the merged deltas (Slack-notification requirement removed, housekeeping requirement added, the 7 MODIFIED requirements have current content without the `*(Currently violated)*` markers).
