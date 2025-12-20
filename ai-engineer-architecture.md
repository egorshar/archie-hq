# AI Software Engineer - Multi-Agent Architecture

## Overview

A multi-agent system where specialized AI agents collaborate to handle software engineering tasks across multiple repositories. The system integrates with Slack and behaves like a human engineering team, with agents communicating directly and maintaining context through task sessions.

## Core Principles

1. **Human-like behavior**: Agents respond naturally in Slack threads, not verbosely like typical SDK output
2. **Context-aware sessions**: Each task maintains its own session with full communication history
3. **Direct agent communication**: Agents coordinate peer-to-peer without coordinator micromanagement
4. **Non-proactive**: Agents only engage when mentioned or in active threads
5. **Interruptible**: New context can be added at any time, causing agents to re-evaluate current work

## Architecture Components

### System (Orchestration Layer)

**Role:** TypeScript/Node.js service managing task lifecycle

**Responsibilities:**
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

**In-memory state (Map<task_id, TaskRuntime>):**

Each active task has:
- Message queues for each agent (PM, Backend, Mobile, Website)
- QueryObject references for interrupt capability
- Async generator controllers for each agent
- Task-level timeout timer

**Lookup flow:**
- Triage returns task_id
- System: `taskRuntime = activeTasks.get(task_id)`
- System accesses `taskRuntime.queues.backend.addMessage(...)`
- Generator yields message to running agent

**Does NOT involve agents in:**
- Task folder creation
- Worktree setup
- Metadata management
- Slack API calls

### PM Agent

**Role:** Task manager and user interface agent (separate instance per task)

**Responsibilities:**
- First agent triggered when new task created
- Analyzes task scope and assigns thread owner (Backend, Mobile, or Website)
- Uses `send_message_to_agent` to notify thread owner
- Receives completion reports from thread owner
- Reads shared-knowledge.log to understand what happened
- Uses `post_to_slack` to communicate with users (acknowledgment, status, summaries)
- Translates technical work to human-friendly messages

**Instance Model:**
- System spawns separate PM agent instance per task
- Each PM only has context for its own task
- Runs with streaming input like other agents
- Lives for duration of task

**Does NOT:**
- Create tasks or manage folders
- Continuously monitor logs
- Micromanage repo agents
- Make technical code decisions

### Repository Agents

Three specialized agents, each with 1M context window:

#### Backend Agent
- Manages backend repository
- APIs, databases, business logic, infrastructure
- Frequently coordinates with Mobile agent

#### Mobile Agent
- Manages mobile app repository (iOS/Android)
- UI/UX, deep linking, push notifications
- Frequently coordinates with Backend agent
- Occasionally with Website agent for feature launches

#### Website Agent
- Manages marketing/landing website repository
- Marketing pages, content updates, SEO, blog
- Mostly works independently
- Coordinates with others only for launches, deep links, campaigns

**Agent Characteristics:**
- No persistent code memory (reads code fresh each time with 1M context)
- Maintains session history for active tasks
- Has awareness of peer agents
- Can work in parallel on same task

## Communication Model

### Two-Channel System

#### 1. Direct Messages (`send_message_to_agent`)

**Purpose:** Private coordination, questions, discussions, negotiations

**Behavior:**
- Sending agent calls the tool (pauses while waiting for response)
- System queues message and yields it to target agent's input stream
- Target agent receives message immediately (via async generator)
- Target agent processes and responds
- System yields response back to original agent's input stream
- Creates back-and-forth conversation in real-time

**Technical pattern:**
- Each agent runs with streaming input (async generator)
- System maintains message queue per agent
- Generator yields queued messages to running agent
- Enables interruption and concurrent message delivery

**Use cases:**
- "Does mobile retry on 401 or just show error?"
- "Can you handle the new error format I'm proposing?"
- "What parameters does the deep link accept?"

**Example:**
```
Backend → Mobile: "I can fix backend, but need to know - does mobile retry on 401?"
[Backend pauses]
Mobile → Backend: "We just show error. Should I add retry?"
[Mobile pauses]
Backend → Mobile: "Yes please. I'll add retry_after field in response."
[Backend pauses]
Mobile → Backend: "Agreed. I'll implement exponential backoff up to 3 retries."
```

#### 2. Shared Knowledge Log (`log_finding`)

**Purpose:** Public record of discoveries, decisions, completions

