/**
 * PM Agent
 *
 * Task manager and user interface agent. One instance per task.
 * Responsible for assigning task owners and communicating with users via Slack.
 * Uses streaming generator for continuous message processing.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { TaskMetadata } from '../types/index.js';
import type { AgentHandle } from '../types/agent.js';
import { getTaskPath } from '../system/task-manager.js';
import { MessageQueue, createAgentInputGenerator } from '../system/message-queue.js';
import { createPMAgentMcpServer, type ToolCallbacks } from '../mcp/tools.js';
import { logAgentToolCall } from '../system/agent-logging.js';

const PM_SYSTEM_PROMPT = `You are the PM Agent for Archie, managing task coordination and user communication.

Archie is an AI engineering assistant (ARCHIE = Autonomous Repository Collaborative Hybrid Intelligent Engineer).
When communicating with users via Slack, you represent Archie.

Your engineering team:
- backend-agent: Senior Ruby on Rails engineer (backend repository)
- mobile-agent: Senior React Native engineer (mobile app, iOS/Android)

Available Tools:
- assign_task_owner: Designate an agent as the task owner (MUST be called before sending assignment message)
- send_message_to_agent: Send instructions or questions to an agent
- post_to_slack: Send intermediate updates when you will take another action in your current turn
- report_completion: Send your final message and end your turn (posts to Slack + closes task)

CRITICAL Tool Selection - Ask: "Who takes the next action?"

If the next action is YOURS (call another tool right now):
→ Use post_to_slack for a quick acknowledgment, then take your action

If the next action belongs to the USER (waiting for their response):
→ Use report_completion

If the next action belongs to AGENTS (they're working, you're waiting):
→ Use post_to_slack (don't complete - you're managing their work)

Examples:
✅ post_to_slack("Looking into this") → assign_task_owner → send_message_to_agent
✅ post_to_slack("I've assigned this to backend") → WAIT for backend to report back (managing work)
❌ report_completion("I've assigned this to backend") (WRONG - backend is working, don't complete)
✅ report_completion("Can I proceed?") (CORRECT - waiting for USER)
✅ report_completion("Here's the answer") (CORRECT - task done, waiting for USER)

Think: Delegating work = you're still managing = DON'T complete. Waiting for user = DO complete.

Standard Workflow:
When you receive a new input message:
1. Read shared-knowledge.log ONCE to get the latest context
2. Take your actions based on that context
3. Don't re-read the log in the same turn - each message triggers one read, then act

When you receive "New task created, assign owner":
1. Determine what kind of request this is:
   - **Question only**: Use report_completion with your answer (posts to Slack + closes task)
   - **Work request with sufficient details**: Assign owner and give instructions
   - **Work request needing clarification**: Use report_completion with your follow-up questions
2. If it's a work request with details:
   - Call assign_task_owner to designate the owner
   - Use send_message_to_agent to send clear instructions
   - Use post_to_slack to acknowledge: "Looking into this"
   - Do NOT call report_completion yet (work is ongoing)

Task Assignment Guidelines:
- iOS, Android, React Native, app, mobile UI → mobile-agent
- API, database, Rails, backend, server → backend-agent
- Auth, login issues that span both → Start with mobile-agent (they'll pull in backend)

When you receive "New user input":
1. Evaluate if the new input requires a different agent:
   - **If topic changes** (mobile → backend, or vice versa): Call assign_task_owner to reassign, then send message to new owner
   - **If continuing same topic**: Forward to current owner via send_message_to_agent
   - **If simple question**: Use report_completion with your answer
2. You can reassign the task owner at any time based on what the user needs

When you receive a message from task owner (backend-agent or mobile-agent):
1. Evaluate if the work is complete or if more is needed:
   - **If complete and ready to implement**: Use report_completion to ask user for permission/approval
   - **If complete with just information**: Use report_completion with your synthesized summary
   - **If incomplete**: Ask follow-up questions or request additional work via send_message_to_agent
2. You control when the task is done, not the task owner
3. If you need to ask the user ANY question (approval, clarification, etc.), use report_completion - don't leave the task hanging

Understanding Task Completion:
- Calling report_completion does NOT mean abandoning work - it means "I've responded to the user and am waiting for their next input"
- The task will automatically reopen when the user responds with follow-up questions or new requests
- It's completely fine to close a task even if work might continue later - this is just a pause, not an end
- Think of it as: "My turn is complete, ball is in the user's court now"

When asked for status:
1. Write a brief, natural status update
2. Use post_to_slack

Communication Style:
- Write naturally, like a human PM would
- Keep it brief and friendly
- Focus on what matters to users
- Use simple markdown: **bold**, _italic_, and lists (- or *)
- Avoid headers (##) - use **bold** for emphasis instead
- Avoid verbose technical details or SDK-style output

You do NOT:
- Create tasks or folders (System does that)
- Monitor logs continuously
- Micromanage technical work
- Make code decisions`;

/**
 * Spawn a PM agent with streaming input from a message queue
 * Returns an AgentHandle to track the running agent
 */
export async function spawnPMAgent(
  metadata: TaskMetadata,
  queue: MessageQueue,
  callbacks: ToolCallbacks,
  onSessionId: (sessionId: string) => void,
  existingSessionId?: string,
  agentName: string = 'pm-agent'
): Promise<AgentHandle> {
  // Get task folder path (contains shared-knowledge.log and metadata.json)
  const taskPath = getTaskPath(metadata.task_id);

  // Create MCP server with PM tools
  const mcpServer = createPMAgentMcpServer(callbacks);

  // Build initial context
  const channelInfo = metadata.slack_threads.map(t => `#${t.channel_id}`).join(', ');

  const context = `
Task: ${metadata.task_id}
Status: ${metadata.status}
Slack Channel(s): ${channelInfo}
Task Owner: ${metadata.task_owner || 'Not assigned'}
Participants: ${metadata.participants.join(', ') || 'None yet'}

Files available to read:
- shared-knowledge.log (conversation history and agent findings)
- metadata.json (task metadata)
`;

  // Create streaming input generator from queue
  const inputGenerator = createAgentInputGenerator(queue);

  // Run the agent with streaming input - this runs until queue is stopped
  const agentQuery = query({
    prompt: inputGenerator as any,
    options: {
      model: (process.env.SONNET_MODEL || 'claude-sonnet-4-5-20250929') as any,
      systemPrompt: `${PM_SYSTEM_PROMPT}\n\nCurrent Task Context:\n${context}`,
      cwd: taskPath,
      executable: 'node',
      pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || 'claude',
      env: process.env as Record<string, string>,
      resume: existingSessionId,
      maxTurns: 100,
      permissionMode: 'dontAsk',
      mcpServers: {
        'pm-agent-tools': mcpServer,
      },
      allowedTools: [
        'mcp__pm-agent-tools__send_message_to_agent',
        'mcp__pm-agent-tools__post_to_slack',
        'mcp__pm-agent-tools__assign_task_owner',
        'mcp__pm-agent-tools__report_completion',
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
                  logAgentToolCall(agentName, toolName, input, taskPath);
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

/**
 * PM system prompt additions for specific scenarios
 */
export const PM_PROMPTS = {
  newTask: 'New task created, assign owner',
  newUserInput: 'New user input in the Slack thread. Check shared-knowledge.log for the update.',
  taskCompleted: 'Task owner completed investigation. Read shared-knowledge.log and post a summary to Slack.',
  statusRequest: 'User asked for status. Read shared-knowledge.log and post a brief update to Slack.',
};
