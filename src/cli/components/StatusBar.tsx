import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  connected: boolean;
  view: 'list' | 'detail';
}

export function StatusBar({ connected, view }: StatusBarProps) {
  const status = connected ? 'Connected' : 'Disconnected';
  const statusColor = connected ? 'green' : 'red';

  const hints = view === 'list'
    ? 'arrows: navigate | enter: open | n: new task | t: triggers | q: quit'
    : 'tab: browse | enter/→: expand | ←: collapse | y/n: approve | ↑↓: scroll | esc: back | q: quit';

  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text color={statusColor}>{status}</Text>
      <Text dimColor> | {hints}</Text>
    </Box>
  );
}
