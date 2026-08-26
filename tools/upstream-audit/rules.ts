/**
 * Audit rules: structural signals that an upstream change may need follow-up
 * work in this fork's GitLab repo-host adapter or opencode agent runtime.
 *
 * A rule is a tripwire, not a verdict. It says "look here"; the triage step in
 * the skill decides whether the change actually matters.
 */

export type RulePack = 'gitlab' | 'opencode';

export interface Rule {
  id: string;
  pack: RulePack;
  /** Why a hit matters — copied into the report so triage has the reasoning. */
  why: string;
  /** Fork-side files to compare the upstream change against. */
  lookAt: string[];
  /** File must match to be considered. */
  matchPath: RegExp;
  /** File is skipped when it matches. */
  ignorePath?: RegExp;
  /** When set, the rule fires per added line matching this, not per file. */
  matchAdded?: RegExp;
}

/** Tests mock the seam rather than crossing it; production changes are caught on their own. */
const TEST_FILES = /(^|\/)__tests__\/|\.test\.ts$/;

export const RULES: Rule[] = [
  {
    id: 'repo-host-leak',
    pack: 'gitlab',
    why: 'New direct getGitHubClient() call site bypasses the RepoHost port, so it silently does nothing on GitLab.',
    lookAt: ['src/ports/repo-host.ts', 'src/connectors/gitlab/client.ts', 'src/system/backends.ts'],
    matchPath: /^src\/.*\.ts$/,
    ignorePath: new RegExp(
      [
        '^src/connectors/github/', // the adapter itself
        '^src/system/backends\\.ts$', // the sanctioned factory
        TEST_FILES.source,
      ].join('|'),
    ),
    matchAdded: /\bgetGitHubClient\b/,
  },
  {
    id: 'octokit-surface',
    pack: 'gitlab',
    why: 'Raw octokit usage outside the GitHub connector is GitHub-only by construction and has no GitLab equivalent.',
    lookAt: ['src/ports/repo-host.ts', 'src/connectors/gitlab/client.ts'],
    matchPath: /^src\/.*\.ts$/,
    ignorePath: new RegExp(['^src/connectors/github/', TEST_FILES.source].join('|')),
    matchAdded: /\boctokit\b|@octokit\//i,
  },
  {
    id: 'github-connector-drift',
    pack: 'gitlab',
    why: 'Host-coupled connector logic changed; the GitLab adapter implements the same port and may need the same behaviour.',
    lookAt: ['src/connectors/gitlab/client.ts', 'src/connectors/gitlab/status-map.ts'],
    matchPath: /^src\/connectors\/github\/(client|merge|mergeability|pr-attribution)\.ts$/,
    ignorePath: TEST_FILES,
  },
  {
    id: 'webhook-drift',
    pack: 'gitlab',
    why: 'GitHub event ingress changed; GitLab webhooks synthesize the same canonical events and may need the same handling.',
    lookAt: ['src/connectors/gitlab/webhooks.ts', 'src/connectors/gitlab/events.ts', 'src/ports/repo-host-events.ts'],
    matchPath: /^src\/connectors\/github\/(events|webhooks)\.ts$/,
    ignorePath: TEST_FILES,
  },
  {
    id: 'github-env',
    pack: 'gitlab',
    why: 'New GitHub-only configuration key; GitLab may need a counterpart plus a line in assertBackendConfig().',
    lookAt: ['.env.example', 'src/system/backends.ts', 'docs/guides/gitlab-setup.md'],
    matchPath: /^\.env\.example$/,
    // Not just the GITHUB_ prefix: upstream ships GitHub-scoped keys under other
    // names too (ARCHIE_GITHUB_LOGIN, ARCHIE_GITHUB_USER_ID).
    matchAdded: /^[A-Z0-9_]*GITHUB_[A-Z0-9_]+=/,
  },
  {
    id: 'sdk-leak',
    pack: 'opencode',
    why: 'New Claude Agent SDK import outside the claude runtime adapter; on AGENT_RUNTIME=opencode this code path has no SDK to call.',
    lookAt: ['src/ports/agent-runtime.ts', 'src/ports/llm-one-shot.ts', 'src/runtime/opencode/'],
    matchPath: /^src\/.*\.ts$/,
    ignorePath: new RegExp(['^src/runtime/claude/', TEST_FILES.source].join('|')),
    matchAdded: /@anthropic-ai\/claude-agent-sdk/,
  },
  {
    id: 'agent-surface-drift',
    pack: 'opencode',
    why: 'This file defines what a runtime must provide — tools, sandbox, hooks, prompt or model resolution. The opencode runtime mirrors it by hand.',
    lookAt: ['src/runtime/opencode/runtime.ts', 'src/runtime/opencode/tool-allowlist.ts', 'src/runtime/opencode/child-sandbox.ts', 'src/runtime/opencode/skills.ts'],
    matchPath: /^src\/agents\/(agent|spawn|sandbox|registry|prompts|core-skills|tool-approval-gate|mcp-file-bridge)\.ts$/,
    ignorePath: TEST_FILES,
  },
  {
    id: 'tool-registry-drift',
    pack: 'opencode',
    why: 'A newly registered agent tool must be bridged into opencode, otherwise agents lose it on that runtime.',
    lookAt: ['src/runtime/opencode/bridge/registry.ts', 'src/runtime/opencode/tool-allowlist.ts'],
    matchPath: /^src\/agents\/tools\.ts$/,
    ignorePath: TEST_FILES,
    // tools.ts registers as `return tool(` with the name on the next line;
    // the single-line form shows up in newer additions and tests.
    matchAdded: /\btool\s*\(\s*$|\btool\s*\(\s*['"]/,
  },
];
