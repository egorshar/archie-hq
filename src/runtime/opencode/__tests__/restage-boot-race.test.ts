/**
 * Boot/re-stage race guard (server.ts). The boot path stages skills OUTSIDE the
 * `restageInFlight` serializer, and `clientPromise` is already non-null while
 * that boot staging runs — so a plugins refresh landing mid-boot used to run a
 * SECOND concurrent rm+rebuild over the same skills dir, which could interleave
 * and leave a silently PARTIAL symlink set.
 *
 * This drives that exact window with a real fs: `linkAgentSkills` runs for real
 * (via skills.ts) but its FIRST (boot) call is gated so it is still in flight
 * when `restageOpencodeSkills()` fires. We assert (a) the two staging passes ran
 * strictly SEQUENTIALLY (boot fully finished before re-stage started — no
 * interleave) and (b) the final on-disk set is COMPLETE and reflects the newest
 * plugins set. Only the vendor boundary + data sources are mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';

const startEmbeddedServer = vi.fn(async () => ({ client: { session: {} }, close: vi.fn() }));
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

// Wrap the REAL skill-linking so staging touches disk for real, but gate the
// first (boot) call and record start/end markers to prove ordering.
const race = vi.hoisted(() => {
  let releaseBoot: () => void = () => {};
  const bootGate = new Promise<void>((r) => { releaseBoot = r; });
  return { events: [] as string[], bootGate, releaseBoot, calls: { n: 0 } };
});
vi.mock('../../../agents/skill-linking.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../agents/skill-linking.js')>();
  return {
    linkAgentSkills: vi.fn(async (dir: string, sources: string[]) => {
      const n = ++race.calls.n;
      race.events.push(`start#${n}`);
      if (n === 1) await race.bootGate; // boot staging blocks here until released
      await actual.linkAgentSkills(dir, sources);
      race.events.push(`end#${n}`);
    }),
  };
});

async function writeSkill(root: string, name: string, content: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, 'SKILL.md'), content);
}

describe('boot/re-stage race guard', () => {
  let tmp = '';
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('serializes a mid-boot re-stage after boot staging and lands a complete set', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'archie-boot-race-'));
    WORKDIR.v = tmp;
    const skillsDir = join(tmp, 'opencode-server', '.opencode', 'skills');

    // Boot sees the OLD set; the mid-boot refresh will swap in the NEW set.
    const srcOld = join(tmp, 'src-old');
    await writeSkill(srcOld, 'alpha', 'v1');
    await writeSkill(srcOld, 'gone', 'bye');
    const srcNew = join(tmp, 'src-new');
    await writeSkill(srcNew, 'alpha', 'v2');
    await writeSkill(srcNew, 'beta', 'new');
    getAllAgentDefs.mockReturnValue([{ skillsPath: srcOld }]);

    const { getOpencodeClient, restageOpencodeSkills } = await import('../server.js');

    // Kick off boot but do NOT await — its stageServeRootSkills('boot') is now
    // blocked inside the gated linkAgentSkills (start#1, pre-gate).
    const bootP = getOpencodeClient();
    await vi.waitFor(() => expect(race.events).toContain('start#1'));

    // Plugins move to the NEW set; a refresh fires WHILE boot staging is stuck.
    getAllAgentDefs.mockReturnValue([{ skillsPath: srcNew }]);
    const restageP = restageOpencodeSkills();

    // Give the re-stage every chance to (wrongly) start a concurrent pass. With
    // the guard it must stay parked behind the boot promise: still only start#1.
    await new Promise((r) => setTimeout(r, 20));
    expect(race.events).toEqual(['start#1']);

    // Release boot staging; boot + the queued re-stage now run to completion.
    race.releaseBoot();
    await Promise.all([bootP, restageP]);

    // Strictly sequential: boot fully finished (start#1→end#1) before the
    // re-stage started (start#2→end#2) — no interleave.
    expect(race.events).toEqual(['start#1', 'end#1', 'start#2', 'end#2']);

    // Final on-disk set is COMPLETE and reflects the newest plugins set.
    expect((await readdir(skillsDir)).sort()).toEqual(['alpha', 'beta']);
  });
});
