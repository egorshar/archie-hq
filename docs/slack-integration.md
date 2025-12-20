# Slack Integration (UX Layer)

## Overview

The Slack Integration layer is the user-facing interface for the multi-agent system. Users interact with agents through Slack threads using @mentions, and receive natural, human-like responses.

**Key principle:** Slack is one possible UX. The architecture should support swapping to Discord, Teams, Web, CLI, or API in the future.

## Connection Methods

### Option 1: Webhooks (Recommended)

**Setup:**
- Register webhook URL with Slack
- Slack sends POST requests on events
- Near-instant message delivery
- No polling overhead

**Events to subscribe:**
- `message.channels` - Messages in channels
- `message.groups` - Messages in private channels
- `message.im` - Direct messages
- `app_mention` - @mentions of the bot

### Option 2: Polling

**Setup:**
- Periodically fetch new messages via Slack API
- `conversations.history` endpoint
- Poll every N seconds (e.g., 5-10s)

**Tradeoffs:**
- Simpler setup (no public webhook URL)
- Higher latency
- More API calls (costs)

**Recommendation:** Start with polling for simplicity, migrate to webhooks for production.

## User Interaction Patterns

### 1. Start New Task

**User action:** @mentions bot in Slack thread

```
User in #engineering:
"@ai-engineer Fix the login timeout issue"
```

**System flow:**
1. Receive message via webhook/poll
2. Invoke Triage Agent
3. Triage returns `{action: "new_task"}`
4. System creates task session
5. System posts acknowledgment: "Looking into this"
6. PM Agent analyzes and assigns work
7. Thread owner starts investigation

**User sees:**
```
AI Engineer [bot]:
Looking into this
```

### 2. Continue Existing Task (Same Thread)

**User action:** Adds more context in same thread

```
User in #engineering (same thread as above):
"It only happens on iOS btw"
```

**System flow:**
1. Receive message
2. Invoke Triage Agent
3. Triage checks thread_id in metadata → finds task-456
4. Triage returns `{action: "existing_task", task_id: "task-456"}`
5. System appends to shared-knowledge.log
6. System notifies PM Agent: "New user input"
7. PM decides if task owner needs context
8. If yes, PM sends message to task owner

**User sees:** No immediate response unless agents have questions

### 3. Continue Existing Task (Different Thread)

**User action:** Mentions task in different Slack thread

```
User in #support:
"@ai-engineer Same auth issue happening on Android now"
```

**System flow:**
1. Receive message
2. Invoke Triage Agent
3. Triage searches keywords: finds task-456 (high similarity)
4. Triage returns `{action: "existing_task", task_id: "task-456"}`
5. System adds thread to task-456 metadata
6. System fetches thread history
7. System appends to shared-knowledge.log
8. System notifies PM Agent: "New user input from different thread"

**User sees:**
```
AI Engineer [bot]:
Got it, I've linked this to the ongoing auth investigation
```

### 4. Request Status

**User action:** Asks for status update

```
User in #engineering:
"@ai-engineer What's the status on the auth fix?"
```

**System flow:**
1. Receive message
2. Invoke Triage Agent
3. Triage classifies as `{action: "status_request", task_id: "task-456"}`
4. System triggers PM Agent: "User wants status"
5. PM reads shared-knowledge.log and summary
6. PM calls `post_to_slack("status update")`
7. System posts to Slack

**User sees:**
```
AI Engineer [bot]:
Backend and Mobile teams have identified a race condition in the auth flow. They're implementing retry logic now. Should be wrapped up soon.
```

### 5. Cancel Task

**User action:** Stops ongoing work

```
User in #engineering:
"@ai-engineer Cancel this, we're going a different direction"
```

**System flow:**
1. Receive message
2. Invoke Triage Agent
3. Triage classifies as `{action: "cancel_task", task_id: "task-456"}`
4. System interrupts all agents (queue.stop(), query.interrupt())
5. System removes from activeTasks
6. System sets status = "stopped"
7. Memory Agent generates summary of work so far
8. System posts to Slack

