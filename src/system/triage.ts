/**
 * Triage Agent
 *
 * Lightweight classifier using Haiku model.
 * Slack messages: classifies intent (new_task, existing_task, cancel_task, noop).
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import pc from "picocolors";
import type { TriageResult, SlackThread } from "../types/index.js";
import { findTaskByThread } from "../tasks/persistence.js";
import { SESSIONS_DIR } from "./workdir.js";
import { logger } from "./logger.js";
import { loadPrompt } from "../utils/prompt-loader.js";
import { getLlmOneShot } from "./backends.js";

/**
 * Slack triage schema - allows Slack-specific actions
 */
const SlackTriageSchema = z.object({
  action: z.enum([
    "new_task",
    "existing_task",
    "cancel_task",
    "noop",
  ]),
  task_id: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  similar_tasks: z.array(z.string()).optional(),
  reasoning: z.string(),
});

/**
 * Run the triage agent with given input and schema
 */
async function runTriage<T extends z.ZodType>(
  input: string,
  schema: T,
  logLabel: string
): Promise<z.infer<T>> {
  const systemPrompt = await loadPrompt("triage-agent", {});
  const jsonSchema = zodToJsonSchema(schema as any, { $refStrategy: "none" });
  const sessionsDir = SESSIONS_DIR;

  logger.system(`Running triage-agent for ${logLabel}...`);

  const raw = await getLlmOneShot().json({
    prompt: input,
    model: "haiku",
    systemPrompt,
    cwd: sessionsDir,
    allowedTools: ["Glob", "Grep", "Read"],
    jsonSchema,
  });

  const parsed = raw === null ? null : schema.safeParse(raw);

  if (parsed && parsed.success) {
    const data = parsed.data as any;
    const decision = {
      action: data.action,
      taskId: data.task_id || "(none)",
      confidence: data.confidence,
      reasoning: data.reasoning,
    };
    const label = pc.yellow("[triage-agent]");
    console.log(`${label} ${pc.yellow(`[${logLabel}]`)}:`, decision);
    return parsed.data;
  }

  if (raw === null) {
    logger.error("triage-agent", "Failed to produce valid structured output");
  } else if (parsed) {
    logger.error("triage-agent", "Validation failed", parsed.error);
  }

  // Type-safe default based on schema - parse a minimal valid object
  return schema.parse({
    action: "noop",
    confidence: "low",
    reasoning: "Default fallback",
  });
}

// ============================================================================
// Slack Message Triage
// ============================================================================

/**
 * Build the full triage input from a resolved SlackThread.
 * Looks up existing task by thread ID and constructs the classification prompt.
 */
async function buildTriageInput(thread: SlackThread): Promise<string> {
  const taskId = await findTaskByThread(thread.threadId);

  const context = taskId
    ? `THREAD MATCH: This thread (${thread.threadId}) belongs to task ${taskId}. Classify the user's intent and respond with JSON.`
    : `No thread match found. Use tools if needed to search historical tasks. Classify this message and respond with JSON.`;

  const currentMessage = thread.messages.find((m) => m.ts === thread.currentMessageTs);

  return `
Slack Message:
- Thread ID: ${thread.threadId}
- Channel: ${thread.channel.id}
- User: ${currentMessage?.user.realName ?? 'unknown'}

Thread History:
${thread.messages.map((m) => `[${m.user.realName}]: ${m.text}`).join("\n")}

Current Message:
${currentMessage?.text ?? ''}

${context}`;
}

/**
 * Run the triage agent to classify a Slack thread
 */
export async function triageSlackMessage(
  thread: SlackThread
): Promise<TriageResult> {
  const input = await buildTriageInput(thread);

  const result = await runTriage(input, SlackTriageSchema, "slack");

  return {
    action: result.action,
    task_id: result.task_id,
    confidence: result.confidence,
    similar_tasks: result.similar_tasks,
  };
}

