# Spike: does opencode honor a per-prompt `body.model` object? — VERDICT: ROUTES

**Date:** 2026-07-10
**Question:** The B.1 spike concluded `body.model` is ignored (routing = server-global `config.model`). But the SDK types `SessionPromptData.body.model` as an OBJECT `{ providerID: string; modelID: string }`, not a string. Re-test with the correct shape.

**Method:** `createOpencode({ config: { model: <DEFAULT route> } })`, then `session.promptAsync` with `body.model = { providerID, modelID }` pointing at a DIFFERENT route, then read `session.messages` and inspect the assistant message's `modelID`/`providerID`. (Isolated SDK-direct probe — no Archie bridge/plugin, so the running dev server's `.opencode/plugins` is untouched.)

**Result:**
```
config.model(default) = openrouter/z-ai/glm-5.2
body.model(spike)     = openrouter/openai/gpt-4o-mini
assistant message:      providerID=openrouter  modelID=openai/gpt-4o-mini
```

The assistant turn ran on the `body.model` route (`openai/gpt-4o-mini`), NOT `config.model` (`z-ai/glm-5.2`).

**VERDICT: ROUTES.** Per-turn `body.model` as `{ providerID, modelID }` takes effect. The B.1 "ignored" finding was made with the wrong shape (a string). Proceed with Approach A (per-turn `body.model` object) — Tasks 1–3 of the plan. Approach B (`config.agent`+`body.agent`) is not needed.
