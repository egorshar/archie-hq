#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { getBaseUrl } from './api.js';
import { ensureCredential, ensureServer, type ServerHandle } from './preflight.js';

// Simple arg parsing — future: add --url, --task flags
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Archie CLI — interactive TUI for the Archie agent system

Usage: npm run cli [options]

Options:
  --help, -h    Show this help message

Environment:
  ARCHIE_URL    Server URL (default: http://localhost:3000)

Controls:
  arrows        Navigate task list
  enter         Open task
  n             New task
  tab           Toggle message input (in task view)
  esc           Go back
  q             Quit
`);
  process.exit(0);
}

async function main(): Promise<void> {
  // Preflight runs in the normal terminal (the token flow is interactive and
  // opens a browser) BEFORE we switch to the alternate screen buffer.
  let server: ServerHandle;
  try {
    await ensureCredential();
    server = await ensureServer(getBaseUrl());
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const teardown = () => {
    if (server.startedByUs) server.stop();
  };
  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);

  // Use alternate screen buffer for clean fullscreen TUI
  process.stdout.write('\x1b[?1049h');
  process.stdout.write('\x1b[H');

  const instance = render(<App />, { exitOnCtrlC: true });

  await instance.waitUntilExit();
  // Restore original screen buffer on exit
  process.stdout.write('\x1b[?1049l');
  teardown();
}

main();
