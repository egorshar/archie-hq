/**
 * Triage Agent
 *
 * Lightweight message classifier using Haiku model.
 * Determines if a message is a new task, existing task, status request, or cancellation.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { TriageResult, SlackMessage } from '../types/index.js';
import { findTaskIdByThread } from '../system/task-runtime.js';
import { logAgentToolCall } from '../system/agent-logging.js';

/**
 * Zod schema for triage result
 */
const TriageResultSchema = z.object({
  action: z.enum(['new_task', 'existing_task', 'status_request', 'cancel_task', 'noop']),
  task_id: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']),
  similar_tasks: z.array(z.string()).optional(),
  reasoning: z.string(),
});

const TRIAGE_SYSTEM_PROMPT = `You are the Triage Agent, a lightweight message classifier for a multi-agent engineering system.

Your job is to classify incoming Slack messages and determine the appropriate action:

1. **new_task**: User is requesting new work, asking a question, or greeting the bot
2. **existing_task**: Message relates to an ongoing task (same thread or similar topic)
3. **status_request**: User is asking for a status update on existing work
4. **cancel_task**: User wants to stop or cancel ongoing work
5. **noop**: Pure acknowledgment that needs no response (e.g., "Thanks!" as a reply, "Got it", "OK")

IMPORTANT: Greetings like "hello", "hi", "how are you?" should be **new_task** so the bot can respond.
Only use **noop** for pure acknowledgments in response to bot messages (like "thanks" after bot answered).

How This Works:
1. **If context shows "THREAD MATCH"**: Use that task_id with high confidence
2. **If context shows "No thread match"**: Search for the task using your tools

Task Storage:
- All tasks stored in current directory (sessions/)
- Each task folder (task-*) contains:
  - metadata.json - Task info, participants, Slack thread_ids
  - shared-knowledge.log - Conversation history

Available Tools:
- Glob: Find all task folders (e.g., "*/metadata.json" or "task-*/metadata.json")
- Grep: Search for thread_id in metadata files or keywords in logs
- Read: Examine specific metadata.json or shared-knowledge.log

How to Search:
1. Use Grep to search for the thread_id across all metadata.json files (e.g., "*/metadata.json")
2. If found, extract the task_id from the path and classify based on user intent (existing_task, status_request, or cancel_task)
3. If not found anywhere, classify as new_task

Response Format:
- action: Classification of the message
- task_id: Required for existing_task, status_request, or cancel_task actions
- confidence: Your confidence level (think of it as a probability score):
  - high: 0.8+ confidence - Thread ID exact match, or explicit cancel/status keywords with task context
  - medium: 0.5-0.8 confidence - Strong keyword/topic match in logs, or clear intent with similar tasks
  - low: 0.0-0.5 confidence - No thread match, weak/ambiguous signals, or genuinely new request
- similar_tasks: List of similar active task IDs (optional)
- reasoning: Brief explanation of your decision

Keywords that suggest status_request:
- "status", "update", "progress", "how's it going", "what's happening"

Keywords that suggest cancel_task:
- "stop", "cancel", "abort", "nevermind", "forget it", "different direction"`;

/**
 * Build context about existing tasks for the triage agent
 */
function buildTriageContext(threadId: string): string {
  // Fast O(1) lookup in memory
  const existingTaskId = findTaskIdByThread(threadId);

  if (existingTaskId) {
    return `THREAD MATCH: This thread (${threadId}) belongs to task ${existingTaskId}`;
  }

  return 'No thread match found in active tasks. Use tools if needed to search historical tasks.';
}

/**
 * Run the triage agent to classify a Slack message
 */
export async function triageMessage(
  message: SlackMessage,
  threadHistory: SlackMessage[]
): Promise<TriageResult> {
  const threadId = message.thread_ts || message.ts;

  // Build context about existing tasks
  const context = buildTriageContext(threadId);

  // Build the message for triage
  const triageInput = `
Thread ID: ${threadId}
Channel: ${message.channel}
User: ${message.user}

Thread History:
${threadHistory.map((m) => `[${m.user}]: ${m.text}`).join('\n')}

Current Message:
${message.text}

${context}

Classify this message and respond with JSON only.`;

  let result: TriageResult = {
    action: 'new_task',
    confidence: 'low',
  };

  // Convert Zod schema to JSON Schema
  const jsonSchema = zodToJsonSchema(TriageResultSchema, { $refStrategy: 'none' });


  // Run the triage agent with tools and structured output
  // Set cwd to sessions directory for searching task metadata
  for await (const event of query({
    prompt: triageInput,
    options: {
      model: (process.env.HAIKU_MODEL || 'claude-haiku-4-5-20251001') as any,
      systemPrompt: TRIAGE_SYSTEM_PROMPT,
      cwd: 'sessions',
      executable: 'node',
      pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || 'claude',
      env: process.env as Record<string, string>,
      allowedTools: ['Glob', 'Grep', 'Read'],
      outputFormat: {
        type: 'json_schema',
        schema: jsonSchema,
      },
    },
  })) {
    // Log tool calls with details
    if (event.type === 'assistant') {
      const content = event.message.content;
      if (typeof content !== 'string') {
        for (const block of content) {
          if (block.type === 'tool_use') {
            const toolName = block.name;
            const input = block.input as any;

            // Log file operation tools
            if (['Read', 'Grep', 'Glob'].includes(toolName)) {
              logAgentToolCall('triage-agent', toolName, input, 'sessions');
            } else {
              console.log(`[triage-agent] Tool: ${toolName}`);
            }
          }
        }
      }
    }

    if (event.type === 'result') {
      if (event.subtype === 'success' && event.structured_output) {
        // Validate with Zod and extract result
        const parsed = TriageResultSchema.safeParse(event.structured_output);
        if (parsed.success) {
          result = parsed.data;
          console.log('[triage-agent] Decision:', {
            action: result.action,
            taskId: result.task_id || '(none)',
            confidence: result.confidence,
            reasoning: parsed.data.reasoning,
          });
        } else {
          console.error('[triage-agent] Validation failed:', parsed.error);
        }
      } else if (event.subtype === 'error_max_structured_output_retries') {
        console.error('[triage-agent] Failed to produce valid structured output after retries');
      } else if (event.subtype === 'error_during_execution') {
        console.error('[triage-agent] Error during execution:', event.errors);
      }
    }
  }

  return result;
}