**Behavior:**
- Agent writes and continues working (no pause)
- Append-only format
- Visible to all agents and coordinator
- Creates shared understanding and paper trail

**Use cases:**
- "Root cause identified: token validation race condition"
- "Backend fix complete: Added retry_after to 401 responses, commit abc123"
- "DECISION: 401 with retry_after = retry, expired refresh_token = force re-login"

**Entry types:**
- `discovery`: Important findings during investigation
- `decision`: Agreements reached between agents
- `completion`: Work finished, commits made
- `blocker`: Agent stuck and needs help

**Example:**
```
[10:15:45] [backend-agent] discovery: Root cause - race condition in auth/login.ts:234
[10:18:05] [backend-agent] decision: Changing error format to {code, message, retry_after}
[10:19:41] [mobile-agent] decision: ACK - will implement exponential backoff for retries
[10:21:15] [backend-agent] completion: Backend fix committed: abc123
[10:22:03] [mobile-agent] completion: Mobile fix committed: def456
```

### Why Two Channels?

**Direct messages** allow agents to:
- Hash out details privately
- Debate approaches
- Reach agreements
- Ask clarifying questions

**Shared log** provides:
- Progress visibility for coordinator
- Context for late-joining agents
- Historical record of decisions
- Clean, scannable status updates

## Memory & Triage System

### Two Haiku Sub-Agents

The system uses two lightweight Haiku agents to handle fast operations:

**Triage Agent (Haiku):**

**Role:** Lightweight message classifier

**Responsibilities:**
- Classify Slack message intent: status_request, new_task, existing_task, cancel_task
- Check if thread ID already exists in any task (handles "no @mention needed after first")
- Match keywords to find similar active/completed tasks
- Ask user for clarification when uncertain
- Returns simple JSON, no complex decisions

**When to ask user:**
- Multiple tasks could match (>2 similar)
- Similarity borderline (60-80%)
- Unclear if new task or continuation

**Does NOT know about:**
- Agent assignments or ownership
- Task orchestration
- Slack posting (except to ask clarification)

**Tools:**
- `bash` - grep for searching sessions
- `ask_user` - Post clarification question to Slack

**Returns to System:**
```json
{
  "action": "new_task" | "existing_task" | "status_request" | "cancel_task",
  "task_id": "task-456" (if existing_task or cancel_task),
  "confidence": "high" | "medium" | "low",
  "similar_tasks": ["task-123", "task-389"]
}
```

**Note on "no @mention needed":**
- If message is in a tracked thread (thread_id found in metadata), Triage returns existing_task
- Users don't need to @mention again once engaged
- Thread tracking handles this automatically

---

**Memory Agent (Haiku):**

**Role:** Task summarization and workspace context maintenance

**Responsibilities:**
- Generate task summaries after each agent work cycle completes
- Generate summary when task is stopped or completed
- Update workspace-context.md with team preferences
- Maintain concise, searchable summaries
- Does NOT do routing or intent detection

**Trigger conditions:**
- After repo agent finishes work and hands off (System detects agent completion)
- When task status changes to "stopped" or "completed"
- Periodic updates for long-running tasks (optional)

**Tools:**
- File read/write operations
- Read shared-knowledge.log
- Write/update summary files

#### Memory Structure

```
memory/
  workspace-context.md   # Single file loaded into all agent contexts
    ---
    # Team preferences
    coding_style: TypeScript preferred, comprehensive tests, functional patterns
    commit_style: Detailed messages with context

    # Recent high-level context
    recent_focus: Authentication improvements, mobile performance
    active_initiatives: Biometric login rollout, push notification overhaul

    # Key people (if relevant to agent decisions)
    # john.smith: Mobile lead, prefers security-first
    # jane.doe: Backend lead, focuses on performance
    ---

sessions/
  task-456/
    metadata.json
    shared-knowledge.log
    memory/
      summary.md    # Evolving summary (working → final)
        ---
        task_id: task-456
        status: in_progress  # or completed
        summary: Fixed authentication timeout issue
        participants: [backend-agent, mobile-agent]
        keywords: [authentication, timeout, 401, retry]
        ---
```

#### Task Memory Summary

**Single evolving summary file** that serves different purposes based on task status.

**While task is in_progress:**
- **Trigger:** After each agent response (automatic)
- **Content:** Current status, key findings, decisions, next steps
- **Purpose:** Quick recovery if task is interrupted or new thread joins

**Example (in progress):**
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

