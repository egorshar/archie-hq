import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderBridgePlugin, writeBridgePlugin } from '../plugin-source.js';

/**
 * Minimal stand-in for `@opencode-ai/plugin`'s `tool` export, sufficient to
 * execute the generated plugin source and observe whether `schemaFor` called
 * `.optional()` on a given arg's schema.
 */
vi.mock('@opencode-ai/plugin', () => {
  const makeSchema = (props: any) => {
    const schema: any = { isOptional: false, ...props };
    schema.optional = () => makeSchema({ ...schema, isOptional: true });
    schema.describe = (description: string) => makeSchema({ ...schema, description });
    return schema;
  };
  const toolFn = (config: any) => config; // identity — just lets the test inspect config.args
  (toolFn as any).schema = {
    string: () => makeSchema({ kind: 'string' }),
    number: () => makeSchema({ kind: 'number' }),
    boolean: () => makeSchema({ kind: 'boolean' }),
    any: () => makeSchema({ kind: 'any' }),
    enum: (values: string[]) => makeSchema({ kind: 'enum', values }),
    array: (element: any) => makeSchema({ kind: 'array', element }),
    object: (shape: any) => makeSchema({ kind: 'object', shape }),
  };
  return { tool: toolFn };
});

describe('bridge plugin source', () => {
  it('bakes the bridge url + token, uses ctx.sessionID, and targets the bridge endpoints', () => {
    const src = renderBridgePlugin('http://127.0.0.1:54321', 'tok-abc');
    expect(src).toContain('http://127.0.0.1:54321');
    expect(src).toContain('tok-abc');
    expect(src).toContain('ctx.sessionID'); // opencode's session-id accessor
    expect(src).toContain('/tools'); // fetches the manifest on load
    expect(src).toContain('/tool'); // forwards execute
    expect(src).toContain('@opencode-ai/plugin');
  });

  it('never inlines a process.env read for the baked values', () => {
    const src = renderBridgePlugin('http://127.0.0.1:9', 't');
    expect(src).not.toContain('process.env');
  });

  describe('arg optionality', () => {
    let dir: string;

    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('renders .optional() for an OPTIONAL manifest arg and not for a REQUIRED one', async () => {
      dir = await mkdtemp(join(tmpdir(), 'archie-bridge-plugin-optionality-'));
      const src = renderBridgePlugin('http://127.0.0.1:1', 'tok');
      const file = join(dir, 'plugin.mjs');
      await writeFile(file, src, 'utf8');

      const fakeManifest = [
        {
          name: 'sample_tool',
          description: 'test',
          argsSchema: {
            requiredArg: { type: 'string' },
            optionalArg: { type: 'string', optional: true },
          },
        },
      ];
      const fetchMock = vi.fn(async () => ({ json: async () => fakeManifest }));
      vi.stubGlobal('fetch', fetchMock);

      const mod = await import(pathToFileURL(file).href);
      const plugin = await mod.ArchieBridgePlugin({});
      const args = plugin.tool.sample_tool.args;

      expect(args.requiredArg.isOptional).toBe(false);
      expect(args.optionalArg.isOptional).toBe(true);

      vi.unstubAllGlobals();
    });

    it('rebuilds a NESTED array-of-object arg (not flattened to any) with field types + descriptions', async () => {
      dir = await mkdtemp(join(tmpdir(), 'archie-bridge-plugin-nested-'));
      const src = renderBridgePlugin('http://127.0.0.1:1', 'tok');
      const file = join(dir, 'plugin.mjs');
      await writeFile(file, src, 'utf8');

      // Shape of spawn_repo_agent's `repos` — the arg that broke the MR flow.
      const fakeManifest = [
        {
          name: 'spawn_repo_agent',
          description: 'test',
          argsSchema: {
            shortname: { type: 'string' },
            repos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  github: { type: 'string', description: 'org/repo' },
                  baseBranch: { type: 'string', optional: true },
                },
              },
            },
          },
        },
      ];
      const fetchMock = vi.fn(async () => ({ json: async () => fakeManifest }));
      vi.stubGlobal('fetch', fetchMock);

      const mod = await import(pathToFileURL(file).href);
      const plugin = await mod.ArchieBridgePlugin({});
      const repos = plugin.tool.spawn_repo_agent.args.repos;

      expect(repos.kind).toBe('array'); // NOT 'any'
      expect(repos.element.kind).toBe('object');
      expect(repos.element.shape.github.kind).toBe('string');
      expect(repos.element.shape.github.description).toBe('org/repo');
      expect(repos.element.shape.baseBranch.isOptional).toBe(true);

      vi.unstubAllGlobals();
    });
  });

  describe('tool.execute.before RO guard', () => {
    it('rendered source references the policy endpoint, input.tool/sessionID, and the block error text', () => {
      const src = renderBridgePlugin('http://127.0.0.1:1', 'tok');
      expect(src).toContain('tool.execute.before');
      expect(src).toContain('/policy');
      expect(src).toContain('input.tool');
      expect(src).toContain('input.sessionID');
      expect(src).toContain('blockedTools');
      expect(src).toContain('read-only mode:');
    });

    let dir: string;

    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('fetches /policy with the bearer token on every call and throws for a blocked tool', async () => {
      dir = await mkdtemp(join(tmpdir(), 'archie-bridge-plugin-guard-'));
      const src = renderBridgePlugin('http://127.0.0.1:1', 'tok-guard');
      const file = join(dir, 'plugin.mjs');
      await writeFile(file, src, 'utf8');

      const policyResponses: Record<string, unknown> = {
        'sess-ro': { readOnly: true, blockedTools: ['edit', 'write', 'bash'] },
        'sess-rw': { readOnly: false, blockedTools: [] },
      };
      const fetchMock = vi.fn(async (url: string, init?: any) => {
        if (url.includes('/tools')) return { ok: true, json: async () => [] };
        if (url.includes('/policy')) {
          const sid = new URL(url).searchParams.get('sessionId')!;
          return { ok: true, json: async () => policyResponses[sid], _init: init };
        }
        throw new Error('unexpected fetch ' + url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const mod = await import(pathToFileURL(file).href);
      const plugin = await mod.ArchieBridgePlugin({});
      const before = plugin['tool.execute.before'];
      expect(typeof before).toBe('function');

      // Blocked tool in a RO session throws.
      await expect(before({ tool: 'edit', sessionID: 'sess-ro' }, {})).rejects.toThrow(
        'read-only mode: edit not permitted',
      );
      // A non-blocked tool in the same RO session does not throw.
      await expect(before({ tool: 'read', sessionID: 'sess-ro' }, {})).resolves.toBeUndefined();
      // An edit-mode session's blockedTools is empty, so edit is allowed.
      await expect(before({ tool: 'edit', sessionID: 'sess-rw' }, {})).resolves.toBeUndefined();

      const policyCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/policy'));
      // No caching: every guard invocation re-fetches /policy, so 3 guard
      // invocations means 3 policy fetches (not 2, despite only 2 distinct
      // sessionIDs).
      expect(policyCalls.length).toBe(3);
      const [policyUrl, policyInit] = policyCalls[0];
      expect(String(policyUrl)).toContain('/policy?sessionId=');
      expect((policyInit as any).headers.authorization).toBe('Bearer tok-guard');

      vi.unstubAllGlobals();
    });

    it('respects a policy change mid-session (no stale cache): edit-mode approval flips RO -> edit for the SAME sessionID', async () => {
      // Regression test for the stale per-session cache bug: the edit-mode
      // approval flow re-spawns a repo agent RESUMING THE SAME opencode
      // sessionID with readOnly flipped RO -> edit in the bridge's
      // SessionRegistry. The guard must observe that flip on the very next
      // tool.execute.before call instead of replaying a cached RO decision.
      dir = await mkdtemp(join(tmpdir(), 'archie-bridge-plugin-guard-flip-'));
      const src = renderBridgePlugin('http://127.0.0.1:1', 'tok-flip');
      const file = join(dir, 'plugin.mjs');
      await writeFile(file, src, 'utf8');

      let approved = false;
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('/tools')) return { ok: true, json: async () => [] };
        if (url.includes('/policy')) {
          return {
            ok: true,
            json: async () =>
              approved ? { readOnly: false, blockedTools: [] } : { readOnly: true, blockedTools: ['edit', 'write', 'bash'] },
          };
        }
        throw new Error('unexpected fetch ' + url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const mod = await import(pathToFileURL(file).href);
      const plugin = await mod.ArchieBridgePlugin({});
      const before = plugin['tool.execute.before'];

      const SAME_SESSION = 'sess-resumed';

      // Before approval: same sessionID, guard blocks edit.
      await expect(before({ tool: 'edit', sessionID: SAME_SESSION }, {})).rejects.toThrow(
        'read-only mode: edit not permitted',
      );

      // Edit-mode approval flips the bridge's policy for the SAME sessionID.
      approved = true;

      // Same sessionID, no re-registration/reload of the plugin: the guard
      // must now ALLOW edit, proving it re-queried /policy instead of
      // replaying a stale cached RO decision.
      await expect(before({ tool: 'edit', sessionID: SAME_SESSION }, {})).resolves.toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('fails CLOSED (blocks builtins, allows read) when the policy fetch itself errors', async () => {
      dir = await mkdtemp(join(tmpdir(), 'archie-bridge-plugin-guard-err-'));
      const src = renderBridgePlugin('http://127.0.0.1:1', 'tok');
      const file = join(dir, 'plugin.mjs');
      await writeFile(file, src, 'utf8');

      let policyShouldFail = true;
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('/tools')) return { ok: true, json: async () => [] };
        if (url.includes('/policy')) {
          if (policyShouldFail) throw new Error('network down');
          return { ok: true, json: async () => ({ readOnly: false, blockedTools: [] }) };
        }
        throw new Error('unexpected fetch ' + url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const mod = await import(pathToFileURL(file).href);
      const plugin = await mod.ArchieBridgePlugin({});
      const before = plugin['tool.execute.before'];

      // Bridge unreachable: built-in write tool is blocked (fail closed)...
      await expect(before({ tool: 'edit', sessionID: 'sess-x' }, {})).rejects.toThrow(
        'read-only mode: edit not permitted',
      );
      // ...but read tools stay allowed even while failing closed.
      await expect(before({ tool: 'read', sessionID: 'sess-x' }, {})).resolves.toBeUndefined();

      // Once the bridge recovers, the very next call re-fetches and sees the
      // real (permissive) policy — every call queries /policy fresh, so a
      // transient failure never pins the session for its remaining lifetime.
      policyShouldFail = false;
      await expect(before({ tool: 'edit', sessionID: 'sess-x' }, {})).resolves.toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('fails CLOSED on a non-2xx /policy response (e.g. 404 unknown session during a startup race)', async () => {
      dir = await mkdtemp(join(tmpdir(), 'archie-bridge-plugin-guard-404-'));
      const src = renderBridgePlugin('http://127.0.0.1:1', 'tok');
      const file = join(dir, 'plugin.mjs');
      await writeFile(file, src, 'utf8');

      let policyOk = false;
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('/tools')) return { ok: true, json: async () => [] };
        if (url.includes('/policy')) {
          if (!policyOk) return { ok: false, status: 404, json: async () => ({ ok: false, error: 'unknown session' }) };
          return { ok: true, json: async () => ({ readOnly: false, blockedTools: [] }) };
        }
        throw new Error('unexpected fetch ' + url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const mod = await import(pathToFileURL(file).href);
      const plugin = await mod.ArchieBridgePlugin({});
      const before = plugin['tool.execute.before'];

      await expect(before({ tool: 'edit', sessionID: 'sess-y' }, {})).rejects.toThrow(
        'read-only mode: edit not permitted',
      );
      await expect(before({ tool: 'read', sessionID: 'sess-y' }, {})).resolves.toBeUndefined();

      // Once the session resolves (later /policy calls return 2xx), edit is allowed.
      policyOk = true;
      await expect(before({ tool: 'edit', sessionID: 'sess-y' }, {})).resolves.toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('fails CLOSED on a malformed 2xx /policy body (missing/non-array blockedTools)', async () => {
      dir = await mkdtemp(join(tmpdir(), 'archie-bridge-plugin-guard-malformed-'));
      const src = renderBridgePlugin('http://127.0.0.1:1', 'tok');
      const file = join(dir, 'plugin.mjs');
      await writeFile(file, src, 'utf8');

      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('/tools')) return { ok: true, json: async () => [] };
        if (url.includes('/policy')) return { ok: true, json: async () => ({ readOnly: true }) }; // no blockedTools
        throw new Error('unexpected fetch ' + url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const mod = await import(pathToFileURL(file).href);
      const plugin = await mod.ArchieBridgePlugin({});
      const before = plugin['tool.execute.before'];

      await expect(before({ tool: 'edit', sessionID: 'sess-z' }, {})).rejects.toThrow(
        'read-only mode: edit not permitted',
      );

      vi.unstubAllGlobals();
    });
  });

  describe('writeBridgePlugin', () => {
    let dir: string;

    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('writes the rendered plugin into pluginsDir and returns its path', async () => {
      dir = await mkdtemp(join(tmpdir(), 'archie-bridge-plugin-'));
      const path = await writeBridgePlugin(dir, 'http://127.0.0.1:12345', 'tok-xyz');
      expect(path.startsWith(dir)).toBe(true);
      const written = await readFile(path, 'utf8');
      expect(written).toContain('http://127.0.0.1:12345');
      expect(written).toContain('tok-xyz');
    });

    it('creates pluginsDir if it does not exist yet', async () => {
      const base = await mkdtemp(join(tmpdir(), 'archie-bridge-plugin-'));
      dir = base;
      const nested = join(base, 'nested', 'plugins');
      const path = await writeBridgePlugin(nested, 'http://127.0.0.1:1', 'tok');
      const written = await readFile(path, 'utf8');
      expect(written).toContain('tok');
    });
  });
});