**User sees:**
```
AI Engineer [bot]:
Work stopped. Here's what was completed:
- Identified root cause (race condition in auth/login.ts)
- Backend added retry_after field
- Mobile partially implemented retry logic

All work is saved and can be resumed if needed.
```

## Message Format

### User to System

System receives Slack message objects:

```json
{
  "type": "message",
  "channel": "C1234567890",
  "user": "U9876543210",
  "text": "@ai-engineer Fix the login timeout issue",
  "ts": "1234567890.123456",
  "thread_ts": "1234567890.123456"  // present if in thread
}
```

**Key fields:**
- `text`: Message content
- `ts`: Message timestamp (unique ID)
- `thread_ts`: Thread ID (same for all messages in thread)
- `user`: Slack user ID
- `channel`: Slack channel ID

### System to User

System posts via Slack API:

```typescript
await slackClient.chat.postMessage({
  channel: metadata.slack_threads[0].channel_id,
  thread_ts: metadata.slack_threads[0].thread_id,
  text: "Looking into this"
});
```

**Posting rules:**
- Always post in thread (use `thread_ts`)
- Post to all threads if task has multiple
- Use conversational, human-like language
- Avoid verbose technical output

## Complete System Flow

Here's how a Slack message flows through the entire system:

```
1. Slack message → System
   ↓
2. System: Fetch entire thread history from Slack
   ↓
3. System → Triage Agent: classify(thread_messages, thread_id)
   ↓
4. Triage Agent:
   - greps for thread_id in sessions/*/metadata.json
   - If found: {action: "existing_task", task_id: "task-456"}
   - If not found: analyzes thread content and checks keywords against active tasks
   - Returns classification JSON to System
   ↓
4a. If action = "new_task":
    System:
    - Creates sessions/task-{id}/ folder
    - Creates metadata.json with thread info
    - Reads Slack thread history
    - Appends all messages to shared-knowledge.log
    - Creates worktrees for repos
    - Posts to Slack: "Looking into this"
    - Triggers PM Agent: "New task created, assign owner"
    ↓
    PM Agent:
    - Loads workspace-context.md
    - Analyzes task scope
    - Calls send_message_to_agent("backend-agent", "You're task owner for...")
    - Calls post_to_slack("Looking into this")
    ↓
    System → Backend Agent: deliver PM's message
    Backend Agent starts work

4b. If action = "existing_task":
    System:
    - Appends new message to task-{id}/shared-knowledge.log
    - Updates last_processed_ts
    - Triggers PM Agent: "New user input in thread X"
    ↓
    PM Agent:
    - Reads updated shared-knowledge.log
    - Decides if task owner needs to know
    - Calls send_message_to_agent("backend-agent", "New context from user...")
    ↓
    System → Backend Agent: deliver message

4c. If action = "status_request":
    System → PM Agent: "User asked for status"
    ↓
    PM Agent:
    - Reads shared-knowledge.log and memory/summary.md
    - Synthesizes status
    - Calls post_to_slack("Currently investigating...")
    ↓
    System: Posts PM's message to Slack
```

**Key Insight:** Agents use MCP tools (`post_to_slack`, `send_message_to_agent`, `log_finding`). System implements these tools and handles the actual operations. Clean separation!

## Multi-Thread Detection

Triage Agent handles linking multiple Slack threads to same task.

### Detection Logic

**1. Check if thread already tracked:**

```bash
grep '"thread_id": "1234567890.123456"' sessions/*/metadata.json
```

If found → `{action: "existing_task", task_id: "task-456"}`

**2. If thread not tracked, extract keywords from message**

**3. Search active tasks:**

```bash
# Find active tasks
grep -l '"status": "in_progress"' sessions/*/metadata.json

# Search their summaries
grep -i "authentication timeout" sessions/task-*/memory/summary.md
```

**4. Calculate similarity:**
- >80%: High match → join existing task
- 60-80%: Medium match → ask user
- <60%: Low match → search completed tasks

### Examples

**Example 1: High similarity → auto-join**

```
New message in thread "9876.543": "Auth errors on iOS"
Active task-456: Keywords [authentication, timeout, 401, mobile]
Similarity: 85%

Action: Join thread to task-456
```

