/**
 * Real-fs check that a plugins refresh actually updates the embedded serve
 * root's staged skills: restageOpencodeSkills() (via the real skills.ts +
 * skill-linking.ts) must add new skills, drop removed ones, and re-point
 * modified ones — the bug this fix closes (boot staged once; a later plugins
 * push left the native `skill` tool serving stale contents).
 *
 * Only the vendor boundary (embedded server + bridge) and the two data sources
 * (WORKDIR, the agent registry) are mocked; skills.ts + skill-linking.ts run
 * for real against temp dirs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const startEmbeddedServer = vi.fn();
const prepareServeRoot = vi.fn(async () => {});
vi.mock('../embedded-server.js', () => ({ startEmbeddedServer, prepareServeRoot }));
vi.mock('../bridge/plugin-source.js', () => ({ writeBridgePlugin: vi.fn(async () => '/x') }));
vi.mock('../bridge/server.js', () => ({
  startBridgeServer: vi.fn(async () => ({ url: 'http://127.0.0.1:1', token: 't', close: vi.fn(async () => {}) })),
}));
vi.mock('../model.js', () => ({ resolveOpencodeModel: vi.fn(() => ({ providerID: 'anthropic', modelID: 'opus' })) }));
vi.mock('../mcp-config.js', () => ({ buildOpencodeMcpConfig: vi.fn(async () => ({})) }));

const WORKDIR = { v: '' };
vi.mock('../../../system/workdir.js', () => ({
  get WORKDIR() { return WORKDIR.v; },
  getPluginsHeadInfo: async () => null,
}));

const getAllAgentDefs = vi.fn();
vi.mock('../../../agents/registry.js', () => ({ getAllAgentDefs }));

async function writeSkill(root: string, name: string, content: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, 'SKILL.md'), content);
}

describe('restageOpencodeSkills (real fs) reflects the new skill set after a refresh', () => {
  let tmp: string;
  let skillsDir: string;

  beforeEach(async () => {
    vi.resetModules();
    startEmbeddedServer.mockReset();
    startEmbeddedServer.mockResolvedValue({ client: { session: {} }, close: vi.fn() });
    getAllAgentDefs.mockReset();
    tmp = await mkdtemp(join(tmpdir(), 'archie-restage-'));
    WORKDIR.v = tmp;
    skillsDir = join(tmp, 'opencode-server', '.opencode', 'skills');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('adds new skills, removes deleted ones, and re-points modified ones', async () => {
    const srcOld = join(tmp, 'src-old');
    await writeSkill(srcOld, 'alpha', 'v1');
    await writeSkill(srcOld, 'gone', 'bye');
    const srcNew = join(tmp, 'src-new');
    await writeSkill(srcNew, 'alpha', 'v2'); // same name, changed content
    await writeSkill(srcNew, 'beta', 'new'); // added

    getAllAgentDefs.mockReturnValue([{ skillsPath: srcOld }]);
    const { getOpencodeClient, restageOpencodeSkills } = await import('../server.js');

    // Boot stages the OLD set into the serve root.
    await getOpencodeClient();
    expect((await readdir(skillsDir)).sort()).toEqual(['alpha', 'gone']);
    expect(await readFile(join(skillsDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('v1');

    // Plugins move → the registry now yields the NEW set. Re-stage.
    getAllAgentDefs.mockReturnValue([{ skillsPath: srcNew }]);
    await restageOpencodeSkills();

    expect((await readdir(skillsDir)).sort()).toEqual(['alpha', 'beta']); // beta added, gone removed
    expect(existsSync(join(skillsDir, 'gone'))).toBe(false);
    expect(await readFile(join(skillsDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('v2'); // re-pointed to new source
  });
});
