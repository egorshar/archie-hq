import { describe, expect, test } from 'vitest';
import { INVARIANTS, checkInvariants } from './invariants.js';

const src = (path: string, ...lines: string[]) => ({ path, content: lines.join('\n') });

describe('checkInvariants', () => {
  test('reports a Claude Agent SDK import outside the claude runtime adapter', () => {
    const violations = checkInvariants([
      src('src/memory/extractor.ts', '// header', "import { query } from '@anthropic-ai/claude-agent-sdk';"),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      invariantId: 'sdk-confined',
      file: 'src/memory/extractor.ts',
      line: 2,
    });
  });

  test('allows the SDK inside the adapter that owns it', () => {
    const violations = checkInvariants([
      src('src/runtime/claude/sdk.ts', "import { query } from '@anthropic-ai/claude-agent-sdk';"),
    ]);

    expect(violations).toEqual([]);
  });

  test('reports octokit outside the github connector and allows it inside', () => {
    const outside = checkInvariants([src('src/tasks/task.ts', 'const gh = new Octokit();')]);
    const inside = checkInvariants([src('src/connectors/github/client.ts', 'const gh = new Octokit();')]);

    expect(outside.map((v) => v.invariantId)).toEqual(['octokit-confined']);
    expect(inside).toEqual([]);
  });

  test('ships one invariant per seam', () => {
    expect(INVARIANTS.map((i) => i.id).sort()).toEqual(['octokit-confined', 'sdk-confined']);
  });
});
