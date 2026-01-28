# Agent Recovery & Handoff Resilience

## Core Principle

Agents work autonomously - research, implement, commit, coordinate with other repo agents as needed. No phases, no subagents, no orchestration complexity. Agents have full autonomy in how they approach work.

## Data Tracked

### Per Task
- `failure_counter` - increments on each recovery, resets to 0 after fresh context
- `task_completed` flag
- `task_owner` - repo agent assigned by PM

### Per Agent
- `last_activity_timestamp`
- `recovery_mode`: `none | reinforcement | fresh_context`

## Event-Driven Recovery

### How It Works

- Each agent reports idle state when it stops working (event hook)
- On any idle event, check if ALL agents in session are idle
- No polling, no timeouts, no state machine - purely event-driven

### When All Agents Idle

1. If `task_completed` → do nothing (normal state)
2. If not completed:
   - Increment `failure_counter`
   - For agents that have been active in this session (have timestamp):
     - If `failure_counter >= 3` → set `recovery_mode = fresh_context`, reset `failure_counter = 0`
     - Else → set `recovery_mode = reinforcement`
   - Find agent with most recent `last_activity_timestamp`
   - If it's a repo agent → spin up task owner
   - If it's PM → spin up PM

### On Any Agent Spin-Up

- Check `recovery_mode`, apply if set (reinforcement prompt or fresh context)
- Clear `recovery_mode` after spin-up
- Normal flow continues (owner reinforces other repo agents if needed)

## Hard Gate

PM completion tool fails if any repo agent is still active. Prevents premature task closure.

## Fallback Routing

If agent still can't hand off properly after reinforcement/fresh context, lighter model extracts intent/summary from output and routes it to the right target.

## Escape Hatch

User can always ask for status. Triggers new flow, agents read knowledge log, system recovers naturally.

## Session Recovery After Fresh Context

- Agent starts with clean context
- Agent reads knowledge log on startup (standard behavior, no injection needed)
- Agent picks up cleanly with full compliance

## Why This Works

- Event-driven, no polling or timeouts
- Simple data model, no state machine
- Hard gate prevents incomplete completion
- User always has manual recovery path
- Knowledge log provides continuity across fresh contexts
- Agents stay creative and autonomous
- System self-heals from drift
- Never breaks from user's perspective

## Implementation Scope

- Idle event hook per agent
- `failure_counter` per task
- `recovery_mode` flag per agent
- Timestamp tracking per agent
- Hard gate on PM completion tool
- Lightweight fallback extraction call
