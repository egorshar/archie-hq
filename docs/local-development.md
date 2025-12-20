# Local Development Guide

## Overview

Run the AI Engineer system locally for development and testing without deploying to GCP. Supports testing with or without Slack integration.

## Prerequisites

- Node.js 20+
- Git
- Anthropic API key

**Optional:**
- ngrok (for Slack webhook testing)
- Docker (for containerized testing)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Local Repositories

Clone repositories you want the system to access:

```bash
mkdir -p repos

# Clone as bare repositories (same as production)
git clone --bare git@github.com:sweatco/backend.git repos/backend.git
git clone --bare git@github.com:sweatco/mobile.git repos/mobile.git
git clone --bare git@github.com:sweatco/website.git repos/website.git
```

**For testing without real repos:**
```bash
# Create minimal test repositories
./scripts/create-test-repos.sh
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Optional (for Slack testing)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...

# Optional (for GitHub integration)
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./github-app-key.pem

# Local paths
REPOS_PATH=./repos
SESSIONS_PATH=./sessions
```

### 4. Run Development Server

```bash
npm run dev
```

Server starts on `http://localhost:3000`

## Development Modes

### Mode 1: CLI Testing (No Slack)

Test agents directly via HTTP API:

```bash
# Create new task
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Investigate login timeout on iOS",
    "user": "test-user"
  }'

# Response:
# {"task_id": "task-1", "status": "in_progress"}

# Check task status
curl http://localhost:3000/api/tasks/task-1

# View task log
curl http://localhost:3000/api/tasks/task-1/log

# Add message to existing task
curl -X POST http://localhost:3000/api/tasks/task-1/messages \
  -d '{"message": "Also happening on Android now"}'
```

### Mode 2: Mock Slack (Fast testing)

Use mock Slack API for testing without real Slack workspace:

```bash
# Enable mock mode
SLACK_MOCK=true npm run dev

# Simulates Slack messages
curl -X POST http://localhost:3000/test/slack-message \
  -d '{
    "text": "@ai-engineer Fix login timeout",
    "user": "U123",
    "thread_ts": "1234567890.123456"
  }'
```

Mock Slack posts responses to console instead of real Slack.

### Mode 3: Real Slack (Full integration)

Expose local server to Slack via ngrok:

```bash
# Terminal 1: Start server
npm run dev

# Terminal 2: Expose via ngrok
ngrok http 3000
# Outputs: https://abc123.ngrok.io

# Configure Slack App:
# Event Subscriptions URL: https://abc123.ngrok.io/slack/events
```

Now Slack webhooks reach your local server.

**Tip:** Use ngrok free tier for development. Pro version ($10/month) gives static URLs.

## Testing Strategies

### Unit Tests

Test individual components:

```bash
# Message queue
npm test -- message-queue.test.ts

# Task persistence
npm test -- task-manager.test.ts

# MCP tools
npm test -- mcp-tools.test.ts
```

### Integration Tests

Test agent interactions:

```bash
# Mock agents (fast)
npm test -- agents.integration.test.ts

# Real agents (uses Anthropic API, slower/costs)
ANTHROPIC_API_KEY=sk-ant-... npm test -- agents.real.test.ts
```

### End-to-End Tests

```bash
# With mock repos
npm run test:e2e

# With real repos
REPOS_PATH=/path/to/real/repos npm run test:e2e
```

### Manual Testing

```bash
# Interactive REPL for testing
npm run repl

> const task = await createTask("Fix auth timeout");
> await sendMessageToAgent(task.id, "mobile-agent", "Investigate iOS");
> const log = await readTaskLog(task.id);
> console.log(log);
```

## Mock Components

### Mock Triage Agent

```typescript
// For fast testing, skip real Haiku calls
const mockTriage = {
  classify: (message: string) => {
    if (message.includes('status')) return {action: 'status_request'};
    return {action: 'new_task'};
  }
};
```

### Mock Anthropic API

```typescript
// For testing without API costs
const mockAnthropic = {
  query: async (prompt: string) => {
    // Return canned responses based on prompt patterns
    if (prompt.includes('assign owner')) {
      return 'I assign backend-agent as task owner';
    }
  }
};
```

Enable via: `ANTHROPIC_MOCK=true npm run dev`

## Directory Structure

```
repos/              # Local git repositories (gitignored)
  backend.git/
  mobile.git/
  website.git/

sessions/           # Local task data (gitignored)
  task-1/
    metadata.json
    shared-knowledge.log
    worktrees/
      backend/
      mobile/

logs/              # Application logs (gitignored)
  system.log
  agents.log
```

## Debugging

### View Logs

```bash
# Application logs
tail -f logs/system.log

# Agent conversations
tail -f logs/agents.log

# Specific task
cat sessions/task-1/shared-knowledge.log
```

### Debug Agent Behavior

```bash
# Enable verbose logging
DEBUG=agents:* npm run dev

# Enable SDK debug mode
ANTHROPIC_LOG=debug npm run dev
```

### Inspect Task State

```bash
# View all tasks
ls sessions/

# View task metadata
cat sessions/task-1/metadata.json | jq

# View task log
cat sessions/task-1/shared-knowledge.log

# View worktree state
cd sessions/task-1/worktrees/backend
git status
```

## Hot Reload

Development server watches for changes:

```bash
npm run dev  # Uses nodemon or similar

# Edit src/agents/pm.ts
# Server auto-restarts
# Active tasks preserved (sessions on disk)
```

## Common Development Tasks

### Reset Everything

```bash
# Clear all tasks and state
rm -rf sessions/*
npm run dev
```

### Test Specific Agent

```bash
# Run single agent in isolation
npm run agent:test -- --agent=backend --prompt="Investigate auth timeout"
```

### Simulate Multi-Agent Flow

```bash
# Script to test full flow
npm run simulate -- scenarios/auth-timeout.json
```

## Tips

**Fast iteration:**
- Use mock mode for rapid testing
- Use real agents for behavior validation
- Keep test repos small (faster to read)

**Cost optimization:**
- Mock Anthropic API for unit tests
- Use Haiku for testing (cheaper than Sonnet)
- Limit context size during development

**Debugging stuck agents:**
- Check logs/agents.log for errors
- Inspect TaskRuntime state (add debug endpoint)
- Check message queues aren't blocked

## Environment Variables Reference

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...           # Claude SDK

# Local paths
REPOS_PATH=./repos                     # Git repositories
SESSIONS_PATH=./sessions               # Task persistence
LOG_PATH=./logs                        # Application logs

# Slack (optional)
SLACK_BOT_TOKEN=xoxb-...              # Slack integration
SLACK_SIGNING_SECRET=...              # Webhook verification
SLACK_MOCK=false                      # Use mock Slack API

# GitHub (optional)
GITHUB_APP_ID=123456                  # GitHub App ID
GITHUB_APP_PRIVATE_KEY_PATH=...       # Path to private key

# Development
NODE_ENV=development                   # Environment
PORT=3000                             # Server port
DEBUG=agents:*                        # Debug namespaces
ANTHROPIC_LOG=debug                   # SDK debug mode
ANTHROPIC_MOCK=false                  # Use mock API
```

## Next Steps

Once local development is working:
1. Test with real codebases
2. Iterate on agent prompts
3. Refine task assignment logic
4. Deploy to staging (GCP VM)
5. Deploy to production

---

**Related Documentation:**
- [MVP v1 Plan](../plans/mvp-v1.md) - Implementation timeline
- [Deployment & Operations](deployment-operations.md) - Production deployment
- [Architecture Overview](architecture-overview.md) - System design
