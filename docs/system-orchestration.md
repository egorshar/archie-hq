# System Orchestration Layer

## Overview

The System layer is a TypeScript/Node.js service that orchestrates the entire multi-agent system. It manages task lifecycle, routes messages between agents, implements MCP tools, and handles persistence.

**Key principle:** System handles all orchestration logic. Agents focus purely on their domain expertise.

## Responsibilities

The System layer is responsible for:

- Listen to Slack messages (webhooks or polling)
- Invoke Triage Agent for message classification
- Create/update task sessions (folders, metadata, worktrees)
- Append Slack messages to shared-knowledge.log
- Manage agent SDK sessions (create, resume, interrupt, disconnect)
- Trigger appropriate agents based on triage results
- Implement MCP tools (send_message_to_agent, log_finding, post_to_slack, report_completion, ask_user)
- Post agent messages to Slack when they call post_to_slack
- Run 30-min timeout timer per task (reset on agent activity or new user input)
- Detect task completion via report_completion() call, trigger PM for summary
- Handle cancellation via SDK interrupt() on active sessions
- Trigger Memory Agent after each agent work cycle completes and when tasks stop

**Does NOT involve agents in:**
- Task folder creation
- Worktree setup
- Metadata management
- Slack API calls

## In-Memory State: TaskRuntime

System maintains a Map of active tasks in memory:

```typescript
Map<task_id, TaskRuntime>

// Each TaskRuntime contains:
{
  taskId: string

  // Message queues for streaming input
  queues: {
    pm: MessageQueue
    backend: MessageQueue
    mobile: MessageQueue
    website: MessageQueue
  }

  // QueryObject references for interrupt capability
  queryObjects: {
    pm: QueryObject
    backend?: QueryObject
    mobile?: QueryObject
    website?: QueryObject
  }

  // Async generator controllers
  generators: {
    pm: AsyncGenerator
    backend?: AsyncGenerator
    mobile?: AsyncGenerator
    website?: AsyncGenerator
  }

  // Timeout management
  timer: NodeJS.Timeout
  lastActivity: Date
}
```

## Message Routing Flow

**Lookup flow:**
1. Triage Agent returns `task_id`
2. System: `taskRuntime = activeTasks.get(task_id)`
3. System determines target agent (from metadata or routing logic)
4. System: `taskRuntime.queues.backend.addMessage(...)`
5. Generator yields message to running agent
6. Agent receives message in real-time

## Agent Session Management

### Starting Agents

When a task is created or agent needs to join:

```typescript
async function* agentInput(queue: MessageQueue) {
  while (true) {
    const msg = await queue.nextMessage(); // Waits for new messages
    yield {type: "user", message: {role: "user", content: msg}};
  }
}

// Start agent with streaming input
const queryObject = await query({
  prompt: agentInput(backendQueue),
  options: {maxTurns: 50}
});

// Store for interrupt capability
taskRuntime.queryObjects.backend = queryObject;
```

**How it works:**
- Each agent started with async generator that loops forever
- System maintains message queue per agent
- When `send_message_to_agent` called: System adds to target queue
- When new user input: System adds to appropriate queue(s)
- Generator yields messages as they arrive
- Agent receives them in real-time while running

**Benefits:**
- Agents stay alive, receiving messages continuously
- No need to restart/resume for each message
- True "pause and wait" behavior for `send_message_to_agent`
- Can interrupt via `query.interrupt()`

### Interrupting Agents

**Cancellation process:**

```typescript
// Stop the generator
taskRuntime.queues.backend.stop();  // Makes nextMessage() throw/exit

// Interrupt current execution
await taskRuntime.queryObjects.backend.interrupt();

// Both needed for clean shutdown
```

### Server Restart Recovery

When server restarts mid-task:

```
1. On startup: Scan sessions/ directory
2. Find tasks with status: "in_progress"
3. For each active task:
   - Load metadata.json with agent_sessions
   - Create new message queue for each agent
   - Create new async generator (same pattern as initial start)
   - Resume each agent: query({prompt: agentInput(queue), options: {resume: sessionId, maxTurns: 50}})
   - SDK restores full agent state (conversation, files read, tool calls)
   - Send "Continue" message to PM agent via queue
   - Capture new QueryObject references for interrupt capability
   - Agents continue from where they left off
```

**Note:** Active QueryObjects and generators are lost on restart. Must recreate both by resuming sessions with new streaming input generators.

## MCP Tool Implementation

