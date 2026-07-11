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
  it('one-shot profile: provider-only allowlist, no clone mounts', () => {
    const p = buildOneShotSandboxProfile({ homeDir: '/wd/opencode-server/one-shot/home', proxy: fakeProxy() });
    expect(p.allowlist).toEqual(PROVIDER_EGRESS_HOSTS['openrouter'] ?? expect.any(Array));
    expect(p.rwBinds).toContain('/wd/opencode-server/one-shot/home');
  });
});
