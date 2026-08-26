/**
 * `decideToolCall` — the gate's verdict in terms no runtime's hook shape leaks into.
 *
 * The Claude PreToolUse hook and the opencode `tool.execute.before` guard both reach
 * their answer here, so this is where the decision semantics are pinned; each adapter's
 * own tests cover only the mapping into its host's shape.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  decideToolCall,
  type McpToolPolicy,
  type McpServerPolicy,
  type ToolApprovalPort,
} from '../tool-approval-gate.js';

const TRAMLINE: McpServerPolicy = {
  default: 'ask',
  tiers: { list_apps: 'allow', start_release: 'deny' },
  titles: {},
};
const POLICY: McpToolPolicy = { tramline: TRAMLINE };
const tool = (action: string) => `mcp__tramline__${action}`;

function makePort(over: Partial<ToolApprovalPort> = {}): ToolApprovalPort {
  return {
    consumeApproval: vi.fn().mockReturnValue(false),
    requestApproval: vi.fn().mockResolvedValue('posted'),
    ...over,
  };
}

const refusal = (d: Awaited<ReturnType<typeof decideToolCall>>) =>
  d.allow ? '' : d.reason;

describe('decideToolCall', () => {
  it('allows a tool no policy manages', async () => {
    const port = makePort();

    expect(await decideToolCall(POLICY, port, 'Read', {})).toEqual({ allow: true });
    expect(port.requestApproval).not.toHaveBeenCalled();
  });

  it('allows an allow-tiered tool without asking anyone', async () => {
    const port = makePort();

    expect(await decideToolCall(POLICY, port, tool('list_apps'), { q: 'x' })).toEqual({ allow: true });
    expect(port.requestApproval).not.toHaveBeenCalled();
  });

  it('refuses a deny-tiered tool and says nothing ran', async () => {
    const port = makePort();

    const d = await decideToolCall(POLICY, port, tool('start_release'), {});

    expect(d.allow).toBe(false);
    expect(refusal(d)).toContain('Nothing ran');
    expect(port.requestApproval).not.toHaveBeenCalled();
  });

  it('spends a stored grant for an ask-tiered call and lets it through', async () => {
    const port = makePort({ consumeApproval: vi.fn().mockResolvedValue(true) });

    expect(await decideToolCall(POLICY, port, tool('fully_release_rollout'), { a: 1 })).toEqual({ allow: true });
    expect(port.requestApproval).not.toHaveBeenCalled();
  });

  it('requests approval and refuses this attempt when no grant is stored', async () => {
    const port = makePort();

    const d = await decideToolCall(POLICY, port, tool('fully_release_rollout'), { a: 1 });

    expect(port.requestApproval).toHaveBeenCalledTimes(1);
    expect(refusal(d)).toContain('needs human approval');
  });

  it('refuses with the queue message when another request is already pending', async () => {
    const port = makePort({ requestApproval: vi.fn().mockResolvedValue('already-pending') });

    const d = await decideToolCall(POLICY, port, tool('fully_release_rollout'), {});

    expect(refusal(d)).toContain('already waiting for approval');
  });

  // Fail-closed lives here rather than in either adapter: the arguments are
  // agent-controlled, so this path is reachable on purpose, and a runtime that
  // forgot to wrap the call would otherwise be an open door.
  it('refuses when the gate itself errors, rather than letting the call through', async () => {
    const port = makePort({
      consumeApproval: vi.fn(() => { throw new Error('vault unreachable'); }),
    });

    const d = await decideToolCall(POLICY, port, tool('fully_release_rollout'), {});

    expect(d.allow).toBe(false);
    expect(refusal(d)).toContain('vault unreachable');
    expect(refusal(d)).toContain('Nothing ran');
  });
});
