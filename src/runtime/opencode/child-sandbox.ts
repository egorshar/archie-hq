/**
 * Pure sandbox core for the opencode per-child OS sandbox (P3b). Turns a
 * ChildSandboxProfile (mounts + egress + env, assembled in buildChildSandboxProfile)
 * into a bwrap argv, a stable fingerprint (for the serve-pool's mount-flip
 * recycle), and the platform-gated spawn command. The mount model mirrors
 * src/agents/sandbox.ts buildSandboxConfig's allow/deny non-overlap rule:
 * bwrap processes binds sequentially, so a denyWrite path is re-ro-bound AFTER
 * the rw region it sits in, downgrading it to read-only.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../system/logger.js';
import { SERVE_ARGS } from './embedded-server.js';

const execFileAsync = promisify(execFile);

/**
 * This child's egress-proxy credential. Structurally identical to Task 3's
 * `EgressCredential` (egress-proxy.ts) — defined inline here to avoid a
 * Task 2→Task 3 build-order coupling. The pure functions in this module never
 * read `cred`; it's carried on the profile for the wiring in later tasks.
 */
export interface EgressCredential {
  username: string;
  password: string;
}

export interface ChildSandboxProfile {
  cwd: string;
  homeDir: string;
  roBinds: string[];
  rwBinds: string[];
  denyWriteRoBinds: string[];
  proxy: { url: string; noProxy: string };
  allowlist: string[];
  env: Record<string, string>;
  cred: EgressCredential;
}

/** System dirs a serve child needs to read (binaries, libs, certs). Whitelist-built
 * root: /app and the workdir are simply never mounted except explicit allow paths. */
export const SANDBOX_SYSTEM_ROBINDS = ['/usr', '/bin', '/lib', '/lib64', '/etc', '/opt', '/sbin'];

/** Build the bwrap argv (flags only — the caller appends `opencode <SERVE_ARGS>`).
 * Nonexistent bind sources are skipped (clone/lib paths vary by host/task); cwd
 * and homeDir are created by the pool before this runs, so they always bind. */
export function buildSandboxArgv(profile: ChildSandboxProfile): string[] {
  const argv: string[] = [];
  const roBind = (p: string) => { if (existsSync(p)) argv.push('--ro-bind', p, p); };
  // /tmp is already tmpfs'd below and every rw path is bound at most once —
  // dedupe so cwd/homeDir binding explicitly and also appearing in rwBinds
  // (as the profile assembler is free to do) doesn't emit a redundant mount.
  const rwSeen = new Set<string>(['/tmp']);
  const rwBind = (p: string) => {
    if (rwSeen.has(p)) return;
    rwSeen.add(p);
    if (existsSync(p)) argv.push('--bind', p, p);
  };

  for (const p of SANDBOX_SYSTEM_ROBINDS) roBind(p);
  argv.push('--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev');

  for (const p of profile.roBinds) roBind(p);
  // cwd and homeDir always bind rw, regardless of whether the assembler also
  // lists them in rwBinds — the serve-pool guarantees both exist on disk
  // before this runs (see class docstring above).
  rwBind(profile.cwd);
  rwBind(profile.homeDir);
  for (const p of profile.rwBinds) rwBind(p);
  // deny paths re-bound read-only AFTER the rw regions → sequential-mount downgrade
  for (const p of profile.denyWriteRoBinds) roBind(p);

  argv.push('--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts');
  // NOTE: deliberately NO --unshare-net (Option A) — loopback must stay for the
  // bridge callback + SDK client; egress is filtered cooperatively via the proxy env.
  return argv;
}

/** Stable hash of the security-relevant profile inputs — mounts, allowlist,
 * cwd, home. EXCLUDES the proxy credential (rotates per boot; not a boundary
 * change) and env. serve-pool compares this on a warm handle: a mismatch (e.g.
 * an RO→RW mount flip on the same clone path) forces a mode-transition recycle. */
export function profileFingerprint(profile: ChildSandboxProfile): string {
  const material = JSON.stringify({
    cwd: profile.cwd,
    home: profile.homeDir,
    ro: [...profile.roBinds].sort(),
    rw: [...profile.rwBinds].sort(),
    deny: [...profile.denyWriteRoBinds].sort(),
    allow: [...profile.allowlist].sort(),
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

let bwrapChecked = false;
let bwrapAvailable = false;
let darwinWarned = false;

async function ensureBwrap(): Promise<boolean> {
  if (bwrapChecked) return bwrapAvailable;
  bwrapChecked = true;
  try {
    await execFileAsync('bwrap', ['--version']);
    bwrapAvailable = true;
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

/** Platform-gated spawn command. Linux: bwrap is MANDATORY — a missing binary
 * throws (fail-closed → the pool's boot-failure path → task recovery). darwin:
 * warn once, run unwrapped (dev parity; the pruned env + proxy still apply). */
export async function wrapServeCommand(profile: ChildSandboxProfile): Promise<{ command: string; args: string[] }> {
  if (process.platform === 'darwin') {
    if (!darwinWarned) {
      darwinWarned = true;
      logger.warn('opencode', 'opencode children run UNSANDBOXED on darwin — Linux/Docker enforces the bwrap jail; egress proxy + env pruning still apply');
    }
    return { command: 'opencode', args: [...SERVE_ARGS] };
  }
  if (!(await ensureBwrap())) {
    throw new Error('bwrap not available — refusing to run an opencode child unsandboxed on a non-darwin platform (fail-closed)');
  }
  return { command: 'bwrap', args: [...buildSandboxArgv(profile), 'opencode', ...SERVE_ARGS] };
}
