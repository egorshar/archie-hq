import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../registry.js';
import { startBridgeServer, type BridgeHandle } from '../server.js';

function fakeSession() {
  const posted: any[] = [];
  const task: any = { taskId: 't1' };
  const agent: any = { def: { id: 'pm-agent' }, __posted: posted };
  return { task, agent, posted };
}

describe('bridge server', () => {
  let handle: BridgeHandle;
  let registry: SessionRegistry;
  beforeEach(async () => { registry = new SessionRegistry(); handle = await startBridgeServer(registry); });
  afterEach(async () => { await handle.close(); });

  it('rejects a request without the bearer token', async () => {
    const res = await fetch(`${handle.url}/tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's', tool: 'post_to_user', args: {} }) });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown session', async () => {
    const res = await fetch(`${handle.url}/tool`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` }, body: JSON.stringify({ sessionId: 'nope', tool: 'post_to_user', args: {} }) });
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/session/i);
  });

  it('rejects a non-whitelisted tool name', async () => {
    const { task, agent } = fakeSession();
    registry.set('s1', { task, agent });
    const res = await fetch(`${handle.url}/tool`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` }, body: JSON.stringify({ sessionId: 's1', tool: 'rm_rf', args: {} }) });
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/unknown tool|not permitted/i);
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'rejects prototype-chain tool name %s exactly like an unknown tool',
    async (toolName) => {
      const { task, agent } = fakeSession();
      registry.set('s1', { task, agent });
      const res = await fetch(`${handle.url}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ sessionId: 's1', tool: toolName, args: {} }),
      });
      const body: any = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/unknown tool|not permitted/i);
    },
  );

  it('rejects a null JSON body with a clean 400 instead of throwing', async () => {
    const res = await fetch(`${handle.url}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: 'null',
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
  });

  it('rejects a non-object JSON body (array) with a clean error, not ok:true', async () => {
    const res = await fetch(`${handle.url}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: '[1,2,3]',
    });
    const body: any = await res.json();
    expect(body.ok).toBe(false);
  });

  it('rejects an oversized body instead of buffering it unbounded', async () => {
    const hugeArg = 'x'.repeat(2 * 1024 * 1024); // 2 MB, over the 1 MB cap
    const res = await fetch(`${handle.url}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ sessionId: 's1', tool: 'post_to_user', args: { message: hugeArg } }),
    });
    expect(res.status).toBe(413);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
  });

  it('binds to loopback only', () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('returns the tool result as an unwrapped string, not a ToolResult object', async () => {
    // A task with isActive:false makes reportCompletionHandler short-circuit
    // on its very first branch, returning a plain
    // `{ content: [{ type: 'text', text }] }` ToolResult without touching
    // anything else on the stub — a minimal, real exercise of the unwrap.
    const task: any = { taskId: 't1', isActive: false };
    const agent: any = { def: { id: 'pm-agent' } };
    registry.set('s1', { task, agent });
    const res = await fetch(`${handle.url}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ sessionId: 's1', tool: 'report_completion', args: {} }),
    });
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.result).toBe('string');
    expect(body.result).toBe('Task already completed. End your turn.');
  });

  describe('GET /tools', () => {
    it('rejects a request without the bearer token', async () => {
      const res = await fetch(`${handle.url}/tools`);
      expect(res.status).toBe(401);
    });

    it('returns the manifest with a valid bearer token', async () => {
      const res = await fetch(`${handle.url}/tools`, { headers: { authorization: `Bearer ${handle.token}` } });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.some((t: any) => t.name === 'post_to_user')).toBe(true);
    });
  });
});
