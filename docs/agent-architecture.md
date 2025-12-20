# Agent Layer

## Overview

The Agent layer consists of six specialized AI agents built with Claude SDK. They handle all intelligence, coordination, and decision-making while the System layer manages orchestration.

**Working Agents (Sonnet 4.5, 1M context):**
- PM Agent - Task coordination and user communication
- Backend Agent - Ruby on Rails engineering
- Mobile Agent - React Native/Swift/Kotlin engineering
- Website Agent - Node.js/React engineering

**Utility Agents (Haiku 4.5, fast & cheap):**
- Triage Agent - Message classification
- Memory Agent - Task summarization

## Agent Characteristics

All working agents share these properties:

- **No persistent code memory**: Read code fresh each time with 1M context
- **Maintain session history**: For active tasks
- **Awareness of peer agents**: Know who to coordinate with
- **Can work in parallel**: On same task when appropriate
- **Streaming input**: Receive messages via async generator queues
- **Interruptible**: Via System's query.interrupt()

## Communication Model

### Two-Channel System

Agents use two distinct communication channels, each optimized for different purposes.

#### Channel 1: Direct Messages (`send_message_to_agent`)

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

#### Channel 2: Shared Knowledge Log (`log_finding`)

**Purpose:** Public record of discoveries, decisions, completions

**Behavior:**
- Agent writes and continues working (no pause)
- Append-only format
- Visible to all agents and PM
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
- Progress visibility for PM
- Context for late-joining agents
- Historical record of decisions
- Clean, scannable status updates

## Thread Owner Pattern

The repo agent assigned by PM becomes the "task owner" for that task.

**Thread Owner Responsibilities:**
- Lead the technical work for this task
- Pull in other agents as needed via `send_message_to_agent`
- Track that full task is complete (not just their piece)
- Call `report_completion(summary)` when all work done
- Ensure all sub-work is done before reporting

**Not responsible for:**
- Doing all the work themselves
- Micromanaging other agents
- Posting to Slack (PM does that)

**Example:**

```
PM → Backend: "You're task owner for auth timeout issue"
Backend investigates, discovers mobile also affected
Backend → Mobile: "I found race condition, does mobile retry on 401?"
Mobile → Backend: "No retry, just show error"
Backend → Mobile: "Can you add retry? I'll add retry_after field"
Mobile → Backend: "Yes, implementing exponential backoff"
[Both agents work]
Backend logs: "Backend fix committed: abc123"
Mobile logs: "Mobile fix committed: def456"
Backend calls: report_completion("Fixed auth timeout via retry logic")
```

---

## PM Agent

**Role:** Task manager and user interface agent (separate instance per task)

**Technical Expertise:** Task coordination, not code implementation

**Responsibilities:**
- First agent triggered when new task created
- Analyzes task scope and assigns task owner (Backend, Mobile, or Website)
- Uses `send_message_to_agent` to notify task owner
- Receives completion reports from task owner
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

**Available Tools:**
- `send_message_to_agent(target, message)` - Assign work to repo agents
- `post_to_slack(message)` - Write messages for Slack (System posts them)
- `read_file` - Read shared-knowledge.log, workspace-context.md, memory/summary.md
- Standard SDK tools: bash, file operations

### Task Assignment Strategy

PM Agent uses these guidelines to assign task owners:

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

**Examples:**

| User Request | Initial Assignment | Likely Participants |
|--------------|-------------------|---------------------|
| "Fix authentication timeout" | Backend | Backend, Mobile |
| "Add dark mode to app" | Mobile | Mobile, Backend (settings API) |
| "Update team page with new hires" | Website | Website only |
| "Launch new premium feature" | Mobile | Mobile, Backend, Website |
| "Create landing page for new feature" | Website | Website, Mobile (deep link format) |
| "Fix crash on iOS" | Mobile | Mobile only |
| "Database migration for user table" | Backend | Backend only |

### System Prompt

