#!/usr/bin/env tsx
/**
 * Upstream audit CLI.
 *
 *   npx tsx tools/upstream-audit/audit.ts [range] [--out <path>] [--json]
 *
 * With no range it audits what the next merge would bring:
 * `$(git merge-base upstream/main HEAD)..upstream/main`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseUnifiedDiff } from './diff.js';
import { checkInvariants } from './invariants.js';
import { renderReport } from './report.js';
import { scanDiff } from './scan.js';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function defaultRange(): string {
  const base = git('merge-base', 'upstream/main', 'HEAD').trim();
  return `${base}..upstream/main`;
}

function workingTreeSources(): Array<{ path: string; content: string }> {
  return git('ls-files', '--', 'src')
    .split('\n')
    .filter((p) => /\.tsx?$/.test(p))
    .map((path) => ({ path, content: readFileSync(path, 'utf8') }));
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const outIndex = args.indexOf('--out');
  const out = outIndex === -1 ? null : args[outIndex + 1];
  const positional = args.filter((a, i) => !a.startsWith('--') && i !== outIndex + 1);
  const range = positional[0] ?? defaultRange();

  const diff = git('diff', '-U0', range, '--', '.');
  const hits = scanDiff(parseUnifiedDiff(diff));
  const violations = checkInvariants(workingTreeSources());

  if (json) {
    process.stdout.write(`${JSON.stringify({ range, hits, violations }, null, 2)}\n`);
    return;
  }

  const markdown = renderReport({ range, hits, violations });
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${markdown}\n`);
    process.stderr.write(`${hits.length} hit(s), ${violations.length} invariant violation(s) → ${out}\n`);
    return;
  }
  process.stdout.write(`${markdown}\n`);
}

main(process.argv);