**Example 2: Medium similarity → ask user**

```
New message: "Payment issue"
Active task-456: [payment, processing, bug] (70%)
Active task-457: [payment, UI, design] (65%)

Triage posts:
"This could relate to:
 1. Task-456: Payment processing bug (in progress)
 2. Task-457: Payment UI update (in progress)
 3. Start new task

Please reply with 1, 2, or 3"
```

**Example 3: Stale task → reference but create new**

```
New message: "Auth timeout happening again"
Completed task-123: [authentication, timeout] (90% similarity, 30 days old)

Action: Create new task-789
Context: "Similar issue was fixed in task-123, investigate if regression"
```

## Message Deduplication

Track what's been processed per thread using `last_processed_ts`.

### Algorithm

**Existing tracked thread:**

```typescript
const thread = metadata.slack_threads.find(t => t.thread_id === threadId);

// Fetch only new messages
const messages = await slackClient.conversations.history({
  channel: channelId,
  oldest: thread.last_processed_ts,
  inclusive: false
});

// Append to log
for (const msg of messages) {
  appendToLog(msg);
}

// Update timestamp
thread.last_processed_ts = messages[messages.length - 1].ts;
```

**New thread joining task:**

```typescript
// Fetch entire thread history
const messages = await slackClient.conversations.replies({
  channel: channelId,
  ts: threadTs
});

// Append all to log
for (const msg of messages) {
  appendToLog(msg);
}

// Add thread to metadata
metadata.slack_threads.push({
  thread_id: threadTs,
  channel_id: channelId,
  last_processed_ts: messages[messages.length - 1].ts
});
```

### Benefits

- No duplicate messages in shared-knowledge.log
- Handles server downtime gracefully
- Supports multiple threads per task
- Efficient (only fetch new messages)

## Message Flow Examples

### Flow 1: New Task Creation

```
1. User (Slack): "@ai-engineer Fix login timeout"
   ↓
2. System: Receives webhook
   ↓
3. System → Triage Agent: classify(message)
   ↓
4. Triage Agent: {action: "new_task"}
   ↓
5. System: Create task-456, fetch thread history, create worktrees
   ↓
6. System → Slack: "Looking into this"
   ↓
7. System → PM Agent: "New task, assign owner"
   ↓
8. PM Agent → System: send_message_to_agent("backend-agent", "You're task owner...")
   ↓
9. System → Backend Agent: delivers message
   ↓
10. Backend Agent: starts investigation
```

### Flow 2: Agent Asks Question (via PM)

```
1. Backend Agent → System: send_message_to_agent("pm-agent", "Should I restart the service?")
   ↓
2. System → PM Agent: delivers message
   ↓
3. PM Agent → System: post_to_slack("Quick question - should we restart the service or wait for deploy?")
   ↓
4. System → Slack: posts message
   ↓
5. User (Slack): "Wait for deploy"
   ↓
6. System: Receives, appends to log
   ↓
7. System → PM Agent: "New user input"
   ↓
8. PM Agent → System: send_message_to_agent("backend-agent", "User says wait for deploy")
   ↓
9. System → Backend Agent: delivers message
   ↓
10. Backend Agent: continues with that approach
```

### Flow 3: Task Completion

```
1. Backend Agent → System: report_completion("Fixed via retry logic")
   ↓
2. System: Detects completion
   ↓
3. System → PM Agent: "Thread owner reports complete"
   ↓
4. PM Agent: Reads shared-knowledge.log
   ↓
5. PM Agent → System: post_to_slack("The auth timeout issue is fixed...")
   ↓
6. System → Slack: posts to all threads
   ↓
7. System → Memory Agent: Generate final summary
   ↓
8. System: Set status = "completed"
```

## Edge Cases

### Case 1: User mentions in multiple threads simultaneously

**Scenario:**
```
Thread A: "@ai-engineer Fix login timeout"
Thread B: "@ai-engineer Login broken"  (30 seconds later)
```

