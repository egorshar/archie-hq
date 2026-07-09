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

  it('binds to loopback only', () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});