**When task completes:**
- **Trigger:** Task status changes to completed
- **Content:** Problem, solution, impact, learnings, references
- **Purpose:** Historical context for future similar tasks

**Example (completed):**
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

### Multi-Thread Task Detection

When @mention received, Triage Agent (Haiku) does fast triage:

```
1. Check if thread already tracked:
   - grep "thread_id" sessions/*/metadata.json for this thread ID
   - If found: Message belongs to existing task (already linked) → route to that task

2. If thread not tracked, extract key terms from new message

3. Search active tasks first:
   - grep -l '"status": "in_progress"' sessions/*/metadata.json
   - grep keywords in active tasks' memory/summary.md

4. Check keyword similarity:
   - >80%: High match → join existing task
   - 60-80%: Medium match → ask user
   - <60%: Low match → search completed tasks

5. If no active task match, search recent completed tasks:
   - grep keywords in completed sessions/*/memory/summary.md
   - Check if task is recent (within 7 days) or stale (>7 days)

6. Routing decision:
   - Active task + high similarity → Join existing task
   - Active task + medium similarity → Ask user
   - Stale task found → Create new task, reference old task in context
   - No match → Create new task
```

**Example 1: Join active task**
```
New mention: "Auth errors on iOS"
Active task-456: "authentication timeout login 401" (2 hours old)
Similarity: 85%

Action: Join thread to task-456
```

**Example 2: Reference stale task**
```
New mention: "Auth timeout happening again"
Completed task-123: "authentication timeout fix" (30 days old)
Similarity: 90% but task is stale

Action: Create new task-789
         Coordinator loads task-123 summary as reference
         "Similar issue was fixed in task-123, investigate if regression"
```

**Example 3: Ask user**
```
New mention: "Payment issue"
Active task-456: "payment processing bug" (similarity: 70%)
Active task-457: "payment UI update" (similarity: 65%)

Triage Agent asks user:
"This could relate to:
 1. Task-456: Payment processing bug (in progress)
 2. Task-457: Payment UI update (in progress)
 3. New task"
```

### Workspace Context Tracking

**Single lightweight context file** (`memory/workspace-context.md`) loaded into all agent contexts.

Memory Agent automatically updates with:
- Team coding preferences (TypeScript, testing standards, etc.)
- Commit message style
- Recent company/project focus areas
- Active initiatives
- Key people and their preferences (only if relevant to agent decisions)

**Keep it concise:**
- Only essential information agents need
- Focus on preferences that affect decisions
- Recent high-level context (not detailed history)
- Small enough to load into every agent's context

**Example:**
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

### System Flow

**On new Slack message:**

```
1. Slack message → System
   ↓
2. System → Triage Agent: classify(message, thread_id)
   ↓
3. Triage Agent:
   - greps for thread_id in sessions/*/metadata.json
   - If found: {action: "existing_task", task_id: "task-456"}
   - If not found: check keywords against active tasks
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
    - Calls send_message_to_agent("backend-agent", "You're thread owner for...")
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
    - Decides if thread owner needs to know
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

**Key Insight:**

Agents use MCP tools (`post_to_slack`, `send_message_to_agent`, `log_finding`). System implements these tools and handles the actual operations. Clean separation!

## Thread Owner Responsibility

The repo agent assigned by PM becomes the "thread owner":

**Responsibilities:**
- Lead the technical work for this task
- Pull in other agents as needed via `send_message_to_agent`
- Track that full task is complete (not just their piece)
- Call `report_completion(summary)` when all work done
- Ensure all sub-work is done before reporting

**Not responsible for:**
- Doing all the work themselves
- Micromanaging other agents
- Posting to Slack (PM does that)

## Session Architecture

```
sessions/
  task-456/
    metadata.json
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
        "status": "in_progress", // or "stopped", "completed"
        "created_at": "2024-01-15T10:00:00Z",
        "updated_at": "2024-01-15T11:30:00Z"
      }

    shared-knowledge.log
      # Append-only log everyone writes to

    memory/
      summary.md             # See Memory System section for detailed structure
