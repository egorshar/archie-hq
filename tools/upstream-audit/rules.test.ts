import { describe, expect, test } from 'vitest';
import type { ChangedFile } from './diff.js';
import { RULES } from './rules.js';
import { scanDiff } from './scan.js';

function only(id: string) {
  const rule = RULES.filter((r) => r.id === id);
  if (rule.length !== 1) throw new Error(`expected exactly one rule "${id}", got ${rule.length}`);
  return rule;
}

function file(path: string, ...added: string[]): ChangedFile {
  return { path, status: 'modified', addedLines: added.map((text, i) => ({ line: i + 1, text })) };
}

const ids = (hits: { ruleId: string }[]) => hits.map((h) => h.ruleId);

describe('octokit-surface', () => {
  test('flags a new octokit call outside the github connector', () => {
    const hits = scanDiff([file('src/tasks/task.ts', '  const pr = await octokit.rest.pulls.get({ ... });')], only('octokit-surface'));

    expect(ids(hits)).toEqual(['octokit-surface']);
  });

  test('stays quiet inside the github connector, where octokit belongs', () => {
    const hits = scanDiff([file('src/connectors/github/client.ts', '  return octokit.rest.pulls.get({ ... });')], only('octokit-surface'));

    expect(hits).toEqual([]);
  });
});

describe('github-connector-drift', () => {
  test('flags a change to a host-coupled connector module', () => {
    const hits = scanDiff([file('src/connectors/github/merge.ts', '  // reworked squash handling')], only('github-connector-drift'));

    expect(ids(hits)).toEqual(['github-connector-drift']);
  });

  test('reports the file once, without a line number', () => {
    const hits = scanDiff([file('src/connectors/github/client.ts', 'a', 'b', 'c')], only('github-connector-drift'));

    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBeUndefined();
  });

  test('ignores host-agnostic helpers that GitLab reuses as-is', () => {
    const hits = scanDiff([file('src/connectors/github/branch-naming.ts', '  // tweak slug')], only('github-connector-drift'));

    expect(hits).toEqual([]);
  });
});

describe('webhook-drift', () => {
  test('flags a change to the github event ingress', () => {
    const hits = scanDiff([file('src/connectors/github/webhooks.ts', '  // new event kind')], only('webhook-drift'));

    expect(ids(hits)).toEqual(['webhook-drift']);
  });
});

describe('github-env', () => {
  test('flags a new GITHUB_* key in .env.example', () => {
    const hits = scanDiff([file('.env.example', 'GITHUB_ENTERPRISE_URL=https://ghe.example.com')], only('github-env'));

    expect(hits).toHaveLength(1);
    expect(hits[0].evidence).toBe('GITHUB_ENTERPRISE_URL=https://ghe.example.com');
  });

  test('ignores unrelated keys', () => {
    const hits = scanDiff([file('.env.example', 'SLACK_BOT_TOKEN=xoxb-...')], only('github-env'));

    expect(hits).toEqual([]);
  });
});

describe('sdk-leak', () => {
  test('flags a new Claude Agent SDK import in a file the fork routes through a port', () => {
    const hits = scanDiff(
      [file('src/memory/extractor.ts', "import { query } from '@anthropic-ai/claude-agent-sdk';")],
      only('sdk-leak'),
    );

    expect(ids(hits)).toEqual(['sdk-leak']);
  });

  test('stays quiet inside the claude runtime adapter, which owns the SDK', () => {
    const hits = scanDiff(
      [file('src/runtime/claude/sdk.ts', "import { query } from '@anthropic-ai/claude-agent-sdk';")],
      only('sdk-leak'),
    );

    expect(hits).toEqual([]);
  });
});

describe('agent-surface-drift', () => {
  test('flags a change to the agent surface the opencode runtime must mirror', () => {
    const hits = scanDiff([file('src/agents/sandbox.ts', '  // new deny rule')], only('agent-surface-drift'));

    expect(ids(hits)).toEqual(['agent-surface-drift']);
  });

  test('ignores agent files outside that surface', () => {
    const hits = scanDiff([file('src/agents/artifacts.ts', '  // unrelated')], only('agent-surface-drift'));

    expect(hits).toEqual([]);
  });
});

describe('tool-registry-drift', () => {
  test('flags the multi-line tool( idiom that tools.ts actually uses', () => {
    const hits = scanDiff(
      [file('src/agents/tools.ts', '  return tool(', "    'close_pr',", "    'Close a pull request',")],
      only('tool-registry-drift'),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].evidence).toBe('return tool(');
  });

  test('flags a newly registered agent tool', () => {
    const hits = scanDiff([file('src/agents/tools.ts', "    tool('close_pr', 'Close a pull request', {")], only('tool-registry-drift'));

    expect(hits).toHaveLength(1);
    expect(hits[0].evidence).toContain('close_pr');
  });
});