System implements custom MCP tools that agents call. Clean separation: agents use tools, System handles actual operations.

### Tools for PM Agent

**`send_message_to_agent(target: string, message: string)`**
- Assign work to repo agents
- System queues message to target agent
- Sending agent pauses until response received

**`post_to_slack(message: string)`**
- PM writes message content
- System posts to all Slack threads for this task
- User sees natural, human-friendly updates

**`read_file(path: string)`**
- Read shared-knowledge.log, workspace-context.md, memory/summary.md
- Standard SDK tool with task-scoped paths

### Tools for Repository Agents

**`send_message_to_agent(target: string, message: string)`**
- Coordinate with peer agents
- Sending agent pauses until response received
- Creates back-and-forth conversation

**`log_finding(entry: string, type: string)`**
- Append to shared-knowledge.log
- Types: discovery, decision, completion, blocker
- Agent continues working (no pause)

**`report_completion(summary: string)`**
- Signal task is complete
- System detects completion
- Triggers PM Agent for final summary

### Tools for Triage Agent

**`bash`**
- grep for searching sessions/*/metadata.json
- grep for searching summary.md files
- Fast keyword matching

**`ask_user(question: string, options: string[])`**
- Post clarification question to Slack
- Wait for user response
- Continue with user's choice

### Tools for Memory Agent

**`read_file(path: string)`**
- Read shared-knowledge.log

**`write_file(path: string, content: string)`**
- Create/update summary.md files

**`append_to_file(path: string, content: string)`**
- Update workspace-context.md

## Git Worktree Management

System manages git worktrees to enable parallel task isolation.

### Repository Structure

```
repos/
  backend.git/         # Bare repository (shared)
  mobile.git/
  website.git/

sessions/
  task-456/
    worktrees/
      backend/         # Worktree on branch task-456-auth-fix
      mobile/          # Worktree on branch task-456-auth-fix
```

### Task Lifecycle

**1. Task Start:**

```typescript
// Fetch latest from all repos
await git.fetch('repos/backend.git');

// Create task-specific branches from main
const branchName = `task-${taskId}-${slug}`;
await git.branch(branchName, 'main');

// Create worktrees pointing to new branches
await git.worktree.add(
  `sessions/task-${taskId}/worktrees/backend`,
  branchName
);

// Store in metadata
metadata.repositories = {
  backend: {
    worktree_path: `/sessions/task-${taskId}/worktrees/backend`,
    branch: branchName,
    base_branch: 'main',
    base_sha: await git.revParse('main')
  }
};
```

**2. During Work:**

- Agents work in their worktree paths
- All git operations isolated to task's worktrees
- Multiple tasks can work on same repo simultaneously
- No conflicts between tasks

**3. Task Completion:**

- Agents commit changes to task branches
- Push branches to remote
- Create pull requests (optional)
- Keep worktrees (frozen state of completed work)
- Keep branches until PRs merged

**Handling Base Branch Updates:**

When main branch is updated while task is in progress:

- Agents can check if base has moved: `git fetch && git rev-list base_sha..origin/main`
- Decision to rebase is task-specific (not automatic)
- If needed: `git rebase origin/main` in worktree
- Note in completion summary if rebase needed

**Benefits:**

- **Parallel execution**: Multiple tasks work simultaneously without conflicts
- **Efficient**: Shared git objects, no duplicate clones
- **Fast**: Worktree creation is near-instant
- **Clean**: Easy cleanup when task completes
- **Isolated**: Each task has own working directory and branch

### Worktree Cleanup Policy

**Never auto-cleanup.** Worktrees kept as frozen state indefinitely for:
- Debugging completed work
- Resuming stopped tasks
- Historical reference

Manual cleanup only via admin command.

## Task Lifecycle States

System manages three task states:

- **`in_progress`**: Task active in memory (in activeTasks Map)
- **`stopped`**: Task idle, resumable (not in memory, worktrees preserved)
- **`completed`**: Task done (not in memory, worktrees preserved)

### State Transitions

**New Task → in_progress:**
- Triage returns "new_task"
- System creates session folder, metadata, worktrees
- Spawns PM agent
- Adds to activeTasks Map

**in_progress → stopped (user cancels):**
- Triage returns "cancel_task"
- System calls queue.stop() on all agents
- System calls queryObject.interrupt() on all agents
- Remove from activeTasks Map
- Memory Agent generates summary
- Set status = "stopped" in metadata.json
- Keep worktrees

**in_progress → completed (agent reports done):**
- Thread owner calls report_completion()
- System detects completion
- PM Agent writes final summary to Slack
- Memory Agent generates final summary
- Remove from activeTasks Map
- Set status = "completed" in metadata.json
- Keep worktrees

**stopped → in_progress (user resumes):**
- User mentions task again or Triage links message to stopped task
- System loads metadata.json
- Recreate message queues and generators
- Resume agents with stored session IDs
- Add back to activeTasks Map

## TaskRuntime Cleanup

**When agents stop (any reason):**
- Remove from activeTasks Map (frees memory)
- Set status = "stopped" in metadata.json
- Memory Agent generates summary
- Keep worktrees and session folder (frozen state)

**When task completes:**
- report_completion() called
- Set status = "completed"
- Keep worktrees (frozen state of completed work)
- Keep session folder for history

## Timeout Protection

**System-Level 30-Minute Timer:**

System runs timer for each active task, resets on:
- Agent activity (tool calls, responses)
- New user input in Slack

If timer reaches 30 minutes:

```
System → PM Agent (for this task): "No activity for 30 min, check status"
PM Agent → Thread owner: "What's the current status?"

If task owner responds: Timer resets, continue normally
If no response after 10 min: PM posts to Slack "Work may be stalled"
```

**Purpose:**
- Catch stuck agents
- Provide user visibility
- Non-invasive (agents don't run timers)
- Phase 1 only - keep minimal

**Implementation:**

```typescript
function resetTimer(taskId: string) {
  const runtime = activeTasks.get(taskId);

  clearTimeout(runtime.timer);
  runtime.lastActivity = new Date();

  runtime.timer = setTimeout(() => {
    handleInactivity(taskId);
  }, 30 * 60 * 1000); // 30 minutes
}

async function handleInactivity(taskId: string) {
  const runtime = activeTasks.get(taskId);

  // Send message to PM
  runtime.queues.pm.addMessage("No activity for 30 min, check status");

  // Set another timer for 10 min
  setTimeout(() => {
    if (activeTasks.has(taskId)) {
      // Still no response, post to Slack
      slackClient.postMessage(taskId, "Work may be stalled, checking with agents...");
    }
  }, 10 * 60 * 1000);
}
```

## Task Assignment Strategy

When PM Agent needs to choose a task owner, System provides context but PM decides.

**PM's Decision Logic (guidelines in prompt):**

**Website-only signals:**
- Keywords: "landing page", "homepage", "footer", "blog", "SEO", "content", "marketing"
- Pure HTML/CSS/marketing content changes
- Assignment: Website agent (solo work)

**Product signals:**
- Keywords: "feature", "bug", "API", "database", "login", "payment"
- App functionality and backend logic
- Assignment: Backend or Mobile agent (likely both)

**Cross-functional signals:**
- Keywords: "launch", "deep link", "campaign", "integration"
- Affects multiple touchpoints
- Assignment: Primary agent (Mobile/Backend) + pulls in others

## Memory Agent Triggers

System triggers Memory Agent at specific points:

**Trigger conditions:**
1. After repo agent finishes work and hands off
   - System detects agent sent message to PM or called log_finding with type="completion"
2. When task status changes to "stopped" or "completed"
   - System changes metadata status
3. Periodic updates for long-running tasks (optional)
   - Every N agent turns or M minutes

**How it works:**

```typescript
async function triggerMemoryUpdate(taskId: string) {
  // Invoke Memory Agent with simple prompt
  const memoryAgent = await query({
    prompt: `Update summary for task ${taskId}`,
    model: 'haiku',
    // ... Memory Agent system prompt and tools
  });

  // Memory Agent reads shared-knowledge.log
  // Writes updated summary.md
  // Updates workspace-context.md if patterns emerge
}
```

## Open Questions

1. **Direct message storage:** Do we need to persist `send_message_to_agent` conversations or rely on SDK session state?

2. **Testing:** Should agents automatically run tests before completing tasks? Which test commands per repo?

3. **Deployment:** Do agents create PRs for human review, or auto-merge for certain task types?

4. **Cost protection:** Circuit breaker if single task exceeds budget threshold (e.g., $5)?

---

**Related Documentation:**
- [Architecture Overview](architecture-overview.md) - High-level system description
- [Agent Architecture](agent-architecture.md) - Agent specifications and behavior
- [Task Persistence](task-persistence.md) - Persistence and state details
- [Slack Integration](slack-integration.md) - UX layer implementation
