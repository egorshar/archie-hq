# Task Persistence

## Overview

Task Persistence handles how tasks are stored, recovered, and tracked throughout their lifecycle. Each task gets its own isolated session with metadata, logs, summaries, and git worktrees.

**Key principle:** Task state on disk is immutable. Active tasks have in-memory runtime state managed by System layer.

## Task Session Architecture

```
sessions/
  task-456/
    metadata.json              # Task configuration and state
    shared-knowledge.log       # Chronological log of all activity
    memory/
      summary.md              # Task summary (evolving or final)
    worktrees/
      backend/                # Git worktree for backend repo
      mobile/                 # Git worktree for mobile repo
      website/                # Git worktree for website repo (if needed)

memory/
  workspace-context.md        # Global preferences and team context
```

## Metadata Schema

**`sessions/task-456/metadata.json`**

```json
{
  "task_id": "task-456",
  "thread_owner": "backend-agent",
  "participants": ["backend-agent", "mobile-agent"],

  "slack_threads": [
    {
      "thread_id": "1234567890.123456",
      "last_processed_ts": "1234567890.123500"
    },
    {
      "thread_id": "1234567890.789012",
      "last_processed_ts": "1234567890.789050"
    }
  ],

  "agent_sessions": {
    "pm-agent": "sdk-session-xyz789",
    "backend-agent": "sdk-session-abc123",
    "mobile-agent": "sdk-session-def456"
  },

  "repositories": {
    "backend": {
      "worktree_path": "/sessions/task-456/worktrees/backend",
      "branch": "task-456-auth-fix",
      "base_branch": "main",
      "base_sha": "abc123def456"
    },
    "mobile": {
      "worktree_path": "/sessions/task-456/worktrees/mobile",
      "branch": "task-456-auth-fix",
      "base_branch": "main",
      "base_sha": "789abc012def"
    }
  },

  "status": "in_progress",  // or "stopped", "completed"
  "created_at": "2024-01-15T10:00:00Z",
  "updated_at": "2024-01-15T11:30:00Z"
}
```

### Metadata Fields

**`task_id`** (string)
- Unique identifier for this task
- Format: `task-{timestamp}` or similar

**`thread_owner`** (string)
- Which repo agent is responsible for completion
- Values: "backend-agent", "mobile-agent", "website-agent"

