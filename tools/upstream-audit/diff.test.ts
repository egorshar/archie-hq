import { describe, expect, test } from 'vitest';
import { parseUnifiedDiff } from './diff.js';

describe('parseUnifiedDiff', () => {
  test('reports added lines with their line number in the new file', () => {
    const diff = [
      'diff --git a/src/agents/tools.ts b/src/agents/tools.ts',
      'index 1111111..2222222 100644',
      '--- a/src/agents/tools.ts',
      '+++ b/src/agents/tools.ts',
      '@@ -21,0 +21,1 @@ import { foo } from "./foo.js";',
      "+import { getGitHubClient } from '../connectors/github/client.js';",
      '',
    ].join('\n');

    expect(parseUnifiedDiff(diff)).toEqual([
      {
        path: 'src/agents/tools.ts',
        status: 'modified',
        addedLines: [
          { line: 21, text: "import { getGitHubClient } from '../connectors/github/client.js';" },
        ],
      },
    ]);
  });
});
