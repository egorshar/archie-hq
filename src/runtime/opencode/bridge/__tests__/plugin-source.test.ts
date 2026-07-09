import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderBridgePlugin, writeBridgePlugin } from '../plugin-source.js';

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
