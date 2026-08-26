import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../system/plugin-loader.js', () => ({
  getRootMcpConfig: vi.fn(),
}));
vi.mock('../../../system/oauth/inject.js', () => ({
  applyOAuthBindings: vi.fn(async () => ({ injected: [], dropped: [] })),
}));

import { buildOpencodeMcpConfig } from '../mcp-config.js';
import { getRootMcpConfig } from '../../../system/plugin-loader.js';

describe('buildOpencodeMcpConfig', () => {
  it('translates an http server to a remote entry, carrying headers', async () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: {
      jira: { type: 'http', url: 'https://mcp.example/jira', headers: { 'X-A': '1' } },
    }});
    const cfg = await buildOpencodeMcpConfig();
    expect(cfg.jira).toEqual({ type: 'remote', url: 'https://mcp.example/jira', headers: { 'X-A': '1' } });
  });

  it('translates an sse server to a remote entry', async () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: {
      roll: { type: 'sse', url: 'https://mcp.example/roll' },
    }});
    const cfg = await buildOpencodeMcpConfig();
    expect(cfg.roll).toEqual({ type: 'remote', url: 'https://mcp.example/roll' });
  });

  it('translates a stdio server to a local entry (command + env)', async () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: {
      fs: { type: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], env: { ROOT: '/x' } },
    }});
    const cfg = await buildOpencodeMcpConfig();
    expect(cfg.fs).toEqual({ type: 'local', command: ['npx', '-y', 'fs-mcp'], environment: { ROOT: '/x' } });
  });

  // `type` is optional in the MCP stdio form, and the Claude SDK treats any entry
  // carrying a `command` as stdio. Plugin authors write it that way — the shipped
  // gatecheck fixture does — and dropping it left those servers silently absent on
  // opencode while working fine on the other runtime.
  it('treats a command-bearing entry with no type as stdio, the way the Claude path does', async () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: {
      gatecheck: { command: 'node', args: ['/workdir/plugins/gatecheck/server.mjs'] },
    }});

    const cfg = await buildOpencodeMcpConfig();

    expect(cfg.gatecheck).toEqual({ type: 'local', command: ['node', '/workdir/plugins/gatecheck/server.mjs'] });
  });

  it('still skips a typeless entry that carries no command either', async () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: { bad: { description: 'nothing runnable' } } });

    const cfg = await buildOpencodeMcpConfig();

    expect(cfg.bad).toBeUndefined();
  });

  it('skips a malformed entry without throwing', async () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: { bad: { type: 'nonsense' }, ok: { type: 'sse', url: 'u' } } });
    const cfg = await buildOpencodeMcpConfig();
    expect(cfg.bad).toBeUndefined();
    expect(cfg.ok).toBeDefined();
  });

  it('returns {} when there are no servers', async () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: {} });
    expect(await buildOpencodeMcpConfig()).toEqual({});
  });
});
