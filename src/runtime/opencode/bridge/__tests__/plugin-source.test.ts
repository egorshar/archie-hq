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
  const makeSchema = (kind: string, isOptional = false) => {
    const schema: any = { kind, isOptional };
    schema.optional = () => makeSchema(kind, true);
    return schema;
  };
  const toolFn = (config: any) => config; // identity — just lets the test inspect config.args
  (toolFn as any).schema = {
    string: () => makeSchema('string'),
    number: () => makeSchema('number'),
    boolean: () => makeSchema('boolean'),
    any: () => makeSchema('any'),
  };
  return { tool: toolFn };
});

describe('bridge plugin source', () => {
  it('bakes the bridge url + token, uses ctx.sessionID, and targets the bridge endpoints', () => {
    const src = renderBridgePlugin('http://127.0.0.1:54321', 'tok-abc');
    expect(src).toContain('http://127.0.0.1:54321');
    expect(src).toContain('tok-abc');
    expect(src).toContain('ctx.sessionID'); // spike-confirmed accessor
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

    it('fetches /policy with the bearer token, caches per sessionID, and throws for a blocked tool', async () => {
      dir = await mkdtemp(join(tmpdir(), 'archie-bridge-plugin-guard-'));
      const src = renderBridgePlugin('http://127.0.0.1:1', 'tok-guard');
      const file = join(dir, 'plugin.mjs');
      await writeFile(file, src, 'utf8');

      const policyResponses: Record<string, unknown> = {
        'sess-ro': { readOnly: true, blockedTools: ['edit', 'write', 'bash'] },
        'sess-rw': { readOnly: false, blockedTools: [] },
      };
      const fetchMock = vi.fn(async (url: string, init?: any) => {
        if (url.includes('/tools')) return { json: async () => [] };
        if (url.includes('/policy')) {
          const sid = new URL(url).searchParams.get('sessionId')!;
          return { json: async () => policyResponses[sid], _init: init };
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
        'read-only mode: edit is not permitted',
      );
      // A non-blocked tool in the same RO session does not throw.
      await expect(before({ tool: 'read', sessionID: 'sess-ro' }, {})).resolves.toBeUndefined();
      // An edit-mode session's blockedTools is empty, so edit is allowed.
      await expect(before({ tool: 'edit', sessionID: 'sess-rw' }, {})).resolves.toBeUndefined();

      const policyCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/policy'));
      // Two distinct sessionIDs → two policy fetches, despite 3 guard invocations (caching).
      expect(policyCalls.length).toBe(2);
      const [policyUrl, policyInit] = policyCalls[0];
      expect(String(policyUrl)).toContain('/policy?sessionId=');
      expect((policyInit as any).headers.authorization).toBe('Bearer tok-guard');

      vi.unstubAllGlobals();
    });

    it('fails open (does not throw) when the policy fetch itself errors', async () => {
      dir = await mkdtemp(join(tmpdir(), 'archie-bridge-plugin-guard-err-'));
      const src = renderBridgePlugin('http://127.0.0.1:1', 'tok');
      const file = join(dir, 'plugin.mjs');
      await writeFile(file, src, 'utf8');

      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('/tools')) return { json: async () => [] };
        throw new Error('network down');
      });
      vi.stubGlobal('fetch', fetchMock);

      const mod = await import(pathToFileURL(file).href);
      const plugin = await mod.ArchieBridgePlugin({});
      const before = plugin['tool.execute.before'];

      await expect(before({ tool: 'edit', sessionID: 'sess-x' }, {})).resolves.toBeUndefined();

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
