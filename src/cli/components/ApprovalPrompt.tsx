import React from 'react';
import { Box, Text, useInput } from 'ink';

interface ApprovalPromptProps {
  text: string;
  type: 'edit_mode' | 'research_budget';
  onRespond: (type: 'edit_mode' | 'research_budget', approve: boolean) => void;
}

export function ApprovalPrompt({ text, type, onRespond }: ApprovalPromptProps) {
  useInput((input) => {
    if (input === 'y' || input === 'Y') {
      onRespond(type, true);
    } else if (input === 'n' || input === 'N') {
      onRespond(type, false);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">{text}</Text>
      <Text>
        Press <Text color="green" bold>y</Text> to approve or <Text color="red" bold>n</Text> to deny
      </Text>
    </Box>
  );
}
