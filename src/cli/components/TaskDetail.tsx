import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { fetchTaskDetail, sendMessage, sendApproval } from '../api.js';
import { MessageInput } from './MessageInput.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';

interface AgentStatus {
  agent: string;
  active: boolean;
  last_activity?: string;
}

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
  refreshTrigger: number;
}

export function TaskDetail({ taskId, onBack, refreshTrigger }: TaskDetailProps) {
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0); // 0 = bottom (newest)
  const [inputActive, setInputActive] = useState(false);
  const [approval, setApproval] = useState<{ text: string; type: 'edit_mode' | 'research_budget' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');

  const loadDetail = useCallback(async () => {
    try {
      const detail = await fetchTaskDetail(taskId);
      setAgents(detail.agents || []);
      setStatus(detail.metadata?.status || '');

      if (detail.knowledgeLog) {
        const lines = detail.knowledgeLog.split('\n').filter((l: string) => l.trim());
        setLogLines(lines);
        setScrollOffset(0); // stick to bottom on new data
      }
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  }, [taskId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail, refreshTrigger]);

  useInput((input, key) => {
    if (approval) return; // approval prompt captures input
    if (key.escape) {
      if (inputActive) {
        setInputActive(false);
      } else {
        onBack();
      }
    } else if (key.tab) {
      setInputActive((prev) => !prev);
    } else if (!inputActive) {
      // Scroll log with arrow keys when input is not focused
      if (key.upArrow) {
        setScrollOffset((prev) => Math.min(prev + 1, Math.max(0, logLines.length - logHeight + 1)));
      } else if (key.downArrow) {
        setScrollOffset((prev) => Math.max(0, prev - 1));
      }
    }
  });

  const handleSendMessage = async (message: string) => {
    try {
      await sendMessage(taskId, message);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleApproval = async (type: 'edit_mode' | 'research_budget', approve: boolean) => {
    try {
      await sendApproval(taskId, type, approve);
      setApproval(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  // SSE events trigger approval prompts — exposed via App passing event data
  // For now, approval is set when parent detects approval:requested event for this task

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  // Reserve lines: header(2) + agents(2) + input(2) + approval(3 if present) + statusbar(2)
  const reservedLines = 8 + (approval ? 3 : 0);
  const logHeight = Math.max(5, termHeight - reservedLines);

  return (
    <Box flexDirection="column" height={termHeight}>
      {/* Header */}
      <Box paddingX={1}>
        <Text bold>Task: {taskId}</Text>
        <Text dimColor>  status: </Text>
        <Text color={status === 'in_progress' ? 'yellow' : status === 'completed' ? 'green' : 'red'}>
          {status}
        </Text>
      </Box>

      {/* Agents bar */}
      <Box paddingX={1} gap={2}>
        {agents.length > 0 ? (
          agents.map((a) => (
            <Box key={a.agent}>
              <Text color={a.active ? 'green' : 'gray'}>
                {a.active ? '●' : '○'} {a.agent}
              </Text>
            </Box>
          ))
        ) : (
          <Text dimColor>No agents</Text>
        )}
      </Box>

      {/* Knowledge log — fills available space, scrollable with arrow keys */}
      <Box flexDirection="column" flexGrow={1} height={logHeight} paddingX={1} justifyContent="flex-end" overflowY="hidden">
        {(() => {
          if (logLines.length === 0) return <Text dimColor>No log entries yet</Text>;
          const visibleLines = scrollOffset > 0 ? logHeight - 1 : logHeight; // reserve 1 line for indicator
          const end = logLines.length - scrollOffset;
          const start = Math.max(0, end - visibleLines);
          return (
            <>
              {logLines.slice(start, end).map((line, i) => (
                <Text key={i} wrap="truncate">{line}</Text>
              ))}
              {scrollOffset > 0 && (
                <Text dimColor>↓ {scrollOffset} more below</Text>
              )}
            </>
          );
        })()}
      </Box>

      {/* Approval prompt (when active) */}
      {approval && (
        <ApprovalPrompt text={approval.text} type={approval.type} onRespond={handleApproval} />
      )}

      {/* Message input */}
      <Box paddingX={1} marginTop={1}>
        <MessageInput
          onSubmit={handleSendMessage}
          active={inputActive}
          placeholder={inputActive ? 'Type message to PM...' : 'Press Tab to type...'}
        />
      </Box>
    </Box>
  );
}

/**
 * Set approval prompt from parent (when SSE event arrives).
 * Exposed as a ref method or via prop update.
 */
export type { AgentStatus };
