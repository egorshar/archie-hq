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
import { join } from 'node:path';
import { logger } from '../../system/logger.js';
import { SERVE_ARGS } from './embedded-server.js';
import type { Agent } from '../../agents/agent.js';
import type { Task } from '../../tasks/task.js';
import { WORKDIR } from '../../system/workdir.js';
import { resolveAgentOpencodeModel, resolveOpencodeModel } from './model.js';
import { TRUSTED_PACKAGE_REGISTRY_DOMAINS } from '../../agents/sandbox.js';
import { getRootMcpConfig } from '../../system/plugin-loader.js';
import { isRepoAgent } from '../../types/agent.js';
import type { EgressProxyHandle } from './egress-proxy.js';

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

/** True when `p` equals, or is nested under, some rw bind — i.e. `p` would
 * otherwise sit in a writable region. Used to decide whether a denyWrite path
 * actually needs a downgrade re-bind (see buildSandboxArgv). Path-boundary
 * aware: `/clone` is NOT under `/clone-2`, and `/clone/.git` IS under `/clone`. */
function isUnderAnyRwBind(p: string, rwBinds: string[]): boolean {
  return rwBinds.some((rw) => p === rw || p.startsWith(rw.endsWith('/') ? rw : rw + '/'));
}

/** Build the bwrap argv (flags only — the caller appends `opencode <SERVE_ARGS>`).
 * Nonexistent bind sources are skipped (clone/lib paths vary by host/task). cwd
 * and homeDir bind via the profile's ro/rw lists — the assembler places cwd in
 * roBinds (RO clone) or rwBinds (edit clone / synthetic root) and homeDir always
 * in rwBinds; the pool guarantees both exist on disk before this runs. */
export function buildSandboxArgv(profile: ChildSandboxProfile): string[] {
  const argv: string[] = [];
  const roBind = (p: string) => { if (existsSync(p)) argv.push('--ro-bind', p, p); };
  // /tmp is already tmpfs'd below and every rw path is bound at most once —
  // dedupe so a path appearing more than once across the rw lists doesn't emit
  // a redundant mount.
  const rwSeen = new Set<string>(['/tmp']);
  const rwBind = (p: string) => {
    if (rwSeen.has(p)) return;
    rwSeen.add(p);
    if (existsSync(p)) argv.push('--bind', p, p);
  };

  for (const p of SANDBOX_SYSTEM_ROBINDS) roBind(p);
  argv.push('--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev');

  for (const p of profile.roBinds) roBind(p);
  for (const p of profile.rwBinds) rwBind(p);
  // Re-ro-bind a denyWrite path ONLY when it sits INSIDE an rw region — that is
  // the sole case where it would otherwise be writable, and the later ro-bind
  // downgrades just that sub-path (sequential-mount semantics). A deny path
  // that is NOT under any rw bind is already read-only (RO clone root: bound ro
  // via roBinds) or unmounted; re-ro-binding it would over-mount its subtree
  // and SHADOW a deeper rw carve-out — e.g. an RO clone's `clone/.opencode` rw
  // sub-bind — silently defeating it. So it is skipped.
  for (const p of profile.denyWriteRoBinds) if (isUnderAnyRwBind(p, profile.rwBinds)) roBind(p);

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

/** Hardcoded, orchestrator-controlled provider→egress-host map. NOT env/plugin
 * settable (so a hot reload can't widen egress). Extend when adding a route. */
export const PROVIDER_EGRESS_HOSTS: Record<string, string[]> = {
  openrouter: ['openrouter.ai'],
  anthropic: ['api.anthropic.com'],
};

/** Hardcoded provider→required-env-key map (the only secret the child inherits). */
export const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  openrouter: ['OPENROUTER_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
};

/** Per-agent HOME/XDG_DATA_HOME dir (session-store isolation). Lives under the
 * task serve root so P3a's evictTask rm's the store at task teardown. */
export function agentHomeDir(taskId: string, agentId: string): string {
  // Under the task serve root (so evictTask's rm of it also cleans this) but
  // OUTSIDE the agent's serve cwd. A synthetic-root agent's cwd IS
  // `opencode-server/<taskId>/<agentId>`, and opencode git-snapshots its cwd on
  // every turn; when the session store (this dir) lived at `<cwd>/home`,
  // opencode recursively snapshotted its own growing store — a PM DM
  // conversation ballooned `snapshot/` to >1GB and slowed to a crawl. Placing
  // it in a sibling `_home/<agentId>` keeps it out of every serve cwd (repo
  // agents' cwd is the clone, already a separate tree; `_home` is never itself
  // a serve cwd — those are keyed by real agent ids).
  return join(WORKDIR, 'opencode-server', taskId, '_home', agentId);
}

function providerHostsOrThrow(providerID: string): string[] {
  const hosts = PROVIDER_EGRESS_HOSTS[providerID];
  if (!hosts) throw new Error(`No egress hosts for provider "${providerID}" — extend PROVIDER_EGRESS_HOSTS in child-sandbox.ts`);
  return hosts;
}

/** The repo-host egress domain(s), gated on REPO_HOST. GitLab: the GITLAB_BASE_URL
 * host. GitHub: the fixed github.com endpoints. Normalizes REPO_HOST exactly as
 * src/system/backends.ts resolveRepoHostKind does — unset defaults to 'github'
 * and the value is trimmed + lowercased — so a default-GitHub deploy (REPO_HOST
 * unset or 'GitHub') still gets the github allowlist entries. */
function repoHostEgressDomains(): string[] {
  const kind = (process.env.REPO_HOST ?? 'github').trim().toLowerCase();
  if (kind === 'gitlab') {
    const base = process.env.GITLAB_BASE_URL;
    if (!base) return [];
    try { return [new URL(base).hostname]; } catch { return []; }
  }
  if (kind === 'github') return ['github.com', 'api.github.com', 'codeload.github.com'];
  return [];
}

/** Remote hosts for the MCP servers THIS agent declares (not the global union). */
function declaredMcpHosts(def: Agent['def']): string[] {
  const declared = new Set(Object.keys(def.mcpServers ?? {}));
  if (declared.size === 0) return [];
  const servers = getRootMcpConfig().servers ?? {};
  const hosts: string[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!declared.has(name)) continue;
    const url = (cfg as { url?: string }).url;
    if (!url) continue;
    try { const u = new URL(url); hosts.push(u.port ? `${u.hostname}:${u.port}` : u.hostname); } catch { /* skip */ }
  }
  return hosts;
}

