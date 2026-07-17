/**
 * Regression test for the merge-disabled manifest gap: `createRepoToolHandlers`
 * / `createRepoToolsMcpServer` (src/agents/tools.ts) already dropped
 * `merge_pull_request` from the dispatch handler map when
 * `ARCHIE_DISABLE_MERGE` is set, but the opencode bridge's `GET /tools`
 * manifest (src/runtime/opencode/bridge/server.ts, `getRepoToolDescriptors`)
 * used to build its descriptor list from the RAW `REPO_TOOL_SPECS` instead of
 * the filtered `activeRepoToolSpecs()`. That meant an opencode agent still SAW
 * `merge_pull_request` advertised even when merge was disabled, and calling it
 * would then be rejected by dispatch — an inconsistent, confusing surface.
 *
 * `getRepoToolDescriptors` caches its result in a module-level variable
 * (`isMergeDisabled()` reads a boot-constant env var, so caching is safe for
 * the process lifetime — see the comment above it in server.ts). That caching
 * means the two cases below (`ARCHIE_DISABLE_MERGE` set vs. unset) must each
 * run against a FRESH module instance, or the second case would just observe
 * the first case's cached descriptors. `vi.resetModules()` + a dynamic
 * `import('../server.js')` per test gives each case its own module registry.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { activeRepoToolSpecs } from '../../../../agents/tools.js';

const KEY = 'ARCHIE_DISABLE_MERGE';

afterEach(() => {
  delete process.env[KEY];
});

describe('opencode bridge /tools manifest — merge-disabled filtering', () => {
  it('activeRepoToolSpecs() includes merge_pull_request when merge is not disabled', () => {
    delete process.env[KEY];
    expect(activeRepoToolSpecs().some((s) => s.name === 'merge_pull_request')).toBe(true);
  });

  it('activeRepoToolSpecs() excludes merge_pull_request when ARCHIE_DISABLE_MERGE is set', () => {
    process.env[KEY] = 'true';
    expect(activeRepoToolSpecs().some((s) => s.name === 'merge_pull_request')).toBe(false);
  });

  it('GET /tools includes merge_pull_request when merge is not disabled', async () => {
    delete process.env[KEY];
    vi.resetModules();
    const { SessionRegistry } = await import('../registry.js');
    const { startBridgeServer } = await import('../server.js');
    const registry = new SessionRegistry();
    const handle = await startBridgeServer(registry);
    try {
      const res = await fetch(`${handle.url}/tools`, { headers: { authorization: `Bearer ${handle.token}` } });
      const body: any = await res.json();
      expect(body.some((t: any) => t.name === 'merge_pull_request')).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('GET /tools omits merge_pull_request when ARCHIE_DISABLE_MERGE is set', async () => {
    process.env[KEY] = 'true';
    vi.resetModules();
    const { SessionRegistry } = await import('../registry.js');
    const { startBridgeServer } = await import('../server.js');
    const registry = new SessionRegistry();
    const handle = await startBridgeServer(registry);
    try {
      const res = await fetch(`${handle.url}/tools`, { headers: { authorization: `Bearer ${handle.token}` } });
      const body: any = await res.json();
      expect(body.some((t: any) => t.name === 'merge_pull_request')).toBe(false);
      // Sanity: other repo tools are still advertised — only merge is dropped.
      expect(body.some((t: any) => t.name === 'push_branch')).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
