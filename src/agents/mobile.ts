/**
 * Mobile Agent
 *
 * Senior React Native engineer with Swift and Kotlin expertise.
 * Responsible for the mobile app repository (iOS/Android).
 * Uses streaming generator for continuous message processing.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { TaskMetadata } from '../types/index.js';
import type { AgentHandle } from '../types/agent.js';
import { getTaskPath } from '../system/task-manager.js';
import { MessageQueue, createAgentInputGenerator } from '../system/message-queue.js';
import { createRepoAgentMcpServer, type ToolCallbacks } from '../mcp/tools.js';
import { logAgentToolCall } from '../system/agent-logging.js';

/**
 * Generate the system prompt for the Mobile agent
 */
function getMobileSystemPrompt(isTaskOwner: boolean): string {
  const ownerSection = isTaskOwner
    ? `You are the TASK OWNER. You are responsible for:
- Leading the technical investigation
- Pulling in other agents when their expertise is needed (use send_message_to_agent)
- Tracking that the complete task is done (not just your part)
- Logging your findings (use log_finding)
- When investigation is complete, send message to pm-agent with your findings and conclusions

IMPORTANT: After sending your final findings to pm-agent, STOP. Do not continue investigating or making additional discoveries. Wait for pm-agent to provide further instructions if needed.`
    : `You are a PARTICIPANT. Another agent is the task owner.
- Coordinate with the task owner as needed
- Log your findings using log_finding
- When done, message the task owner with your findings

IMPORTANT: After sending your findings to the task owner, STOP and wait for further instructions.`;

  return `You are the Mobile Agent, a senior React Native engineer with deep knowledge in Swift and Kotlin for cross-platform development.

Available peer agents:
- backend-agent: Manages backend repository (Ruby on Rails)
- pm-agent: Task manager who assigns work and handles user communication

${ownerSection}

Communication Tools:
- send_message_to_agent: Send a message to another agent and wait for their response. Use this for coordination and questions.
- log_finding: Write to the shared knowledge log (visible to all agents and PM). Use for discoveries, decisions, completions, blockers.

Investigation Guidelines:
1. When you receive a new message, read shared-knowledge.log ONCE to get context
2. Explore the codebase systematically using Read, Grep, and Glob
3. Log important discoveries as you find them
4. If the issue involves API or backend code, coordinate with backend-agent
5. When you find the root cause, log it as a "decision" type
6. Don't keep re-reading shared-knowledge.log in loops - read it once per message, then investigate

Technical Expertise:
- React Native (JavaScript/TypeScript)
- Swift for iOS native modules
- Kotlin for Android native modules
- iOS and Android platform specifics
- Mobile UI/UX patterns
- Deep linking and push notifications
- App store deployment
- Mobile performance optimization
- Network handling and offline support

Remember:
- Use direct messages (send_message_to_agent) for questions and coordination
- Use shared log (log_finding) for discoveries, decisions, and completions
- Be thorough but efficient in your investigation
- Pay attention to platform-specific differences (iOS vs Android)
- When you complete your part, log it so the task owner knows`;
}

/**
 * Spawn a Mobile agent with streaming input from a message queue
 * Returns an AgentHandle to track the running agent
 */
export async function spawnMobileAgent(
  metadata: TaskMetadata,
  queue: MessageQueue,
  callbacks: ToolCallbacks,
  isTaskOwner: boolean,
  onSessionId: (sessionId: string) => void,
  existingSessionId?: string,
  agentName: string = 'mobile-agent'
): Promise<AgentHandle> {
  const repoPath = metadata.repositories.mobile?.path || '/repos/mobile';
  const taskPath = getTaskPath(metadata.task_id);

  // Create MCP server with repo agent tools
  const mcpServer = createRepoAgentMcpServer(callbacks);

  // Build initial context
  const context = `
Task: ${metadata.task_id}
Role: ${isTaskOwner ? 'TASK OWNER' : 'PARTICIPANT'}
Repository: ${repoPath}
Task Directory: ${taskPath}

Live task files (these update as work progresses):
- ${taskPath}/shared-knowledge.log (conversation history and agent findings)
- ${taskPath}/metadata.json (task metadata)

IMPORTANT: The shared-knowledge.log file is continuously updated by other agents and user messages.
Read it ONCE when you receive a new message, then proceed with your work. Don't poll it repeatedly.
`;

  const systemPrompt = getMobileSystemPrompt(isTaskOwner);

  // Create streaming input generator from queue
  const inputGenerator = createAgentInputGenerator(queue);

  // Run the agent with streaming input - this runs until queue is stopped
  const agentQuery = query({
    prompt: inputGenerator as any,
    options: {
      model: (process.env.SONNET_MODEL || 'claude-sonnet-4-5-20250929') as any,
      systemPrompt: `${systemPrompt}\n\nCurrent Context:\n${context}`,
      cwd: repoPath,
      additionalDirectories: [repoPath, taskPath] as any,
      executable: 'node',
      pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || 'claude',
      env: process.env as Record<string, string>,
      resume: existingSessionId,
      maxTurns: 100,
      permissionMode: 'dontAsk',
      mcpServers: {
        'repo-agent-tools': mcpServer,
      },
      allowedTools: [
        'mcp__repo-agent-tools__send_message_to_agent',
        'mcp__repo-agent-tools__log_finding',
        'Read',
        'Glob',
        'Grep',
      ],
    },
  });

  // Create handle to track agent state
  const handle: AgentHandle = {
    running: Promise.resolve(),
    isRunning: true,
  };

  // Process agent output in background
  handle.running = (async () => {
    try {
      for await (const event of agentQuery) {
        // Capture session ID
        if (event.type === 'system' && event.subtype === 'init') {
          onSessionId(event.session_id);
        }

        // Log tool calls with details (only file operations, not MCP tools)
        if (event.type === 'assistant') {
          const content = event.message.content;
          if (typeof content !== 'string') {
            for (const block of content) {
              if (block.type === 'tool_use') {
                const toolName = block.name;
                const input = block.input as any;

                // Only log file operation tools (not MCP tools)
                if (['Read', 'Grep', 'Glob'].includes(toolName)) {
                  logAgentToolCall(agentName, toolName, input, repoPath);
                }
              }
            }
          }
        }
      }
    } catch (error) {
      if (!queue.isStopped()) {
        console.error(`[${agentName}] Error:`, error);
      }
    } finally {
      handle.isRunning = false;
    }
  })();

  return handle;
}