const BASE_ENV_KEYS = ['PATH', 'TERM', 'LANG', 'TZ'];

/** Compose the pruned child env: base vars + LC_*, the per-agent HOME/XDG,
 * the proxy vars, and ONLY the route provider's key(s). Orchestrator secrets
 * (Slack/GitLab/GitHub tokens) are dropped. OPENCODE_CONFIG_CONTENT is added by
 * startEmbeddedServer from config. */
function buildChildEnv(providerID: string, homeDir: string, proxy: { url: string; noProxy: string }, cred: { username: string; password: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV_KEYS) if (process.env[k] != null) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('LC_') && v != null) env[k] = v;
  env.HOME = homeDir;
  env.XDG_DATA_HOME = homeDir;
  for (const key of (PROVIDER_ENV_KEYS[providerID] ?? [])) if (process.env[key] != null) env[key] = process.env[key]!;
  const withCreds = proxy.url.replace('http://', `http://${cred.username}:${cred.password}@`);
  env.HTTP_PROXY = withCreds; env.HTTPS_PROXY = withCreds; env.http_proxy = withCreds; env.https_proxy = withCreds;
  env.NO_PROXY = proxy.noProxy; env.no_proxy = proxy.noProxy;
  return env;
}

/** Credential-free profile skeleton: the mount + allowlist + home material that
 * defines the security boundary, WITHOUT the proxy credential/env. Shared by
 * buildChildSandboxProfile (which adds the cred + env) and agentProfileFingerprint
 * (which just hashes it) so the two can never disagree on what a "change" is. */
function computeProfileSkeleton(agent: Agent, task: Task, cwd: string, editAllowed: boolean, maxMode: boolean): { cwd: string; homeDir: string; roBinds: string[]; rwBinds: string[]; denyWriteRoBinds: string[]; allowlist: string[]; providerID: string } {
  const sb = agent.sandbox; // SandboxOptions, set by prepareAgentContext
  // maxMode may swap the route to ARCHIE_MAX_MODE_MODEL (repo/dynamic agents),
  // so the egress allowlist below must be computed from the max-mode provider.
  const route = resolveAgentOpencodeModel(agent.def, maxMode);
  const homeDir = agentHomeDir(task.taskId, agent.def.id);
  const allowlist = Array.from(new Set([
    ...providerHostsOrThrow(route.providerID),
    ...(isRepoAgent(agent.def) ? repoHostEgressDomains() : []),
    ...(isRepoAgent(agent.def) && editAllowed ? TRUSTED_PACKAGE_REGISTRY_DOMAINS : []),
    ...declaredMcpHosts(agent.def),
    ...(agent.def.allowedNetworkDomains ?? []),
  ]));
  // cwd is writable ONLY for a synthetic root (PM/plugin — never a clone) or an
  // edit-mode clone. For an RO clone, cwd is deliberately LEFT OUT of rwBinds —
  // it is covered read-only by roBinds (allowReadPaths contains the clone), and
  // adding it to rwBinds would make the whole RO clone writable AND (via the
  // deny re-bind) shadow the `cwd/.opencode` rw carve-out. The synthetic root
  // cwd is NOT in allowReadPaths/allowWritePaths (prepareAgentContext doesn't
  // know about the opencode serve root), so without this it would not bind at
  // all. `cwd/.opencode` and homeDir stay rw for every kind.
  const cwdWritable = !isRepoAgent(agent.def) || editAllowed;
  return {
    cwd,
    homeDir,
    roBinds: [...(sb?.allowReadPaths ?? [])],
    rwBinds: Array.from(new Set([
      ...(sb?.allowWritePaths ?? []),
      ...(cwdWritable ? [cwd] : []),
      join(cwd, '.opencode'),
      homeDir,
    ])),
    denyWriteRoBinds: [...(sb?.denyWritePaths ?? [])],
    allowlist,
    providerID: route.providerID,
  };
}