```

## Task Assignment Strategy

### Coordinator's Decision Logic

**Website-only signals:**
- Keywords: "landing page", "homepage", "footer", "blog", "SEO", "content", "marketing"
- Pure HTML/CSS/marketing content changes
- Example: "Update pricing page", "Fix typo on about page"
- Assignment: Website agent (solo work)

**Product signals:**
- Keywords: "feature", "bug", "API", "database", "login", "payment"
- App functionality and backend logic
- Example: "Fix login timeout", "Add payment method"
- Assignment: Backend or Mobile agent (likely both)

**Cross-functional signals:**
- Keywords: "launch", "deep link", "campaign", "integration"
- Affects multiple touchpoints
- Example: "Launch Quick Pay feature", "Add partnership integration"
- Assignment: Primary agent (Mobile/Backend) + pulls in others

### Examples

| User Request | Initial Assignment | Likely Participants |
|--------------|-------------------|---------------------|
| "Fix authentication timeout" | Backend | Backend, Mobile |
| "Add dark mode to app" | Mobile | Mobile, Backend (settings API) |
| "Update team page with new hires" | Website | Website only |
| "Launch new premium feature" | Mobile | Mobile, Backend, Website |
| "Create landing page for new feature" | Website | Website, Mobile (deep link format) |
| "Fix crash on iOS" | Mobile | Mobile only |
| "Database migration for user table" | Backend | Backend only |

## Simple Timeout Protection

**System-Level 30-Minute Timer:**

System runs timer for each active task, resets on:
- Agent activity (tool calls, responses)
- New user input in Slack

If timer reaches 30 minutes:

```
System → PM Agent (for this task): "No activity for 30 min, check status"
PM Agent → Thread owner: "What's the current status?"

If thread owner responds: Timer resets, continue normally
If no response after 10 min: PM posts to Slack "Work may be stalled"
```

**Purpose:**
- Catch stuck agents
- Provide user visibility
- Non-invasive (agents don't run timers)
- Phase 1 only - keep minimal

## Use Cases (Progressive Implementation)

### Phase 1: Bug Research
- Read-only investigation
- Agents analyze code, logs, reproduce issues
- Report findings without making changes
- **Goal:** Prove multi-agent coordination works

### Phase 2: Code Research
- Understanding architecture, patterns, dependencies
- Documenting how systems work
- Finding relevant code for future changes
- **Goal:** Build confidence in code understanding

### Phase 3: Bug Fixing
- Make actual code changes
- Run tests to verify
- Commit fixes
- **Goal:** Add write operations with verification

### Phase 4: Small Improvements
- Add minor features or refactorings
- Requires judgment about scope
- May span multiple files/repos
- **Goal:** Handle bounded creative tasks

### Phase 5: Architecture Discussions
- Evaluate approaches
- Provide technical recommendations
- Consider trade-offs
- **Goal:** Support decision-making with context

## Agent System Prompts (Key Elements)

### Backend Agent
```
You are the Backend Agent, a senior Ruby on Rails engineer responsible for the backend repository.

Available peer agents:
- mobile-agent: Manages mobile app (iOS/Android)
- website-agent: Manages marketing website
- pm-agent: Task manager who assigns work and handles user communication

For this task (task-456), you are the THREAD OWNER. You are responsible for:
- Pulling in other agents when their expertise is needed
- Tracking that the complete task is done (not just your part)
- Reporting final results via report_completion()

Communication tools:
- send_message_to_agent: Send message to another agent (you pause, wait for their response)
- log_finding: Write to shared knowledge log (visible to all, you continue working)
- report_completion: Signal task is complete (triggers PM to write summary)

Use direct messages for questions and coordination.
Use shared log for discoveries, decisions, and completions.

When you need another agent's input, send them a direct message.
When you complete work, log it to shared knowledge.
When ALL work is done (including coordinated agents), call report_completion().
```

### Mobile Agent
```
You are the Mobile Agent, a senior React Native engineer with deep knowledge in Swift and Kotlin for cross-platform development, responsible for the mobile app (iOS/Android).

Available peer agents:
- backend-agent: Manages backend repository
- website-agent: Manages marketing website  
- pm-agent: Task manager who assigns work and handles user communication

For this task (task-456), you are a PARTICIPANT. Backend-agent is the thread owner.

Communication tools:
- send_message_to_agent: Send message to another agent (you pause, wait for their response)
- log_finding: Write to shared knowledge log (visible to all, you continue working)

Coordinate with backend-agent when making changes that affect APIs or data flow.
Coordinate with website-agent for deep links or feature launches.

When you complete your part, log it to shared knowledge so thread owner knows.
Thread owner will call report_completion() when all work is done.
```

### Website Agent
```
You are the Website Agent, a senior full-stack engineer with expertise in Node.js and React, responsible for the marketing/landing website.

