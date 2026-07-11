import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../model.js', () => ({
  resolveAgentOpencodeModel: vi.fn(() => ({ providerID: 'openrouter', modelID: 'z/glm' })),
  resolveOpencodeModel: vi.fn(() => ({ providerID: 'openrouter', modelID: 'z/glm' })),
}));
vi.mock('../../../system/plugin-loader.js', () => ({ getRootMcpConfig: () => ({ servers: { jira: { type: 'http', url: 'https://jira.example.com/mcp' } } }) }));
vi.mock('../../../system/workdir.js', () => ({ WORKDIR: '/wd' }));

import { buildChildSandboxProfile, buildOneShotSandboxProfile, agentHomeDir, PROVIDER_EGRESS_HOSTS, PROVIDER_ENV_KEYS } from '../child-sandbox.js';

const fakeProxy = () => ({ url: 'http://127.0.0.1:9', mintCredential: () => ({ username: 'u', password: 'p' }), revokeCredential: () => {}, close: async () => {} });
const agent = (over: any = {}) => ({
  def: { id: 'backend', repo: { primary: 'org/x' }, mcpServers: { jira: {} }, allowedNetworkDomains: ['plugin.example.com'], ...over.def },
  sandbox: { cwd: '/clone', allowReadPaths: ['/ro'], allowWritePaths: ['/clone', '/tmp'], denyWritePaths: ['/clone/.git/HEAD'], ...over.sandbox },
} as any);
const task = { taskId: 't1' } as any;

const SAVED: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ['OPENROUTER_API_KEY', 'SLACK_BOT_TOKEN', 'GITLAB_TOKEN', 'REPO_HOST', 'GITLAB_BASE_URL']) SAVED[k] = process.env[k];
  process.env.OPENROUTER_API_KEY = 'sk-or'; process.env.SLACK_BOT_TOKEN = 'xoxb'; process.env.GITLAB_TOKEN = 'glpat';
  process.env.REPO_HOST = 'gitlab'; process.env.GITLAB_BASE_URL = 'https://gitlab.walli.com'; });