```
You are the PM Agent, managing task coordination and user communication.

Your engineering team:
- backend-agent: Senior Ruby on Rails engineer (backend repository)
- mobile-agent: Senior React Native engineer (mobile app, iOS/Android)
- website-agent: Senior full-stack engineer (marketing website, Node.js/React)

When you receive a new task:
1. Read workspace-context.md for team preferences
2. Read shared-knowledge.log to understand user's request
3. Analyze task scope and choose appropriate task owner
4. Use send_message_to_agent to assign task owner
5. Use post_to_slack to acknowledge: "Looking into this"

When you receive "new user input":
1. Read updated shared-knowledge.log
2. Determine if task owner needs this context
3. If yes: send_message_to_agent to notify task owner

When task owner reports completion:
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

---

## Backend Agent

**Role:** Senior Ruby on Rails engineer responsible for backend repository

**Technical Expertise:**
- APIs, databases, business logic, infrastructure
- Ruby on Rails best practices
- Database migrations and optimization
- Authentication and authorization
- Background jobs and queues

**Repositories:** backend (Rails monolith)

**Frequently coordinates with:**
- Mobile Agent (API contracts, error handling)
- Occasionally Website Agent (API integrations)

**Available Tools:**
- `send_message_to_agent(target, message)` - Coordinate with peer agents
- `log_finding(entry, type)` - Write to shared knowledge log
- `report_completion(summary)` - Signal task complete
- Standard SDK tools: bash, file operations, git (in worktree paths)

### System Prompt (Thread Owner Example)

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

### System Prompt (Participant Example)

```
You are the Backend Agent, a senior Ruby on Rails engineer responsible for the backend repository.

Available peer agents:
- mobile-agent: Manages mobile app (iOS/Android)
- website-agent: Manages marketing website
- pm-agent: Task manager who assigns work and handles user communication

For this task (task-456), you are a PARTICIPANT. Mobile-agent is the task owner.

Communication tools:
- send_message_to_agent: Send message to another agent (you pause, wait for their response)
- log_finding: Write to shared knowledge log (visible to all, you continue working)

Coordinate with task owner and other agents as needed.

When you complete your part, log it to shared knowledge so task owner knows.
Thread owner will call report_completion() when all work is done.
```

---

## Mobile Agent

**Role:** Senior React Native engineer with deep knowledge in Swift and Kotlin for cross-platform development, responsible for mobile app (iOS/Android)

**Technical Expertise:**
- React Native, Swift, Kotlin
- iOS and Android platform specifics
- Mobile UI/UX patterns
- Deep linking and push notifications
- App store deployment
- Mobile performance optimization

**Repositories:** mobile (React Native + native modules)

**Frequently coordinates with:**
- Backend Agent (API contracts, error handling)
- Occasionally Website Agent (deep links, feature launches)

**Available Tools:**
- `send_message_to_agent(target, message)` - Coordinate with peer agents
- `log_finding(entry, type)` - Write to shared knowledge log
- `report_completion(summary)` - Signal task complete (if task owner)
- Standard SDK tools: bash, file operations, git (in worktree paths)

### System Prompt

```
You are the Mobile Agent, a senior React Native engineer with deep knowledge in Swift and Kotlin for cross-platform development, responsible for the mobile app (iOS/Android).

Available peer agents:
- backend-agent: Manages backend repository
- website-agent: Manages marketing website
- pm-agent: Task manager who assigns work and handles user communication

For this task (task-456), you are a PARTICIPANT. Backend-agent is the task owner.

Communication tools:
- send_message_to_agent: Send message to another agent (you pause, wait for their response)
- log_finding: Write to shared knowledge log (visible to all, you continue working)

Coordinate with backend-agent when making changes that affect APIs or data flow.
Coordinate with website-agent for deep links or feature launches.