Available peer agents:
- mobile-agent: Manages mobile app
- backend-agent: Manages backend
- pm-agent: Task manager who assigns work and handles user communication

Most of your work is independent (content updates, design changes, SEO).

You typically coordinate with other agents when:
- Creating landing pages for app features (need deep link format from mobile)
- Launching new features (ensure messaging aligns)
- Contact forms or integrations (might need backend API)

Communication tools:
- send_message_to_agent: Send message to another agent (you pause, wait for their response)
- log_finding: Write to shared knowledge log (visible to all, you continue working)

For solo work, just log your progress and completion.
For coordinated work, communicate directly with relevant agents.
```

### PM Agent
```
You are the PM Agent, managing task coordination and user communication.

Your engineering team:
- backend-agent: Senior Ruby on Rails engineer (backend repository)
- mobile-agent: Senior React Native engineer (mobile app, iOS/Android)
- website-agent: Senior full-stack engineer (marketing website, Node.js/React)

When you receive a new task:
1. Read workspace-context.md for team preferences
2. Read shared-knowledge.log to understand user's request
3. Analyze task scope and choose appropriate thread owner
4. Use send_message_to_agent to assign thread owner
5. Use post_to_slack to acknowledge: "Looking into this"

When you receive "new user input":
1. Read updated shared-knowledge.log
2. Determine if thread owner needs this context
3. If yes: send_message_to_agent to notify thread owner

When thread owner reports completion:
1. Read full shared-knowledge.log to understand what happened
2. Synthesize human-friendly summary (not verbose technical details)
3. Use post_to_slack with the summary

When asked for status (by System):
1. Read shared-knowledge.log and memory/summary.md
2. Write brief, natural status update
3. Use post_to_slack

You do NOT:
- Create tasks or folders (System does that)
- Monitor logs continuously
- Micromanage technical work
- Make code decisions

