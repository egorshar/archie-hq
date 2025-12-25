/**
 * Task-related type definitions
 */

export type TaskStatus = 'in_progress' | 'stopped' | 'completed';

export type AgentName = 'pm-agent' | 'backend-agent' | 'mobile-agent' | 'triage-agent';

export type FindingType = 'discovery' | 'decision' | 'completion' | 'blocker';

export interface SlackThread {
  thread_id: string;
  channel_id: string;
  last_processed_ts: string;
}

export interface RepositoryInfo {
  path: string;
  branch?: string;
  base_branch?: string;
  base_sha?: string;
}

export interface TaskMetadata {
  task_id: string;
  task_owner: AgentName | null;
  participants: AgentName[];
  slack_threads: SlackThread[];
  agent_sessions: Record<string, string>;
  repositories: Record<string, RepositoryInfo>;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface LogEntry {
  timestamp: string;
  source: string;
  type?: FindingType;
  message: string;
}

export interface TriageResult {
  action: 'new_task' | 'existing_task' | 'status_request' | 'cancel_task' | 'noop';
  task_id?: string;
  confidence: 'high' | 'medium' | 'low';
  similar_tasks?: string[];
}

export interface SlackMessage {
  type: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}