export function buildChildSandboxProfile(args: { agent: Agent; task: Task; cwd: string; editAllowed: boolean; maxMode: boolean; proxy: EgressProxyHandle }): ChildSandboxProfile {
  const { agent, task, cwd, editAllowed, maxMode, proxy } = args;
  const s = computeProfileSkeleton(agent, task, cwd, editAllowed, maxMode);
  const cred = proxy.mintCredential({ taskId: task.taskId, agentId: agent.def.id }, s.allowlist);
  const proxyEnv = { url: proxy.url, noProxy: '127.0.0.1,localhost' };
  return {
    cwd: s.cwd,
    homeDir: s.homeDir,
    roBinds: s.roBinds,
    rwBinds: s.rwBinds,
    denyWriteRoBinds: s.denyWriteRoBinds,
    proxy: proxyEnv,
    allowlist: s.allowlist,
    env: buildChildEnv(s.providerID, s.homeDir, proxyEnv, cred),
    cred,
  };
}

/** Proxy-free fingerprint over the skeleton — same field shape profileFingerprint
 * hashes (cwd, home, sorted ro/rw/deny/allow), so a warm handle's stored
 * fingerprint (set from the built profile) and the desired one computed here
 * agree exactly. No credential minted.
 *
 * The sandbox skeleton only captures the model's PROVIDER (via allowlist hosts),
 * so a same-provider max-mode model swap (e.g. glm-5.1 → glm-5.2) would not
 * change the skeleton hash. Bind the fingerprint to the exact resolved route as
 * well, so approving max mode mid-task always recycles the warm child onto the
 * max model (editAllowed already recycles via the allowlist; this covers model). */
export function agentProfileFingerprint(agent: Agent, task: Task, cwd: string, editAllowed: boolean, maxMode: boolean): string {
  const s = computeProfileSkeleton(agent, task, cwd, editAllowed, maxMode);
  const base = profileFingerprint({
    cwd: s.cwd, homeDir: s.homeDir, roBinds: s.roBinds, rwBinds: s.rwBinds,
    denyWriteRoBinds: s.denyWriteRoBinds, allowlist: s.allowlist,
    proxy: { url: '', noProxy: '' }, env: {}, cred: { username: '', password: '' },
  });
  const route = resolveAgentOpencodeModel(agent.def, maxMode);
  return `${base}:${route.providerID}/${route.modelID}`;
}

export function buildOneShotSandboxProfile(args: { root: string; homeDir: string; proxy: EgressProxyHandle }): ChildSandboxProfile {
  const route = resolveOpencodeModel('haiku'); // the one-shot route
  const allowlist = providerHostsOrThrow(route.providerID);
  const cred = args.proxy.mintCredential({ taskId: 'one-shot', agentId: 'one-shot' }, allowlist);
  const proxyEnv = { url: args.proxy.url, noProxy: '127.0.0.1,localhost' };
  // Profile cwd MUST equal the process spawn cwd (llm-one-shot spawns `cwd: root`)
  // — otherwise the jail binds a dir the process never runs in, and the actual
  // cwd (with its git-inited contents) is invisible. homeDir is a SIBLING of
  // root (not under it), so opencode's per-turn cwd snapshot can't recursively
  // include its own session store (same bug fixed in agentHomeDir); both are
  // rw-bound, and HOME/XDG point at homeDir.
  return {
    cwd: args.root,
    homeDir: args.homeDir,
    roBinds: [],
    rwBinds: [args.root, args.homeDir],
    denyWriteRoBinds: [],
    proxy: proxyEnv,
    allowlist,
    env: buildChildEnv(route.providerID, args.homeDir, proxyEnv, cred),
    cred,
  };
}
