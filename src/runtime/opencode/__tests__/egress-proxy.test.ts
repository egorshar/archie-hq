import { describe, it, expect, afterEach } from 'vitest';
import { connect } from 'node:net';
import { getEgressProxy, closeEgressProxy, hostAllowed, type EgressProxyHandle } from '../egress-proxy.js';

afterEach(() => closeEgressProxy());

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

  it('getEgressProxy is a singleton; closeEgressProxy lets a later call re-open', async () => {
    const p1 = await getEgressProxy();
    const p2 = await getEgressProxy();
    expect(p1).toBe(p2);
    await closeEgressProxy();
    const p3 = await getEgressProxy();
    expect(p3).not.toBe(p1);
  });
});
