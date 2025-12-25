/**
 * Agent-related type definitions
 */

import type { AgentName, TaskMetadata } from './task.js';

export interface AgentMessage {
  from: AgentName;
  to: AgentName;
  content: string;
  timestamp: string;
}

export interface AgentContext {
  taskId: string;
  metadata: TaskMetadata;
  isTaskOwner: boolean;
  sharedKnowledgePath: string;
}

export interface SendMessageToAgentParams {
  target: AgentName;
  message: string;
}

export interface LogFindingParams {
  entry: string;
  type: 'discovery' | 'decision' | 'completion' | 'blocker';
}

export interface PostToSlackParams {
  message: string;
}

export interface AskUserParams {
  question: string;
  options?: string[];
}

export type AgentModel = 'claude-sonnet-4-5-20250514' | 'claude-haiku-4-5-20250514';

export interface AgentConfig {
  name: AgentName;
  model: AgentModel;
  systemPrompt: string;
}

/**
 * Handle to a running agent
 * Allows checking if agent is running and stopping it
 */
export interface AgentHandle {
  /** Promise that resolves when the agent finishes processing */
  running: Promise<void>;
  /** Whether the agent is still processing messages */
  isRunning: boolean;
}
