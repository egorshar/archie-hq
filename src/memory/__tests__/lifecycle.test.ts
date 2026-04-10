/**
 * Memory Lifecycle Integration Test
 *
 * End-to-end test for the full extraction pipeline with a mocked extraction API.
 * Verifies that handleTaskCompleted() correctly writes all memory artifacts
 * and posts learnings to Slack.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ============================================================================
// Temp directory state (set before mocks resolve)
// ============================================================================

let tempDir: string;
let memoryDir: string;
let orgPath: string;
let usersDir: string;
let activityPath: string;
let sessionsDir: string;

// ============================================================================
// Mock paths.js — all path functions point into the temp directory
// ============================================================================

vi.mock('../paths.js', () => ({
  isMemoryEnabled: () => true,
  getMemoryDir: () => memoryDir,
  getOrgPath: () => orgPath,
  getUsersDir: () => usersDir,
  getUserPath: (username: string) => {
    const safe = username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    return join(usersDir, `${safe}.md`);
  },
  getRecentActivityPath: () => activityPath,
  getTaskSummaryPath: (taskId: string) => join(sessionsDir, taskId, 'shared', 'summary.md'),
}));

// ============================================================================
// Mock tasks/persistence.js — load files from temp dir
// ============================================================================

vi.mock('../../tasks/persistence.js', () => ({
  loadMetadata: async (taskId: string) => {
    const metaPath = join(sessionsDir, taskId, 'shared', 'metadata.json');
    if (!existsSync(metaPath)) return null;
    const content = await readFile(metaPath, 'utf-8');
    return JSON.parse(content);
  },
  readKnowledgeLog: async (taskId: string) => {
    const logPath = join(sessionsDir, taskId, 'shared', 'knowledge.log');
    if (!existsSync(logPath)) return '';
    return readFile(logPath, 'utf-8');
  },
}));

// ============================================================================
// Mock slack/client.js — spy on postSlackMessage
// ============================================================================

vi.mock('../../connectors/slack/client.js', () => ({
  postSlackMessage: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Mock logger.js — silent stub
// ============================================================================

vi.mock('../../system/logger.js', () => ({
  logger: {
    system: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    slack: vi.fn(),
    agent: vi.fn(),
    debug: vi.fn(),
  },
}));

// ============================================================================
// Mock extractor.js — keep real functions, stub runExtraction
// ============================================================================

vi.mock('../extractor.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../extractor.js')>();
  return {
    ...real,
    runExtraction: vi.fn().mockResolvedValue({
      org_updates: [
        { action: 'add', section: 'Engineering', content: 'Uses NestJS with PostgreSQL' },
      ],
      user_updates: {
        egor: [
          { action: 'add', section: 'Work Style', content: 'Prefers direct communication' },
        ],
      },
      task_summary: 'Investigated and fixed the login bug.',
      activity_summary: 'Fixed login validation bug',
      domain: 'engineering',
    }),
  };
});

// ============================================================================
// Import the module under test and mocked modules (after mocks are set up)
// ============================================================================

import { handleTaskCompleted } from '../lifecycle.js';
import { postSlackMessage } from '../../connectors/slack/client.js';

// ============================================================================
// Test data
// ============================================================================

const TASK_ID = 'task-20260410-1000-abc123';

const METADATA = {
  task_id: TASK_ID,
  task_owner: 'backend-agent',
  participants: ['pm-agent', 'backend-agent'],
  channels: {
    'slack:C1:1234': {
      type: 'slack',
      thread_id: '1234',
      channel_id: 'C1',
      channel_name: 'general',
      last_processed_ts: '1234.5678',
    },
  },
  default_channel: 'slack:C1:1234',
  agent_sessions: {},
  repositories: {},
  status: 'completed',
  created_at: '2026-04-10T10:00:00Z',
  updated_at: '2026-04-10T10:30:00Z',
};

const KNOWLEDGE_LOG = [
  '[2026-04-10T10:00:00Z] [slack:#<C1:general>:1234] [@<U1:Egor Khmelev>] Fix the login bug',
  '[2026-04-10T10:01:00Z] [pm-agent] [decision] Assigned backend-agent',
  '[2026-04-10T10:05:00Z] [backend-agent] [discovery] Missing validation in auth handler',
].join('\n');

// ============================================================================
// Test suite
// ============================================================================

describe('handleTaskCompleted() — end-to-end integration', () => {
  beforeEach(async () => {
    // Create fresh temp directories for each test
    tempDir = await mkdtemp(join(tmpdir(), 'archie-lifecycle-test-'));
    memoryDir = join(tempDir, 'memory');
    orgPath = join(memoryDir, 'org.md');
    usersDir = join(memoryDir, 'users');
    activityPath = join(memoryDir, 'recent-activity.md');
    sessionsDir = join(tempDir, 'sessions');

    // Create required directories
    await mkdir(join(sessionsDir, TASK_ID, 'shared'), { recursive: true });
    await mkdir(usersDir, { recursive: true });
    await mkdir(memoryDir, { recursive: true });

    // Write task metadata and knowledge.log
    await writeFile(
      join(sessionsDir, TASK_ID, 'shared', 'metadata.json'),
      JSON.stringify(METADATA, null, 2),
      'utf-8'
    );
    await writeFile(
      join(sessionsDir, TASK_ID, 'shared', 'knowledge.log'),
      KNOWLEDGE_LOG,
      'utf-8'
    );

    // Reset mocks between tests
    vi.mocked(postSlackMessage).mockClear();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes org.md with extracted org knowledge', async () => {
    handleTaskCompleted(TASK_ID);

    // Wait for async queue to drain
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(existsSync(orgPath)).toBe(true);
    const content = await readFile(orgPath, 'utf-8');
    expect(content).toContain('Uses NestJS with PostgreSQL');
  });

  it('writes users/egor.md with extracted user knowledge', async () => {
    handleTaskCompleted(TASK_ID);

    await new Promise(resolve => setTimeout(resolve, 200));

    const egorPath = join(usersDir, 'egor.md');
    expect(existsSync(egorPath)).toBe(true);
    const content = await readFile(egorPath, 'utf-8');
    expect(content).toContain('Prefers direct communication');
  });

  it('writes summary.md in the session shared directory', async () => {
    handleTaskCompleted(TASK_ID);

    await new Promise(resolve => setTimeout(resolve, 200));

    const summaryPath = join(sessionsDir, TASK_ID, 'shared', 'summary.md');
    expect(existsSync(summaryPath)).toBe(true);
    const content = await readFile(summaryPath, 'utf-8');
    expect(content).toContain('Investigated and fixed the login bug.');
    expect(content).toContain(TASK_ID);
  });

  it('creates recent-activity.md with the activity summary', async () => {
    handleTaskCompleted(TASK_ID);

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(existsSync(activityPath)).toBe(true);
    const content = await readFile(activityPath, 'utf-8');
    expect(content).toContain('Fixed login validation bug');
  });

  it('calls postSlackMessage with the learnings message', async () => {
    handleTaskCompleted(TASK_ID);

    await new Promise(resolve => setTimeout(resolve, 200));

    const postSlackMessageMocked = vi.mocked(postSlackMessage);
    expect(postSlackMessageMocked).toHaveBeenCalledOnce();

    const [args] = postSlackMessageMocked.mock.calls[0];
    expect(args.channel).toBe('C1');
    expect(args.threadTs).toBe('1234');
    expect(args.text).toContain('Fixed login validation bug');
  });
});
