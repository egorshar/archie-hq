# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important

Please familiarize with the codebase. Do not solely rely on docs as these are forward-thinking documents and drafts, not actual representation of the project.

## Project Overview

Multi-agent AI software engineering system built with Claude Agent SDK. Specialized agents collaborate on tasks across multiple repositories via Slack integration.

## Technology Stack

- **Runtime**: Node.js with TypeScript
- **Agent Framework**: Claude Agent SDK (Sonnet 4.5, 1M context)
- **Integrations**: Slack API
- **Storage**: File-based sessions
- **Version Control**: Git

## Architecture Overview

Slack messages → Triage Agent → PM Agent → Specialist Agents (Backend, Mobile)

- **Triage agent** (Haiku) classifies messages: new task, existing task, status request, cancel
- **PM agent** manages tasks, assigns owners, communicates with users via Slack
- **Specialist agents** (Backend/Mobile) investigate codebases in read-only mode (Read, Glob, Grep only)
- Agents communicate via message queues and shared `shared-knowledge.log`
- `docs/` contains design specs (drafts, not implementation)

## Development Setup

No build or test commands yet - this is an early-stage architecture specification project.

## Git Workflow

When creating commits:

- **Use atomic commits**: Each commit should represent a single logical change
- **Group related changes**: If multiple files change for the same feature, commit them together
- **Clear commit messages**: Use descriptive messages that explain what changed and why
- **Exclude docs/plans**: Don't commit draft documentation or plans unless specifically requested

Example atomic commit structure:
1. Security improvements → one commit
2. New configuration system → one commit
3. Refactoring for code reuse → one commit
4. Type updates → one commit
