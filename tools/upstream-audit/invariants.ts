/**
 * Seam invariants checked against the working tree, not against a diff.
 *
 * Both hold at zero occurrences on this fork today. A non-zero result after a
 * merge means upstream code landed that talks to a backend directly instead of
 * through a port — the seam has leaked, whatever the delta audit said.
 */

export interface Invariant {
  id: string;
  why: string;
  /** Files subject to the invariant. */
  matchPath: RegExp;
  /** The one place allowed to hold the forbidden symbol. */
  allowPath: RegExp;
  forbid: RegExp;
}

export interface Violation {
  invariantId: string;
  file: string;
  /** 1-based line number in the file. */
  line: number;
  evidence: string;
  why: string;
}

export const INVARIANTS: Invariant[] = [
  {
    id: 'sdk-confined',
    why: 'Only the claude runtime adapter may touch the Claude Agent SDK; everything else goes through AgentRuntime or LlmOneShot.',
    matchPath: /^src\/.*\.tsx?$/,
    allowPath: /^src\/runtime\/claude\//,
    forbid: /@anthropic-ai\/claude-agent-sdk/,
  },
  {
    id: 'octokit-confined',
    why: 'Only the GitHub connector may touch octokit; everything else goes through the RepoHost port.',
    matchPath: /^src\/.*\.tsx?$/,
    allowPath: /^src\/connectors\/github\//,
    forbid: /\bOctokit\b|@octokit\//,
  },
];

export function checkInvariants(
  files: Array<{ path: string; content: string }>,
  invariants: Invariant[] = INVARIANTS,
): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    for (const invariant of invariants) {
      if (!invariant.matchPath.test(file.path)) continue;
      if (invariant.allowPath.test(file.path)) continue;

      file.content.split('\n').forEach((text, i) => {
        if (invariant.forbid.test(text)) {
          violations.push({
            invariantId: invariant.id,
            file: file.path,
            line: i + 1,
            evidence: text.trim(),
            why: invariant.why,
          });
        }
      });
    }
  }

  return violations;
}