**Handling:**
- First message creates task-456
- Second message: Triage detects high similarity
- Triage joins thread B to task-456
- Both threads tracked in metadata
- Agents see context from both threads

### Case 2: User cancels then resumes

**Scenario:**
```
User: "@ai-engineer Cancel this"
[5 hours later]
User: "@ai-engineer Actually, can you continue?"
```

**Handling:**
- Cancel: Set status = "stopped"
- Resume: Triage detects stopped task with keywords
- Triage returns `{action: "existing_task", task_id: "task-456"}`
- System resumes agents with stored session IDs
- Agents continue from where they left off

### Case 3: Multiple users in same thread

**Scenario:**
```
User A: "@ai-engineer Fix login"
User B (in thread): "This affects checkout too"
User C (in thread): "Can we prioritize?"
```

**Handling:**
- All messages appended to shared-knowledge.log
- Format: `[slack:thread_id] [user:name] message`
- Agents see full multi-user context
- PM synthesizes and responds to all concerns

### Case 4: Server downtime misses messages

**Scenario:**
- Server down for 2 hours
- User adds 5 messages to tracked thread

**Handling:**
- On restart: Check `last_processed_ts` for each thread
- Fetch all messages after that timestamp
- Append to shared-knowledge.log
- Resume agents with full context
- No messages lost

## Natural Language Guidelines

### For PM Agent

**DO:**
- Write like a human PM would
- Keep it brief and friendly
- Focus on what matters to users
- Use natural phrasing

**DON'T:**
- Verbose technical details
- SDK-style output
- Over-explain
- Use emojis excessively

**Examples:**

✅ Good:
```
"Backend and Mobile teams found a race condition in the auth flow. They're adding retry logic now. Should be wrapped up in an hour or so."
```

❌ Bad:
```
"After extensive analysis across multiple code paths, the backend-agent has identified a race condition in the authentication flow at line 234 of auth/login.ts. The mobile-agent has confirmed lack of retry logic. Both agents are now implementing fixes in their respective repositories."
```

### For Status Updates

**DO:**
- Summarize current state
- Mention blockers if any
- Give rough timeline if known

**DON'T:**
- List every step taken
- Include commit SHAs
- Overwhelm with details

**Examples:**

✅ Good:
```
"Still investigating. Found the issue is iOS-specific. Mobile team is checking platform code now."
```

❌ Bad:
```
"The backend-agent completed analysis of auth/login.ts:234-267. The mobile-agent is now examining AuthService.tsx using grep and file read operations. Three potential causes identified. Currently on cause #2."
```

## Future: Alternative UX Layers

The architecture should support swapping Slack for other interfaces.

### Discord Integration

**Changes needed:**
- Replace Slack API calls with Discord API
- Update message format parsing
- Same core architecture (Triage, System, Agents)

### Web Dashboard

**Changes needed:**
- REST or WebSocket API
- Web UI for conversations
- Same backend, different frontend

### CLI Tool

**Changes needed:**
- Terminal interface
- Local file-based sessions
- Same agent logic

### API-First

**Changes needed:**
- RESTful endpoints
- Webhooks for callbacks
- Same orchestration layer

**Key insight:** UX layer is thin wrapper around core system. Agents and orchestration remain unchanged.

## Open Questions

1. **Rate limiting:** How to handle Slack API rate limits during high activity?
   - Current: No explicit handling
   - Consider: Queue posts, batch when possible

2. **Notification preferences:** Should users be able to mute certain task types?
   - Current: All activity posts to thread
   - Consider: User preferences for notifications

3. **Thread cleanup:** Should old threads be archived automatically?
   - Current: All threads remain active
   - Consider: Auto-archive after N days of inactivity

4. **Multi-workspace:** Support for multiple Slack workspaces?
   - Current: Single workspace
   - Consider: Workspace-specific configurations

---

**Related Documentation:**
- [Architecture Overview](architecture-overview.md) - High-level system description
- [System Orchestration](system-orchestration.md) - Backend implementation
- [Agent Architecture](agent-architecture.md) - Agent specifications and behavior
- [Task Persistence](task-persistence.md) - Persistence and state details
