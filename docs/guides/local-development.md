# Local Development Guide

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env
# Edit .env with your API keys
# Set ARCHIE_PLUGINS to your plugins repo git URL

# 3. Start server (plugins and repos are auto-cloned on first run)
npm run dev

# 4. Expose with ngrok (separate terminal)
ngrok http 3000

# 5. Update Slack Event URL with ngrok URL
# https://api.slack.com/apps → Event Subscriptions → https://YOUR-URL.ngrok.io/slack/events

# 6. Test in Slack: @Archie investigate login timeout
```

## Prerequisites

- Node.js 20+
- Git
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com/settings/keys))
- Slack workspace with bot configured

**Optional:**
- ngrok (required for Slack webhooks to reach localhost)
- GitHub App credentials (for PR management features)

## Working Directory

All runtime state lives under `ARCHIE_WORKDIR` (default: `./workdir`). On startup, the app:

1. Clones/pulls the plugins repo from `ARCHIE_PLUGINS` into `{WORKDIR}/plugins/`
2. Reads `repo-config.json` from each plugin to discover required repos
3. Clones/fetches each required repo into `{WORKDIR}/repos/`
4. Creates `{WORKDIR}/sessions/` for task data

Everything is automatic — just set `ARCHIE_PLUGINS` in your `.env` and run.

**For plugin development** (editing plugins locally instead of pulling from git):
```bash
mkdir -p workdir
git clone git@github.com:sweatco/archie-plugins.git workdir/plugins
# Don't set ARCHIE_PLUGINS in .env — the app will use the local directory
```

## Slack Bot Setup

Use the app manifest at [`slack-manifest.yaml`](../../slack-manifest.yaml):

1. Go to https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. Choose your workspace, select YAML, paste the manifest contents
3. Click **Create**, then **Install to Workspace**
4. Collect credentials:
   - **Bot Token** (OAuth & Permissions): `xoxb-...`
   - **Signing Secret** (Basic Information → App Credentials)

The bot needs these permissions:
- `app_mentions:read` — receive @mentions
- `chat:write` — post messages to threads
- `channels:history` — read thread history
- `users:read` — get user names

## Environment Variables

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...           # Claude API key
SLACK_BOT_TOKEN=xoxb-...              # Slack bot token
SLACK_SIGNING_SECRET=...              # Slack webhook verification

# Optional - GitHub App
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=...                # GitHub App private key (PEM)
GITHUB_INSTALLATION_ID=...
GITHUB_WEBHOOK_SECRET=...             # GitHub webhook verification

# Optional - Paths
ARCHIE_WORKDIR=./workdir              # Working directory (default: ./workdir)
ARCHIE_PLUGINS=https://github.com/... # Plugins repo git URL (auto-cloned)
PORT=3000                             # Server port (default: 3000)

# Optional - Development
NODE_ENV=development
NO_COLOR=1                            # Disable colored log output
```

## ngrok Setup

For Slack webhooks to reach your local server:

```bash
# Install
brew install ngrok  # macOS

# Start tunnel (separate terminal)
ngrok http 3000
# → https://abc123.ngrok.io

# Update Slack Event URL:
# https://api.slack.com/apps → Event Subscriptions → https://abc123.ngrok.io/slack/events
```

Free ngrok URLs change on restart. Paid ngrok provides static URLs.

## Running the Server

```bash
# Development with hot reload
npm run dev

# Production build
npm run build && npm start

# Type checking
npm run typecheck
```

The server starts on `http://localhost:3000` with:
- `POST /webhooks/slack` — Slack webhooks
- `POST /webhooks/github` — GitHub webhooks
- `GET /health` — Health check (returns active task count)
- Interactive message handlers for edit mode approval buttons

## Docker Development

```bash
# Start (with hot reload)
npm run docker:dev

# Stop
npm run docker:stop
```

## Testing in Slack

1. Invite the bot to a channel: `/invite @Archie`
2. Send a test message: `@Archie hello`
3. Check server logs for the message being processed
4. The bot should respond in the thread

## Debugging

Server console output shows all activity with color-coded, semantic logging:

```
[system]  — system events (cyan)
[slack]   — Slack integration (cyan)
[server]  — server events (dim)
[agent]   — agent messages with mode indicator [agent:rw] or [agent:ro]
```

Inspect task state:
```bash
ls workdir/sessions/                                    # All tasks
cat workdir/sessions/task-*/shared/metadata.json        # Task metadata
cat workdir/sessions/task-*/shared/knowledge.log        # Activity log
```

## Directory Structure

```
archie-hq/
├── src/                  # Application source
│   ├── connectors/       # External integrations
│   │   ├── slack/        # Slack Bolt app, client, events
│   │   └── github/       # GitHub App, webhooks, merge
│   ├── agents/           # Agent spawn logic, tools, registry
│   ├── tasks/            # Task class, persistence, recovery
│   ├── system/           # Logger, plugin loader, triage, workdir
│   ├── mcp/              # Research tools pipeline
│   ├── types/            # TypeScript types
│   └── utils/            # Utilities
├── prompts/              # Agent system prompts
├── workdir/              # Runtime state (gitignored)
│   ├── plugins/          # Auto-cloned from ARCHIE_PLUGINS
│   ├── repos/            # Auto-cloned from plugin repo-config.json
│   └── sessions/         # Task persistence
└── docs/                 # Documentation
```
