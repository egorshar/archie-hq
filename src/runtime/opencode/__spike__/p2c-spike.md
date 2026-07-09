# P2-C Task-0 spike — opencode SSE event stream (findings)

Run live: `npx tsx --env-file=.env src/runtime/opencode/__spike__/p2c-events-spike.ts`
Env: opencode CLI 1.17.7 on PATH, OpenRouter authed, `ARCHIE_OPENCODE_MODEL_DEFAULT` set. Embedded server via `createOpencode` (same config shape as `server.ts`: `config.model` + `config.permission`).

## Pinned facts (each confirmed live)

1. **`(await client.event.subscribe()).stream` is an async-iterable** yielding one event object per event. `for await (const ev of sub.stream)` works. → Task 2 `startEventConsumer` uses exactly this shape (no change needed).

2. **`message.part.updated` carries tool parts.** For a normal read turn we saw `type: "message.part.updated"`, `properties.part.type === "tool"`, `properties.part.tool === "read"`, `properties.part.sessionID === <our session>`. The tool name is **lowercase** (`read`) — confirms the activity alias need (Task 1).

3. **`session.idle` fires** at end of turn (`type: "session.idle"`, `properties.sessionID`). Also present: `session.status` with `busy`/`idle` sub-states, `session.error` not seen on a healthy turn.

4. **The stream is GLOBAL.** It carries non-session events with no `sessionID` (`catalog.updated`, `plugin.added`, `reference.updated`, `server.heartbeat`) interleaved with the session's events. → Filtering by `sessionID` (via `sharedRegistry.get`) is **required**; `handleOpencodeEvent` already ignores events whose session isn't registered and whose part isn't a tool. ✅

5. **No auth on `event.subscribe`.** Same embedded server; the call needs no bearer token. ✅

6. **Ordering.** Tool parts and `session.idle` arrive **during** the `prompt()` await (timestamps well before the post-return drain). This is exactly the desired behavior: the consumer surfaces activity live, mid-turn. P2-C keeps `prompt()`-return as the turn boundary (idle logged only) — the stream is observation, not control.

## Extra findings (inform Task 2, no plan change)

- **Tool parts fire multiple times per call** (state transitions: pending → running → completed) — so `noteActivity` is invoked several times for one `read`. Harmless: the status line is an idempotent "current activity" set, and `deriveActivity` returns the same phrase each time.
- Other part types seen and correctly ignored by the consumer: `text`, `reasoning`, `step-start`, `step-finish`, plus `message.part.delta` (streaming text deltas, a distinct event type — not `message.part.updated`).
- `session.next.agent.switched` / `session.next.model.switched` appear at session start — not relevant to activity.

## Verdict

The Task 2 design (`events.ts`: global `event.subscribe()` → `for await` → filter tool parts by registered `sessionID` → `task.noteActivity`) is confirmed against the live server. No corrections needed to the plan's `startEventConsumer` / `handleOpencodeEvent` shapes. The not-found error shape for Task 3 was NOT exercised here (healthy session only) — Task 3 keeps its assumed `404` / name-regex detection and confirms against a live stale-session in T6.