**`participants`** (array of strings)
- All repo agents involved in this task
- Does NOT include PM, Triage, or Memory agents (they're system-level)

**`slack_threads`** (array of objects)
- All Slack threads associated with this task
- Multiple threads can join same task
- Each tracks `last_processed_ts` for deduplication

**`agent_sessions`** (object)
- Maps agent name to Claude SDK session ID
- Used for resuming agents after restart
- PM always present, repo agents as needed

**`repositories`** (object)
- Maps repo name to worktree info
- Only repos involved in this task

**`status`** (string)
- `in_progress`: Active in memory
- `stopped`: Idle, resumable
- `completed`: Done

**`created_at`, `updated_at`** (ISO 8601 timestamps)
- Task lifecycle tracking

## Shared Knowledge Log

**`sessions/task-456/shared-knowledge.log`**

Append-only chronological log capturing all task activity:
- User messages from Slack
- Agent findings (discoveries, decisions, completions, blockers)

### Log Format

```
[timestamp] [source] [type] message
```

**Source formats:**
- `[slack:thread_id]` for user messages
- `[user:slack_name]` for user identification
- `[agent-name]` for agent entries

**Type (agent entries only):**
- `[discovery]` - Important findings
- `[decision]` - Agreements reached
- `[completion]` - Work finished
- `[blocker]` - Agent stuck

### Example Log

```
[2024-01-15T10:00:00Z] [slack:1234567890.123456] [user:john.smith] Fix the login timeout issue
[2024-01-15T10:05:23Z] [backend-agent] [discovery] Investigating auth timeout in backend repository
[2024-01-15T10:15:45Z] [slack:1234567890.123456] [user:john.smith] It only happens on iOS btw
[2024-01-15T10:16:12Z] [mobile-agent] [discovery] Checking iOS-specific authentication code
[2024-01-15T10:25:30Z] [backend-agent] [discovery] Root cause: race condition in auth/login.ts:234
[2024-01-15T10:30:00Z] [backend-agent] [decision] Adding retry_after field to 401 responses
[2024-01-15T10:31:15Z] [mobile-agent] [decision] Implementing exponential backoff (max 3 retries)
[2024-01-15T11:00:00Z] [slack:1234567890.789012] [user:jane.doe] Also seeing this on Android now
[2024-01-15T11:05:00Z] [mobile-agent] [discovery] Android affected too, same root cause
[2024-01-15T14:00:00Z] [backend-agent] [completion] Backend fix committed: abc123
[2024-01-15T14:05:00Z] [mobile-agent] [completion] Mobile fix committed: def456
```

### Log Benefits

- **Chronological**: Preserves natural flow of conversation
- **Multi-threaded**: Thread IDs show which Slack thread
- **Append-only**: Simple, no overwrites
- **Searchable**: grep-friendly format
- **Complete context**: Agents load full log to understand task

## Task Summary

**`sessions/task-456/memory/summary.md`**

Single evolving file that serves different purposes based on task status.

### While In Progress

Memory Agent updates after each work cycle:

```markdown
---
task_id: task-456
status: in_progress
keywords: [authentication, timeout, 401, retry, mobile, backend]
---

# Task-456: Authentication Timeout Investigation
**Last Updated:** 2024-01-15T11:30:00Z

## Current Status
Backend and Mobile agents investigating auth timeout. Root cause identified as race condition.

## Key Findings
- Race condition in auth/login.ts:234
- Mobile doesn't retry on 401, just shows error

## Decisions Made
- Backend: Adding retry_after to 401 responses
- Mobile: Implementing exponential backoff (3 retries max)

## Next Steps
- Backend: Commit fix
- Mobile: Implement retry logic
```

### When Completed

Memory Agent generates final summary:

```markdown
---
task_id: task-456
status: completed
summary: Fixed authentication timeout issue
participants: [backend-agent, mobile-agent]
outcome: success
duration: 3.5 hours
related_files: [auth/login.ts, mobile/AuthService.tsx]
keywords: [authentication, timeout, 401, retry, mobile, backend]
---

# Task-456: Authentication Timeout Fix
**Completed:** 2024-01-15T14:00:00Z

## Problem
Users experiencing authentication timeouts in production.

## Solution
- Backend: Added retry_after field to 401 responses
- Mobile: Implemented exponential backoff retry logic (max 3 attempts)

## Impact
- Reduced auth timeout errors by 95%
- Improved user experience during network issues

## Key Learnings
- Always implement retry logic for auth endpoints
- Mobile and Backend must coordinate on error format

## References
- Backend commit: abc123
- Mobile commit: def456
- Related: task-389 (original auth implementation)
```

## Workspace Context

**`memory/workspace-context.md`**

Single lightweight file loaded into all agent contexts. Contains team-wide preferences and patterns.

### Format

```markdown
---
last_updated: 2024-01-15T14:00:00Z
---

# Workspace Context

## Coding Preferences
- **Language**: TypeScript preferred over JavaScript
- **Testing**: Comprehensive test coverage required
- **Style**: Functional patterns, strong typing
- **Commits**: Detailed messages with context and reasoning

## Current Focus
- Authentication system improvements
- Mobile app performance optimization
- Biometric login rollout (in progress)

## Team Notes
- Security-first approach for auth changes
- Mobile and backend must stay coordinated on API changes
- PRs require thorough descriptions
```

### Guidelines

**Keep it concise:**
- Only essential information agents need
- Focus on preferences that affect decisions
- Recent high-level context (not detailed history)
- Small enough to load into every agent's context

**What to include:**
- Team coding preferences
- Commit message style
- Recent company/project focus areas
- Active initiatives
- Key people and their preferences (only if relevant to agent decisions)

**What to exclude:**
- Detailed project history
- Individual user preferences (unless team-wide)
- Implementation details
- Verbose documentation

## Slack Message Deduplication

Track per-thread what's already processed using `last_processed_ts`.

### Algorithm

**Existing tracked thread:**
1. Fetch Slack messages after `last_processed_ts`
2. Append to shared-knowledge.log
3. Update `last_processed_ts` in metadata

**New thread joining task:**
1. Fetch entire thread history
2. Append to shared-knowledge.log
3. Add thread to `slack_threads` array in metadata
4. Set `last_processed_ts` to latest message

### Examples

**Example 1: New message in tracked thread**

```
metadata.json:
  slack_threads: [
    {thread_id: "1234.567", last_processed_ts: "1234.580"}
  ]

New message at ts: "1234.590"

Action:
1. Fetch messages > "1234.580" → finds message at "1234.590"
2. Append to shared-knowledge.log
3. Update last_processed_ts to "1234.590"
```

**Example 2: New thread joins task**

```
User mentions task-456 in different thread: "9876.543"

Action:
1. Triage identifies existing task
2. Fetch all messages in thread "9876.543"
3. Append to shared-knowledge.log with [slack:9876.543] tags
4. Add to metadata.slack_threads:
   {thread_id: "9876.543", last_processed_ts: "9876.555"}
```

## State Recovery

### Server Restart Recovery

When server restarts while tasks are in progress:

**On startup:**

```
1. Scan sessions/ directory
2. Find all tasks with status: "in_progress"
3. For each:
   - Load metadata.json
   - Load agent_sessions map
   - Create new TaskRuntime in memory
   - Create new message queues
   - Create new async generators
   - Resume agents: query({prompt: agentInput(queue), options: {resume: sessionId}})
   - SDK restores full agent state
   - Send "Continue" message to PM agent
   - Capture QueryObject references
```

**What's preserved:**
- Agent conversation history (via SDK session)
- All files read by agents
- Tool calls made
- Task metadata
- Git worktrees

**What's recreated:**
- In-memory TaskRuntime
- Message queues
- Async generators
- QueryObject references

### Recovery Scenarios

**Scenario 1: Server crash mid-response**
- SDK session preserved in files
- Resume session on restart
- Agent picks up from last completed turn
- No lost context

**Scenario 2: New message during downtime**
- Check `last_processed_ts` for each thread
- Fetch all messages after that timestamp
- Append to shared-knowledge.log
- Resume agents with new context
- Continue normally

**Scenario 3: Multiple threads active**
- Each thread tracked independently with `last_processed_ts`
- No duplicate messages in shared-knowledge.log
- Clean chronological order maintained

## Task Lifecycle

### 1. Task Creation (new_task)

**Triggered by:** Triage returns `{action: "new_task"}`

**System actions:**

```typescript
1. Generate task_id
2. Create sessions/task-{id}/ directory
3. Create metadata.json with:
   - status: "in_progress"
   - slack_threads: [initial thread]
   - agent_sessions: {} (empty, will populate as agents start)
   - repositories: {} (empty, will populate as worktrees created)
4. Fetch Slack thread history
5. Append all messages to shared-knowledge.log
6. Create git worktrees for relevant repos
7. Update metadata.repositories with worktree info
8. Create TaskRuntime in memory
9. Spawn PM agent, capture session ID
10. Update metadata.agent_sessions["pm-agent"]
11. Send initial message to PM: "New task created, assign owner"
```

### 2. Task Active (in_progress)

**Characteristics:**
- Present in activeTasks Map
- Agents running with streaming input
- Receiving messages in real-time
- Git worktrees active
- Metadata on disk + runtime state in memory

**Updates:**
- Append to shared-knowledge.log
- Update metadata when:
  - New threads join
  - New agents spawn
  - Status changes

### 3. Task Stopped (stopped)

**Triggered by:**
- User cancels (Triage returns `{action: "cancel_task"}`)
- Timeout with no response
- System shutdown

**System actions:**

```typescript
1. Call queue.stop() on all agents
2. Call queryObject.interrupt() on all agents
3. Wait for agents to stop
4. Memory Agent generates summary
5. Remove from activeTasks Map
6. Set metadata.status = "stopped"
7. Keep worktrees (frozen state)
8. Keep session folder
```

**Can be resumed later.**

### 4. Task Completed (completed)

**Triggered by:** Thread owner calls `report_completion(summary)`

**System actions:**

```typescript
1. Detect report_completion() call
2. Trigger PM Agent: "Thread owner reports complete"
3. PM reads shared-knowledge.log
4. PM calls post_to_slack(summary)
5. System posts to all Slack threads
6. Memory Agent generates final summary
7. Remove from activeTasks Map
8. Set metadata.status = "completed"
9. Keep worktrees (frozen state)
10. Keep session folder
```

**Cannot be resumed (task is done).**

## File Operations

### Reading

Agents use standard SDK `read_file` tool:
- Paths are relative to task session root
- Or absolute within their worktree

### Writing

Agents use standard SDK file tools:
- `write_file` for creating/overwriting
- `append_to_file` for shared-knowledge.log (via `log_finding` MCP tool)

### Isolation

- Each task's files isolated in sessions/task-{id}/
- Git worktrees provide repo isolation
- No cross-task contamination

## Cleanup Policy

### Worktrees

**Manual cleanup only.** Never auto-cleanup.

**Reasoning:**
- Tasks might need to be resumed
- Historical reference for debugging
- Disk space is cheap
- No risk of data loss

**Manual cleanup command (future):**
```bash
# Admin command to cleanup old worktrees
./cleanup-worktrees --older-than 30d --status completed
```

### Session Folders

**Never auto-cleanup.**

**Reasoning:**
- Complete historical record
- Useful for training/learning
- Triage searches old tasks for similarity

**Archive strategy (future):**
```bash
# Move old completed tasks to archive
./archive-sessions --older-than 90d --status completed
```

### In-Memory State

**Cleanup immediately when:**
- Task status changes to "stopped"
- Task status changes to "completed"
- Server shuts down gracefully

**Why:**
- Free memory for active tasks
- No stale state
- Clean restarts

## Open Questions

1. **Direct message storage:** Do we need to persist `send_message_to_agent` conversations or rely on SDK session state?
   - Current: Rely on SDK session state
   - Consider: Explicit logging for visibility?

2. **Multi-user coordination:** If multiple users @mention about same issue in different threads, how to merge contexts?
   - Current: Triage asks user, or joins threads to same task
   - Consider: Auto-merge if high confidence?

3. **Workspace context updates:** When/how often should Memory Agent update workspace-context.md?
   - Current: After every task or only when patterns emerge?
   - Consider: Weekly batch updates?

---

**Related Documentation:**
- [Architecture Overview](architecture-overview.md) - High-level system description
- [System Orchestration](system-orchestration.md) - Backend implementation
- [Agent Architecture](agent-architecture.md) - Agent specifications and behavior
- [Slack Integration](slack-integration.md) - UX layer implementation