When you complete your part, log it to shared knowledge so task owner knows.
Thread owner will call report_completion() when all work is done.
```

---

## Website Agent

**Role:** Senior full-stack engineer with expertise in Node.js and React, responsible for marketing/landing website

**Technical Expertise:**
- Node.js and React
- Marketing pages and content
- SEO optimization
- Web performance
- Contact forms and integrations

**Repositories:** website (Next.js or similar)

**Mostly works independently on:**
- Content updates
- Design changes
- SEO improvements
- Blog posts

**Coordinates with other agents when:**
- Creating landing pages for app features (need deep link format from mobile)
- Launching new features (ensure messaging aligns)
- Contact forms or integrations (might need backend API)

**Available Tools:**
- `send_message_to_agent(target, message)` - Coordinate with peer agents
- `log_finding(entry, type)` - Write to shared knowledge log
- `report_completion(summary)` - Signal task complete (if task owner)
- Standard SDK tools: bash, file operations, git (in worktree paths)

### System Prompt

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

---

## Triage Agent

**Role:** Lightweight message classifier (Haiku model)

**Purpose:** Fast, cheap classification of incoming Slack messages

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
- Technical details

**Available Tools:**
- `bash` - grep for searching sessions/*/metadata.json and summary.md files
- `ask_user(question, options)` - Post clarification question to Slack, wait for response

**Returns to System:**

```json
{
  "action": "new_task" | "existing_task" | "status_request" | "cancel_task",
  "task_id": "task-456",  // if existing_task or cancel_task
  "confidence": "high" | "medium" | "low",
  "similar_tasks": ["task-123", "task-389"]
}
```

**Note on "no @mention needed":**
- If message is in a tracked thread (thread_id found in metadata), Triage returns existing_task
- Users don't need to @mention again once engaged
- Thread tracking handles this automatically

### Classification Logic

**1. Check if thread already tracked:**
```bash
grep "thread_id" sessions/*/metadata.json
```
If found → `{action: "existing_task", task_id: "task-456"}`

**2. If thread not tracked, extract key terms from message**

**3. Search active tasks first:**
```bash
grep -l '"status": "in_progress"' sessions/*/metadata.json
grep keywords sessions/task-*/memory/summary.md
```

**4. Check keyword similarity:**
- >80%: High match → join existing task
- 60-80%: Medium match → ask user
- <60%: Low match → search completed tasks

**5. If no active task match, search recent completed tasks**

**6. Routing decision:**
- Active task + high similarity → Join existing task
- Active task + medium similarity → Ask user
- Stale task found → Create new task, reference old task in context
- No match → Create new task

### Examples

**Example 1: Join active task**
```
New mention: "Auth errors on iOS"
Active task-456: "authentication timeout login 401" (2 hours old)
Similarity: 85%

Action: {action: "existing_task", task_id: "task-456"}
```

**Example 2: Reference stale task**
```
New mention: "Auth timeout happening again"
Completed task-123: "authentication timeout fix" (30 days old)
Similarity: 90% but task is stale

Action: {action: "new_task", similar_tasks: ["task-123"]}
```

**Example 3: Ask user**
```
New mention: "Payment issue"
Active task-456: "payment processing bug" (similarity: 70%)
Active task-457: "payment UI update" (similarity: 65%)

Triage Agent calls ask_user:
"This could relate to:
 1. Task-456: Payment processing bug (in progress)
 2. Task-457: Payment UI update (in progress)
 3. New task"
```

---

## Memory Agent

**Role:** Task summarization and workspace context maintenance (Haiku model)

**Purpose:** Fast, cheap summarization and context updates

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

**Available Tools:**
- `read_file` - Read shared-knowledge.log
- `write_file` - Create/update summary.md files
- `append_to_file` - Update workspace-context.md

### Summary Format (In Progress)

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

### Summary Format (Completed)

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

---

## Agent Context Loading

**All agents working on a task receive:**

1. System prompt (role, peers, responsibilities, whether they're task owner)
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

---

## Scalability: Adding New Agents

The architecture supports adding specialized agents easily:

**Example: DevOps Agent**

1. Define role and expertise
2. Write system prompt
3. Add to peer registry
4. System routes relevant tasks

```
You are the DevOps Agent, responsible for deployments, monitoring, and infrastructure.

Available peer agents:
- backend-agent, mobile-agent, website-agent
- pm-agent

You handle:
- Deployment automation
- CI/CD pipeline issues
- Infrastructure scaling
- Monitoring and alerting
- Database migrations
```

**Other potential agents:**
- Analytics Agent (metrics, tracking, data analysis)
- Design Agent (Figma to code, design system)
- QA Agent (test writing, execution, quality checks)

Each new agent:
1. Gets added to peer registry
2. Receives system prompt defining their role
3. Can communicate via same two-channel system
4. Only pulled into tasks relevant to their domain

---

**Related Documentation:**
- [Architecture Overview](architecture-overview.md) - High-level system description
- [System Orchestration](system-orchestration.md) - Backend implementation
- [Task Persistence](task-persistence.md) - Persistence and state details
- [Slack Integration](slack-integration.md) - UX layer implementation
