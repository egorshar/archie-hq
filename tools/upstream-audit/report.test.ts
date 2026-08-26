import { describe, expect, test } from 'vitest';
import type { Hit } from './scan.js';
import type { Violation } from './invariants.js';
import { renderReport } from './report.js';

const hit = (over: Partial<Hit> = {}): Hit => ({
  ruleId: 'repo-host-leak',
  pack: 'gitlab',
  file: 'src/agents/tools.ts',
  line: 21,
  evidence: "import { getGitHubClient } from '../connectors/github/client.js';",
  why: 'Bypasses the RepoHost port.',
  lookAt: ['src/connectors/gitlab/client.ts'],
  ...over,
});

const render = (hits: Hit[], violations: Violation[] = []) =>
  renderReport({ range: 'abc123..def456', hits, violations });

describe('renderReport', () => {
  test('gives each seam its own section', () => {
    const out = render([hit(), hit({ ruleId: 'sdk-leak', pack: 'opencode', file: 'src/memory/extractor.ts' })]);

    expect(out).toContain('## GitLab repo host');
    expect(out).toContain('## opencode runtime');
  });

  test('renders a hit as a row carrying rule, location and where to look', () => {
    const out = render([hit()]);

    expect(out).toContain('repo-host-leak');
    expect(out).toContain('src/agents/tools.ts:21');
    expect(out).toContain('src/connectors/gitlab/client.ts');
  });

  test('leaves an empty verdict cell for the triage step to fill', () => {
    const row = render([hit()]).split('\n').find((l) => l.includes('repo-host-leak'))!;

    expect(row).toMatch(/\|\s*\|/);
  });

  test('says so explicitly when a seam has no hits', () => {
    const out = render([hit()]);

    expect(out).toContain('No opencode-relevant changes in this range.');
  });

  test('states the seams are intact when no invariant is violated', () => {
    expect(render([])).toContain('Seam invariants hold');
  });

  test('lists invariant violations when the seam has leaked', () => {
    const out = render([], [
      {
        invariantId: 'sdk-confined',
        file: 'src/memory/extractor.ts',
        line: 4,
        evidence: "import { query } from '@anthropic-ai/claude-agent-sdk';",
        why: 'Only the claude runtime adapter may touch the SDK.',
      },
    ]);

    expect(out).toContain('sdk-confined');
    expect(out).toContain('src/memory/extractor.ts:4');
    expect(out).not.toContain('Seam invariants hold');
  });

  test('records the audited range', () => {
    expect(render([])).toContain('abc123..def456');
  });
});