Communicate naturally in Slack, like a human PM would.
```

## Technical Implementation Notes

### Technology Stack
- **System:** TypeScript/Node.js orchestration service
- **SDK:** Claude Agent SDK
  - **Working Agents:** Sonnet 4.5 (1M context) - PM, Backend, Mobile, Website
  - **Triage Agent:** Haiku 4.5 - Message classification
  - **Memory Agent:** Haiku 4.5 - Task summarization
- **Interface:** Slack API
- **Storage:** File-based (sessions, metadata, logs)
- **Repositories:** Git worktrees per task (backend, mobile, website repos)

### Model Usage Strategy

**Haiku (Fast & Cheap):**
- **Triage Agent**: Intent detection, task routing, user clarification
- **Memory Agent**: Task summarization, workspace context updates
- Cost: ~$0.0015 per operation

**Sonnet (Smart & Capable):**
- PM Agent: Task management, assignment, user communication
- Repository agents: Engineering work, code changes, coordination
- Complex reasoning and code operations
- Cost: ~$0.009 per turn

**Estimated Costs:**
- Haiku triage: $0.0015 × 100/day = $0.15/day
- Haiku summaries: $0.0015 × 20/day = $0.03/day
- Sonnet agents: $0.009 × 50/day = $0.45/day
- **Total: ~$20/month for active usage**

### MCP Tools (Implemented by System)

**Custom MCP tools provided to agents:**

**PM Agent:**
- `send_message_to_agent(target, message)` - Assign work to repo agents
- `post_to_slack(message)` - Write messages for Slack (System posts them)
- `read_file` - Read shared-knowledge.log, workspace-context.md, memory/summary.md
- Standard SDK tools: bash, file operations

**Repository Agents (Backend, Mobile, Website):**
- `send_message_to_agent(target, message)` - Coordinate with peer agents, pause until response
- `log_finding(entry, type)` - Append to shared-knowledge.log (discovery, decision, completion, blocker)
- `report_completion(summary)` - Signal task done, triggers PM for final summary
- Standard SDK tools: bash, file operations, git (in worktree paths)

**Triage Agent:**
- `bash` - grep for searching sessions/*/metadata.json and summary.md files
- `ask_user(question, options)` - Post clarification question to Slack, wait for response

**Memory Agent:**
- `read_file` - Read shared-knowledge.log
- `write_file` - Create/update summary.md files
- `append_to_file` - Update workspace-context.md

**System implements these tools via MCP server**, handling:
- Message routing between agents
- File I/O with proper paths
- Slack API calls
- Metadata updates

### Slack Thread Integration

**Shared Knowledge Log Format:**

The shared-knowledge.log captures both user messages and agent findings in chronological order:

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

**Entry Format:**
- `[timestamp]` - ISO 8601 format
- `[slack:thread_id]` - For user messages, identifies which Slack thread
- `[user:slack_name]` or `[agent-name]` - Message source
- `[type]` - For agent entries: discovery, decision, completion, blocker
- Message content

**Message Flow (Triage → System → PM → Repo Agents):**

1. **Initial @mention in new thread:**
   - Triage Agent: Returns {action: "new_task"}
   - System: Creates task folder, metadata, worktrees, appends Slack history to shared-knowledge.log
   - System: Posts "Looking into this" to Slack
   - System → PM Agent: "New task, assign owner"
   - PM Agent: Calls send_message_to_agent("backend-agent", "You're thread owner...")
   - System → Backend Agent: delivers PM's message
   - Backend Agent: starts work

2. **New message in active thread:**
   - Triage Agent: Returns {action: "existing_task", task_id: "task-456"} or {action: "status_request"}
   - System: Appends message to shared-knowledge.log, resets timer
   - If status_request: System → PM Agent: "User wants status"
     - PM reads logs, calls post_to_slack("status update")
     - System posts to Slack
   - If existing_task: System → PM Agent: "New user input"
     - PM decides if thread owner needs it
     - PM calls send_message_to_agent if needed

3. **Thread owner completes work:**
   - Thread owner: Calls report_completion("Fixed auth timeout...")
   - System: Detects completion
   - System → PM Agent: "Thread owner reports complete"
   - PM: Reads shared-knowledge.log, calls post_to_slack with summary
   - System: Posts to all Slack threads, marks task completed

4. **User stops task:**
   - Triage Agent: Returns {action: "cancel_task", task_id: "task-456"}
   - System: Interrupts all active agent sessions (queue.stop(), query.interrupt())
   - System: Removes from activeTasks map
   - System: Sets status = "stopped", keeps worktrees
   - Memory Agent: Generates summary of work so far
   - System: Posts to Slack: "Work stopped"

**Agent Context Loading:**
- Agents receive full shared-knowledge.log (or recent tail if too large)
- Can see all user messages and agent findings chronologically
- Thread IDs show which Slack thread context came from
- Natural conversation flow preserved

### Repository Management

**Git Worktrees for Parallel Task Isolation:**

The system uses git worktrees to enable multiple tasks to work on the same repository simultaneously without conflicts.

**Structure:**

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
    metadata.json
      {
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
        }
      }
```

**Task Lifecycle:**

1. **Task Start:**
   - Fetch latest from all repos
   - Create task-specific branches from main
   - Create worktrees pointing to new branches
   - Store branch names and base SHA in metadata

2. **During Work:**
   - Agents work in their worktree paths
   - All git operations isolated to task's worktrees
   - Multiple tasks can work on same repo simultaneously
   - No conflicts between tasks

3. **Task Completion:**
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

### State Recovery

**Agent Session Management:**

System uses streaming input pattern for long-running agents:

**Per-agent setup:**
```typescript
async function* agentInput(queue) {
  while (true) {
    const msg = await queue.nextMessage(); // Waits for new messages
    yield {type: "user", message: {role: "user", content: msg}};
  }
}

query({prompt: agentInput(backendQueue), options: {maxTurns: 50}})
```

**How it works:**
- Each agent started with async generator that loops forever
- System maintains message queue per agent
- When send_message_to_agent called: System adds to queue
- When new user input: System adds to queue
- Generator yields messages as they arrive
- Agent receives them in real-time while running

**Benefits:**
- Agents stay alive, receiving messages continuously
- No need to restart/resume for each message
- True "pause and wait" behavior for send_message_to_agent
- Can interrupt via query.interrupt()

**Cancellation:**
- System calls queue.stop() → generator exits loop
- System calls queryObject.interrupt() → current execution stops
- Both needed for clean shutdown

**TaskRuntime cleanup:**

When agents stop (any reason):
- Remove from activeTasks map (frees memory)
- Set status = "stopped" in metadata.json
- Memory Agent generates summary
- Keep worktrees and session folder (frozen state)

When task completes:
- report_completion() called
- Set status = "completed"
- Keep worktrees (frozen state of completed work)
- Keep session folder for history

