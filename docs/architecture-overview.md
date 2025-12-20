# AI Software Engineer - Architecture Overview

## What is This?

A multi-agent system where specialized AI agents collaborate to handle software engineering tasks across multiple repositories. The system integrates with Slack and behaves like a human engineering team, with agents communicating directly and maintaining context through task sessions.

## Core Principles

1. **Human-like behavior**: Agents respond naturally in Slack threads, not verbosely like typical SDK output
2. **Context-aware sessions**: Each task maintains its own session with full communication history
3. **Direct agent communication**: Agents coordinate peer-to-peer without coordinator micromanagement
4. **Non-proactive**: Agents only engage when mentioned or in active threads
5. **Interruptible**: New context can be added at any time, causing agents to re-evaluate current work

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Slack Integration                         │
│           (UX Layer - users interact here)                   │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  System Orchestration                        │
│  (TypeScript/Node.js - manages lifecycle, routes messages)   │
│                                                              │
│  • TaskRuntime (in-memory state per task)                   │
│  • Agent session management                                  │
│  • Git worktree management                                   │
│  • MCP tool implementation                                   │
└──────┬──────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│                        Agents                                │
│              (Claude SDK - AI intelligence)                  │
│                                                              │
│  Working Agents (Sonnet 4.5):                               │
│  • PM Agent - Task coordination & user communication         │
│  • Backend Agent - Ruby on Rails engineering                 │
│  • Mobile Agent - React Native/Swift/Kotlin engineering      │
│  • Website Agent - Node.js/React engineering                 │
│                                                              │
│  Utility Agents (Haiku 4.5):                                │
│  • Triage Agent - Message classification                     │
│  • Memory Agent - Task summarization                         │
└──────┬──────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│                   Task Persistence                           │
│         (File-based persistence & state recovery)            │
│                                                              │
│  • Task sessions (metadata, logs, summaries)                │
│  • Git worktrees per task                                    │
│  • State recovery after restarts                             │
└─────────────────────────────────────────────────────────────┘
```

## Layer Interaction Flow

**Typical task flow:**

1. **Slack**: User mentions @ai-engineer in thread
2. **System**: Receives webhook, invokes Triage Agent
3. **Triage Agent**: Classifies as new_task/existing_task/status_request
4. **System**: Creates session (new) or loads existing, spawns PM Agent
5. **PM Agent**: Analyzes task, assigns task owner (e.g., Backend Agent)
6. **Backend Agent**: Does work, coordinates with Mobile Agent if needed
7. **Agents**: Write findings to shared-knowledge.log
8. **Backend Agent**: Calls report_completion()
9. **PM Agent**: Reads log, posts summary to Slack
10. **Memory Agent**: Updates task summary
11. **System**: Marks task completed

## Technology Stack

- **System Layer**: TypeScript/Node.js orchestration service
- **Agent Framework**: Claude Agent SDK
  - Working agents: Sonnet 4.5 (1M context) - PM, Backend, Mobile, Website
  - Utility agents: Haiku 4.5 (fast & cheap) - Triage, Memory
- **UX Layer**: Slack API (webhooks/polling)
- **Storage**: File-based sessions (metadata, logs, summaries)
- **Version Control**: Git worktrees per task

## Cost Efficiency

**Haiku (Fast & Cheap):**
- Triage: Message classification (~$0.0015 per operation)
- Memory: Task summarization (~$0.0015 per operation)

**Sonnet (Smart & Capable):**
- PM: Task management (~$0.009 per turn)
- Repo agents: Engineering work (~$0.009 per turn)

**Estimated: ~$20/month for active usage**

## Key Innovations

### 1. Two-Channel Communication

**Direct messages** (`send_message_to_agent`):
- Private agent-to-agent coordination
- Sending agent pauses, waits for response
- Back-and-forth conversations

**Shared knowledge log** (`log_finding`):
- Public record of discoveries, decisions, completions
- Append-only, visible to all
- Agent continues working (no pause)

### 2. Thread Owner Pattern

One repo agent is assigned as "task owner" per task:
- Responsible for pulling in other agents as needed
- Tracks overall task completion
- Calls `report_completion()` when all work done

### 3. Streaming Input with Async Generators

Agents run with forever-looping generators:
- Messages queued and yielded to running agents
- Enables real-time message delivery
- True "pause and wait" for direct messages
- Can interrupt via `query.interrupt()`

### 4. Per-Task Agent Instances

Each task gets its own PM agent instance:
- Full context isolation between tasks
- Parallel task execution
- Clean state boundaries

### 5. Git Worktrees for Isolation

Each task works in its own worktree:
- Parallel execution without conflicts
- Shared git objects (efficient)
- Frozen state after completion

## Use Cases (Progressive Implementation)

### Phase 1: Bug Research (current focus)
- Read-only investigation
- Agents analyze code, logs, reproduce issues
- Report findings without making changes

### Phase 2: Code Research
- Understanding architecture, patterns, dependencies
- Documenting how systems work

### Phase 3: Bug Fixing
- Make actual code changes
- Run tests to verify
- Commit fixes

### Phase 4: Small Improvements
- Add minor features or refactorings
- May span multiple files/repos

### Phase 5: Architecture Discussions
- Evaluate approaches
- Provide technical recommendations
- Consider trade-offs

## Detailed Documentation

- **[System Orchestration](system-orchestration.md)** - Backend implementation, TaskRuntime, session lifecycle
- **[Agent Architecture](agent-architecture.md)** - All AI agents, communication patterns, prompts
- **[Task Persistence](task-persistence.md)** - Persistence, state recovery, metadata
- **[Slack Integration](slack-integration.md)** - UX layer, message flows, thread tracking

## Scalability

The architecture supports adding specialized agents:
- **DevOps Agent**: Deployments, monitoring, infrastructure
- **Analytics Agent**: Metrics, tracking, data analysis
- **Design Agent**: Figma to code, design system updates
- **QA Agent**: Test writing, execution, quality checks

Each new agent:
1. Gets added to peer registry
2. Receives system prompt defining their role
3. Can communicate via same two-channel system
4. Only pulled into tasks relevant to their domain

## Future Enhancements

1. **Verification Layer**: Automated test execution, PR creation/review
2. **Learning System**: Track successful patterns, improve routing
3. **Human Escalation**: Clear criteria for when to ask humans
4. **Multi-Task Management**: Priority queuing, dependency tracking
5. **Observability**: Dashboard, agent status, cost tracking
6. **Alternative UX**: Discord, Teams, Web, CLI, API

---

**Next Steps:** Read the detailed layer documentation to understand implementation specifics.
