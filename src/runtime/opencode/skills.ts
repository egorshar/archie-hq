/**
 * Per-agent skill staging for the opencode runtime (P3a §4). Each agent's serve
 * child stages ONLY that agent's skills (skillsPath + coreSkillsPath) into its
 * own cwd's `.opencode/skills` — per-agent scoping falls out of the per-agent
 * serve topology (parity with the Claude runtime's per-agent workspaces). For
 * repo agents the cwd is the clone, so the staged dir is kept out of commits
 * via `.git/info/exclude` (excludeOpencodeFromGit).
 */
import { mkdir, readFile, appendFile, cp, access } from 'fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'node:url';
import type { AgentDef } from '../../types/agent.js';
import { linkAgentSkills } from '../../agents/skill-linking.js';

/**
 * Locate the installed `@opencode-ai/plugin` package root by walking up from
 * this module to the nearest ancestor `node_modules/@opencode-ai/plugin`.
 * Deterministic across dev (src), built (dist), and container (/app) layouts,
 * and free of the package's `exports`-map quirks (it defines no CJS/`require`
 * condition, so `require.resolve` can't find it) and of `import.meta.resolve`
 * bundler differences under the test runner.
 */
function findBridgePluginPkgRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const cand = join(dir, 'node_modules', '@opencode-ai', 'plugin');
    if (existsSync(join(cand, 'package.json'))) return cand;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('@opencode-ai/plugin not found in any ancestor node_modules');
    dir = parent;
  }
}

/**
 * Stage ONE agent's skills into a per-child skills dir (P3a §4): only
 * `def.skillsPath` + `def.coreSkillsPath`, plugin source first so it shadows a
 * core skill of the same name (same ordering the Claude spawn path uses).
 * Returns the staged source count for logging. Clear-and-rebuild via
 * linkAgentSkills, so idempotent.
 */
export async function stageAgentSkills(def: AgentDef, skillsDir: string): Promise<number> {
  const sources = [def.skillsPath, def.coreSkillsPath].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  await linkAgentSkills(skillsDir, sources);
  return sources.length;
}

/**
 * The generated bridge plugin (`bridge/plugin-source.ts`) does
 * `import { tool } from "@opencode-ai/plugin"`. opencode's Bun runtime resolves
 * that import from the plugin's own `.opencode/node_modules` and, when it's
 * missing, AUTO-INSTALLS it from the npm registry at child boot. Under the P3b
 * egress jail, non-(edit-mode-repo) agents are denied `registry.npmjs.org`, so
 * that install 403s, the plugin fails to load, and the bridge registers zero
 * tools — a live-smoke merge blocker. We instead VENDOR the dependency offline:
 * the package is a first-class, version-pinned orchestrator asset (package.json
 * `@opencode-ai/plugin`, lockstep with `@opencode-ai/sdk` and the Dockerfile CLI
 * pin), and we copy it — self-contained, including its own nested `zod` (the
 * only thing the bridge's `tool` entry point pulls in) — into the child's
 * `.opencode/node_modules` before spawn, so Bun resolves it with no network.
 * Idempotent (skips when already present — the per-agent serve root persists
 * across recycle/reap, so this runs ~once per agent per task). Applied on every
 * platform (harmless on darwin dev, where egress is open, but keeps the boot
 * network-free and consistent with the jailed path).
 */
export async function vendorBridgeDeps(nodeModulesDir: string): Promise<void> {
  const dest = join(nodeModulesDir, '@opencode-ai', 'plugin');
  // Idempotent: a populated dest (serve root survived a recycle/reap) is left as-is.
  try {
    await access(join(dest, 'package.json'));
    return;
  } catch {
    // not vendored yet — copy below
  }
  // Copy the package the orchestrator actually installed (dev: repo
  // node_modules; container: /app/node_modules), so the vendored copy always
  // matches the package.json/lockfile version.
  const src = findBridgePluginPkgRoot();
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
}

/**
 * Keep a clone-hosted `.opencode/` (staged skills + generated bridge plugin,
 * which embeds a live bearer token) out of any commit by appending it to the
 * clone's `.git/info/exclude` (repo-local, never touches tracked files —
 * same mechanism planned for ai-context outputs). Idempotent.
 */
export async function excludeOpencodeFromGit(cloneRoot: string): Promise<void> {
  const excludePath = join(cloneRoot, '.git', 'info', 'exclude');
  await mkdir(dirname(excludePath), { recursive: true });
  let current = '';
  try {
    current = await readFile(excludePath, 'utf8');
  } catch {
    current = ''; // no exclude file yet — created by the append below
  }
  if (current.split('\n').includes('.opencode/')) return;
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  await appendFile(excludePath, `${sep}.opencode/\n`);
}
