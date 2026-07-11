import { describe, it, expect, afterEach, vi } from 'vitest';
import { connect } from 'node:net';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));

import { getEgressProxy, closeEgressProxy, hostAllowed, type EgressProxyHandle } from '../egress-proxy.js';
import { logger } from '../../../system/logger.js';

afterEach(() => closeEgressProxy());

/** A tiny loopback origin that echoes the request headers it received as JSON. */
function startEchoServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.headers));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

/** Absolute-URI (plain HTTP) request THROUGH the proxy; resolves the echoed headers. */
function httpVia(proxyUrl: string, cred: { username: string; password: string }, originPort: number): Promise<Record<string, string>> {
  const u = new URL(proxyUrl);
  const auth = `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: u.hostname, port: Number(u.port), method: 'GET', path: `http://127.0.0.1:${originPort}/`, headers: { host: `127.0.0.1:${originPort}`, 'proxy-authorization': auth } },
      (res) => { let body = ''; res.on('data', (d) => (body += d)); res.on('end', () => resolve(JSON.parse(body))); },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Issue a raw CONNECT through the proxy; resolve the status line. */
function connectVia(proxyUrl: string, cred: { username: string; password: string } | null, target: string): Promise<string> {
  const u = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const sock = connect(Number(u.port), u.hostname, () => {
      const auth = cred ? `Proxy-Authorization: Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString('base64')}\r\n` : '';
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n')) { resolve(buf.split('\r\n')[0]); sock.destroy(); } });
    sock.on('error', reject);
    setTimeout(() => { resolve(buf.split('\r\n')[0] || 'TIMEOUT'); sock.destroy(); }, 1000);
  });
}

describe('hostAllowed', () => {
  it('matches exact host and dot-suffix subdomains, rejects lookalikes', () => {
    expect(hostAllowed('openrouter.ai', 443, ['openrouter.ai'])).toBe(true);
    expect(hostAllowed('api.openrouter.ai', 443, ['openrouter.ai'])).toBe(true);
    expect(hostAllowed('notopenrouter.ai', 443, ['openrouter.ai'])).toBe(false);
    expect(hostAllowed('openrouter.ai.evil.com', 443, ['openrouter.ai'])).toBe(false);
  });
  it('rejects a disallowed port unless an entry pins host:port', () => {
    expect(hostAllowed('mcp.host', 8443, ['mcp.host'])).toBe(false);       // default 443/80 only
    expect(hostAllowed('mcp.host', 8443, ['mcp.host:8443'])).toBe(true);   // explicit pair
  });

  it('skips an unsupported IPv6/bracketed allowlist ENTRY with a one-time warning, never matching it', () => {
    (logger.warn as any).mockClear();
    // A bare IPv6 literal (two+ colons) and a bracketed host — both unsupported.
    expect(hostAllowed('fdya::1', 443, ['fdya::1'])).toBe(false);          // v6 literal entry skipped
    expect(hostAllowed('mcp.host', 8443, ['[fdyb::1]:8443'])).toBe(false); // bracketed entry skipped
    expect(logger.warn).toHaveBeenCalledWith('opencode', expect.stringContaining('unsupported shape'));
    // A valid entry alongside the bad one still matches (bad one skipped, not fatal).
    expect(hostAllowed('ok.host', 443, ['fdyc::1', 'ok.host'])).toBe(true);
    // Warn is once-per-distinct-entry: repeating the same bad entry does not re-warn.
    const before = (logger.warn as any).mock.calls.length;
    hostAllowed('x', 443, ['fdya::1']); // already-warned entry
    expect((logger.warn as any).mock.calls.length).toBe(before);
  });

  it('denies an IP-literal CONNECT TARGET (v4 and v6) even against a non-empty hostname allowlist', () => {
    expect(hostAllowed('203.0.113.7', 443, ['openrouter.ai', 'example.com'])).toBe(false);   // v4 target, no hostname match
    expect(hostAllowed('2001:db8::5', 443, ['openrouter.ai', 'example.com'])).toBe(false);   // v6 target, no hostname match
  });
});

describe('egress proxy CONNECT gating', () => {
  it('407s without a valid credential, allows an allowlisted host, 403s a denied host, 407s a revoked credential', async () => {
    const proxy: EgressProxyHandle = await getEgressProxy();
    const cred = proxy.mintCredential({ taskId: 't1', agentId: 'backend' }, ['example.com']);

    expect(await connectVia(proxy.url, null, 'example.com:443')).toMatch(/407/);
    // allowed host: the CONNECT is accepted (200) before the upstream dial completes/fails
    expect(await connectVia(proxy.url, cred, 'example.com:443')).toMatch(/200/);
    expect(await connectVia(proxy.url, cred, 'evil.com:443')).toMatch(/403/);

    proxy.revokeCredential(cred);
    expect(await connectVia(proxy.url, cred, 'example.com:443')).toMatch(/407/);
  });

  it('scopes allowlists per credential — child A cannot reach child B host', async () => {
    const proxy = await getEgressProxy();
    const a = proxy.mintCredential({ taskId: 't1', agentId: 'a' }, ['a-host.com']);
    const b = proxy.mintCredential({ taskId: 't1', agentId: 'b' }, ['b-host.com']);
    expect(await connectVia(proxy.url, a, 'b-host.com:443')).toMatch(/403/);
    expect(await connectVia(proxy.url, b, 'b-host.com:443')).toMatch(/200/);
  });

  it('strips the proxy-authorization credential from an allowed absolute-URI HTTP request before forwarding upstream (I1)', async () => {
    const { server, port } = await startEchoServer();
    try {
      const proxy = await getEgressProxy();
      const cred = proxy.mintCredential({ taskId: 't1', agentId: 'backend' }, [`127.0.0.1:${port}`]);
      const echoed = await httpVia(proxy.url, cred, port);
      // The origin received the forwarded request but MUST NOT see the per-child
      // proxy credential (nor the hop-by-hop proxy-connection header).
      expect(echoed['proxy-authorization']).toBeUndefined();
      expect(echoed['proxy-connection']).toBeUndefined();
      expect(echoed['host']).toBe(`127.0.0.1:${port}`); // request did reach the origin
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('getEgressProxy is a singleton; closeEgressProxy lets a later call re-open', async () => {
    const p1 = await getEgressProxy();
    const p2 = await getEgressProxy();
    expect(p1).toBe(p2);
    await closeEgressProxy();
    const p3 = await getEgressProxy();
    expect(p3).not.toBe(p1);
  });
});