afterEach(() => { for (const k of Object.keys(SAVED)) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

describe('buildChildSandboxProfile allowlist', () => {
  it('edit-mode repo agent: provider + git host + registries + declared MCP host + frontmatter domains', () => {
    const p = buildChildSandboxProfile({ agent: agent(), task, cwd: '/clone', editAllowed: true, proxy: fakeProxy() });
    expect(p.allowlist).toEqual(expect.arrayContaining([
      'openrouter.ai', 'gitlab.walli.com', 'registry.npmjs.org', 'registry.yarnpkg.com', 'jira.example.com', 'plugin.example.com',
    ]));
  });
  it('read-only repo agent: NO package registries (parity with the Claude sandbox)', () => {
    const p = buildChildSandboxProfile({ agent: agent(), task, cwd: '/clone', editAllowed: false, proxy: fakeProxy() });
    expect(p.allowlist).not.toContain('registry.npmjs.org');
    expect(p.allowlist).toContain('openrouter.ai');
  });
  it('only DECLARED MCP servers get their host (not the global union)', () => {
    const p = buildChildSandboxProfile({ agent: agent({ def: { id: 'x', mcpServers: {} } }), task, cwd: '/synthetic', editAllowed: false, proxy: fakeProxy() });
    expect(p.allowlist).not.toContain('jira.example.com');
  });
  it('throws on an unresolvable provider (no silent default)', async () => {
    const { resolveAgentOpencodeModel } = await import('../model.js');
    (resolveAgentOpencodeModel as any).mockReturnValueOnce({ providerID: 'mystery', modelID: 'm' });
    expect(() => buildChildSandboxProfile({ agent: agent(), task, cwd: '/clone', editAllowed: false, proxy: fakeProxy() })).toThrow(/PROVIDER_EGRESS_HOSTS/);
  });
});

describe('buildChildSandboxProfile env pruning', () => {
  it('carries base vars + HOME/XDG + proxy + the route provider key, and DROPS orchestrator secrets', () => {
    const p = buildChildSandboxProfile({ agent: agent(), task, cwd: '/clone', editAllowed: true, proxy: fakeProxy() });
    expect(p.env.OPENROUTER_API_KEY).toBe('sk-or');
    expect(p.env.HOME).toBe(agentHomeDir('t1', 'backend'));
    expect(p.env.XDG_DATA_HOME).toBe(agentHomeDir('t1', 'backend'));
    expect(p.env.HTTPS_PROXY).toContain('127.0.0.1');
    expect(p.env.NO_PROXY).toContain('127.0.0.1');
    expect(p.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(p.env.GITLAB_TOKEN).toBeUndefined();
  });
});

describe('mount derivation + one-shot', () => {
  it('derives ro/rw/deny binds from agent.sandbox and adds cwd/.opencode + home to rw', () => {
    const p = buildChildSandboxProfile({ agent: agent(), task, cwd: '/clone', editAllowed: true, proxy: fakeProxy() });
    expect(p.roBinds).toContain('/ro');
    expect(p.rwBinds).toEqual(expect.arrayContaining(['/clone', '/clone/.opencode', agentHomeDir('t1', 'backend')]));
    expect(p.denyWriteRoBinds).toContain('/clone/.git/HEAD');
  });
  it('one-shot profile: provider-only allowlist, cwd == the serve root (== spawn cwd), home under root', () => {
    const root = '/wd/opencode-server/one-shot';
    const p = buildOneShotSandboxProfile({ root, homeDir: `${root}/home`, proxy: fakeProxy() });
    expect(p.allowlist).toEqual(PROVIDER_EGRESS_HOSTS['openrouter'] ?? expect.any(Array));
    // I4: profile cwd MUST equal root (the process spawn cwd in llm-one-shot),
    // and root is bound rw — homeDir lives under it, so it's covered.
    expect(p.cwd).toBe(root);
    expect(p.rwBinds).toEqual([root]);
    expect(p.homeDir).toBe(`${root}/home`);
    expect(p.env.HOME).toBe(`${root}/home`); // HOME/XDG still the home dir
  });
});

describe('computeProfileSkeleton cwd writability (C1)', () => {
  it('RO repo agent: clone is ro-only, cwd is NOT in rwBinds (so the deny cannot shadow .opencode)', () => {
    const roAgent = agent({ sandbox: { cwd: '/clone', allowReadPaths: ['/clone'], allowWritePaths: [], denyWritePaths: ['/clone'] } });
    const p = buildChildSandboxProfile({ agent: roAgent, task, cwd: '/clone', editAllowed: false, proxy: fakeProxy() });
    expect(p.roBinds).toContain('/clone');
    expect(p.rwBinds).not.toContain('/clone');
    expect(p.rwBinds).toEqual(expect.arrayContaining(['/clone/.opencode', agentHomeDir('t1', 'backend')]));
    expect(p.denyWriteRoBinds).toContain('/clone');
  });
  it('edit-mode repo agent: cwd (clone) IS in rwBinds', () => {
    const p = buildChildSandboxProfile({ agent: agent({ sandbox: { cwd: '/clone', allowReadPaths: [], allowWritePaths: [], denyWritePaths: ['/clone/.git/HEAD'] } }), task, cwd: '/clone', editAllowed: true, proxy: fakeProxy() });
    expect(p.rwBinds).toContain('/clone');
  });
  it('synthetic-root agent (no repo): cwd IS added to rwBinds even though the sandbox lists never mention it', () => {
    const synthetic = agent({ def: { repo: undefined }, sandbox: { cwd: '/synthetic', allowReadPaths: [], allowWritePaths: [], denyWritePaths: [] } });
    const p = buildChildSandboxProfile({ agent: synthetic, task, cwd: '/synthetic', editAllowed: false, proxy: fakeProxy() });
    expect(p.rwBinds).toContain('/synthetic');
  });
});

describe('repoHostEgressDomains normalization (I2)', () => {
  it('REPO_HOST unset defaults to github hosts (mirrors backends.ts resolveRepoHostKind)', () => {
    delete process.env.REPO_HOST;
    delete process.env.GITLAB_BASE_URL;
    const p = buildChildSandboxProfile({ agent: agent(), task, cwd: '/clone', editAllowed: false, proxy: fakeProxy() });
    expect(p.allowlist).toEqual(expect.arrayContaining(['github.com', 'api.github.com', 'codeload.github.com']));
    expect(p.allowlist).not.toContain('gitlab.walli.com');
  });
  it('mixed-case "GitHub" still resolves to the github hosts (trim + lowercase)', () => {
    process.env.REPO_HOST = 'GitHub';
    delete process.env.GITLAB_BASE_URL;
    const p = buildChildSandboxProfile({ agent: agent(), task, cwd: '/clone', editAllowed: false, proxy: fakeProxy() });
    expect(p.allowlist).toContain('github.com');
  });
  it('mixed-case "GitLab" + GITLAB_BASE_URL resolves to the gitlab base host', () => {
    process.env.REPO_HOST = 'GitLab';
    process.env.GITLAB_BASE_URL = 'https://gitlab.walli.com';
    const p = buildChildSandboxProfile({ agent: agent(), task, cwd: '/clone', editAllowed: false, proxy: fakeProxy() });
    expect(p.allowlist).toContain('gitlab.walli.com');
    expect(p.allowlist).not.toContain('github.com');
  });
});