**Worktrees:** Never auto-cleanup, manual cleanup only. Each task keeps frozen git state.

**Session IDs:**
- Captured from init message, stored in metadata.json
- Used for recovery after server restart (restart with new generator)

**Server Restart Recovery:**

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

**Slack Message Deduplication:**

Track per-thread what's already processed using `last_processed_ts`:

- **Existing tracked thread**: Fetch only messages after `last_processed_ts`, append to log, update timestamp
- **New thread joining task**: Fetch entire thread history, append to log, add thread to metadata with timestamp

**Recovery Scenarios:**

1. **Server crash mid-response:**
   - SDK session preserved in files
   - Resume session on restart
   - Agent picks up from last completed turn

2. **New message during downtime:**
   - Check `last_processed_ts` for each thread
   - Fetch all messages after that timestamp
   - Append to shared-knowledge.log
   - Continue normally

3. **Multiple threads active:**
   - Each thread tracked independently with `last_processed_ts`
   - No duplicate messages in shared-knowledge.log
   - Clean chronological order maintained

### Agent Context Loading

**All agents working on a task receive:**
1. System prompt (role, peers, responsibilities, whether they're thread owner)
2. workspace-context.md (team preferences)
3. shared-knowledge.log (all Slack messages + agent findings)
4. Direct message conversations they're part of
5. Their SDK session state (code they've read, tools used, etc.)

**PM Agent per-task context:**
- Same as above, scoped to single task
- Does NOT have access to other tasks
- Loads fresh for each task it manages

**Repo Agents per-task context:**
- Same as above
- Git worktree path for this task
- Only their repository's code

## Scalability Considerations

### Adding New Agents

The architecture supports adding specialized agents:
- **DevOps Agent:** Deployments, monitoring, infrastructure
- **Analytics Agent:** Metrics, tracking, data analysis
- **Design Agent:** Figma to code, design system updates
- **QA Agent:** Test writing, test execution, quality checks

Each new agent:
1. Gets added to peer registry
2. Receives system prompt defining their role
3. Can communicate via same two-channel system
4. Only pulled into tasks relevant to their domain

### Cost Management

**Context Window Usage:**
- 1M context per agent allows full codebase understanding
- Agents read code fresh (no stale cache)
- Parallel execution means multiple 1M contexts running simultaneously

**Side Agent for Memory:**
- Cheaper model handles memory maintenance
- Runs asynchronously
- Reduces cost of persistent context management

**Task Session Cleanup:**
- Archive completed task sessions
- Purge old sessions after retention period
- Keep shared knowledge logs compressed

## Future Enhancements

### Potential Additions

1. **Verification Layer**
   - Automated test execution
   - PR creation and review
   - Staging deployment validation

2. **Learning System**
   - Track successful patterns
   - Build up company-specific knowledge
   - Improve task routing over time

3. **Human Escalation**
   - Clear criteria for when to ask humans
   - Smooth handoff of context
   - Resume capability after human input

4. **Multi-Task Management**
   - Priority queuing
   - Dependency tracking between tasks
   - Resource allocation (agent availability)

5. **Observability**
   - Dashboard showing active tasks
   - Agent status and utilization
   - Cost tracking per task
   - Performance metrics

## Open Questions for Implementation

1. **Direct message storage:** Do we need to persist `send_message_to_agent` conversations or rely on SDK session state?

2. **Testing:** Should agents automatically run tests before completing tasks? Which test commands per repo?

3. **Deployment:** Do agents create PRs for human review, or auto-merge for certain task types?

4. **Multi-user coordination:** If multiple users @mention about same issue in different threads, how to merge contexts?

5. **Cost protection:** Circuit breaker if single task exceeds budget threshold (e.g., $5)?

6. **Workspace context updates:** When/how often should Memory Agent update workspace-context.md? After every task or only when patterns emerge?

7. **Worktree cleanup:** Manual cleanup only. Worktrees kept as frozen state indefinitely.

---

## Summary

This architecture creates a team of specialized AI agents that:
- Collaborate like human engineers
- Communicate directly without coordinator bottleneck
- Maintain context through task sessions
- Work in parallel when possible
- Provide visibility through shared knowledge logs
- Behave naturally in Slack conversations
- Handle interruptions gracefully
- Scale to additional specialized agents

The two-channel communication model (direct messages + shared log) provides both coordination depth and visibility breadth, while the thread owner pattern ensures clear responsibility and completion tracking.
