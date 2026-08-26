/**
 * The Claude adapter's mapping: PreToolUse input in, `hookSpecificOutput` out.
 *
 * The decision semantics these cases exercise belong to `decideToolCall` and are
 * pinned in `agents/__tests__/tool-approval-decide.test.ts`; what this file adds is
 * that the SDK dialect on either side of it is right — including that a gate error
 * becomes a denial rather than a thrown hook, which is what the host would otherwise
 * be left to interpret.
 */
import { describe, it, expect, vi } from 'vitest';
import { callDigest, type McpToolPolicy, type McpServerPolicy, type ToolApprovalPort } from '../../../agents/tool-approval-gate.js';
import { createToolApprovalHooks } from '../tool-approval-hooks.js';

/**
 * A realistic policy — the shape the Tramline server declares in the plugins
 * repo's .mcp.json: reads run ungated, release-lifecycle mutations are disabled
 * outright, everything else needs a human.
 */
const TRAMLINE: McpServerPolicy = {
  default: 'ask',
  tiers: {
    list_apps: 'allow',
    get_release: 'allow',
    get_release_analytics: 'allow',
    start_release: 'deny',
  },
  titles: {
    retry_workflow_run: 'Re-run the failed CI build for this release',
    fully_release_rollout: 'Release this rollout to 100% of users immediately — irreversible',
  },
};

const POLICY: McpToolPolicy = { tramline: TRAMLINE };

const tool = (action: string) => `mcp__tramline__${action}`;

async function runGate(port: Partial<ToolApprovalPort>, tool_name: string, tool_input: unknown, policy = POLICY) {
  const fullPort: ToolApprovalPort = {
    consumeApproval: () => false,
    requestApproval: async () => 'posted',
    ...port,
  };
  const [matcher] = createToolApprovalHooks(policy, fullPort);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await matcher.hooks[0]({ tool_name, tool_input } as any, undefined as any, {} as any)) as any;
}

const denialReason = (r: { hookSpecificOutput?: { permissionDecisionReason?: string } }) =>
  r.hookSpecificOutput?.permissionDecisionReason ?? '';
const isDeny = (r: { hookSpecificOutput?: { permissionDecision?: string } }) =>
  r.hookSpecificOutput?.permissionDecision === 'deny';

describe('createToolApprovalHooks', () => {
  it('lets unmanaged tools and allow-tier tools straight through', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    for (const name of ['Read', 'mcp__teamcity__list_builds', tool('get_release'), tool('list_apps')]) {
      expect(await runGate({ requestApproval }, name, {})).toEqual({ continue: true });
    }
    expect(requestApproval).not.toHaveBeenCalled();
  });

  // Belt to the disallowedTools braces: a deny-tier call that somehow reaches
  // the gate is refused without bothering a human.
  it('refuses a deny-tier call without posting an approval', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    const result = await runGate({ requestApproval }, tool('start_release'), {});
    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('disabled by the `tramline` tool policy');
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('refuses an unlisted call under a deny default', async () => {
    const policy: McpToolPolicy = { locked: { default: 'deny', tiers: {}, titles: {} } };
    const result = await runGate({}, 'mcp__locked__anything', {}, policy);
    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('cannot be run by any agent');
  });

  it('requests approval for an ask-tier call and denies this attempt', async () => {
    const requestApproval = vi.fn(
      async (_r: { digest: string; server: string; tool: string; summary: string; heading: string }) =>
        'posted' as const,
    );
    const result = await runGate({ requestApproval }, tool('retry_workflow_run'), { id: 'wf-1' });

    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('needs human approval');
    expect(requestApproval).toHaveBeenCalledTimes(1);
    const request = requestApproval.mock.calls[0][0];
    expect(request.digest).toBe(callDigest('tramline', 'retry_workflow_run', { id: 'wf-1' }));
    expect(request.heading).toBe('Re-run the failed CI build for this release');
  });


  it('raises a prompt for an untitled tool using its bare identity', async () => {
    const requestApproval = vi.fn(async (r: { heading: string }) => { void r; return 'posted' as const; });
    await runGate({ requestApproval }, tool('some_untitled_tool'), { id: 'x' });
    expect(requestApproval.mock.calls[0][0].heading).toBe('Run `tramline:some_untitled_tool`');
  });

  it('proceeds exactly once a grant for that call is spendable', async () => {
    const consumeApproval = vi.fn(() => true);
    const requestApproval = vi.fn(async () => 'posted' as const);
    const result = await runGate({ consumeApproval, requestApproval }, tool('retry_workflow_run'), { id: 'wf-1' });

    expect(result).toEqual({ continue: true });
    expect(consumeApproval).toHaveBeenCalledWith(callDigest('tramline', 'retry_workflow_run', { id: 'wf-1' }));
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('refuses a second gated call while one is pending', async () => {
    const result = await runGate({ requestApproval: async () => 'already-pending' }, tool('retry_workflow_run'), {});
    expect(isDeny(result)).toBe(true);
    expect(denialReason(result)).toContain('already waiting for approval');
  });

  // Server and tool names reach the gate as model-supplied strings, so a
  // prototype hit must not be mistaken for a policy.
  it('does not treat inherited properties as policy', async () => {
    const requestApproval = vi.fn(async () => 'posted' as const);
    expect(await runGate({ requestApproval }, 'mcp__constructor__x', {})).toEqual({ continue: true });
    expect(await runGate({ requestApproval }, tool('constructor'), {})).not.toEqual({ continue: true });
    expect(requestApproval).toHaveBeenCalledTimes(1); // the tramline one is gated, not crashed
  });

  it('waits for the spend to be durable before letting the call through', async () => {
    const order: string[] = [];
    const consumeApproval = vi.fn(() => {
      order.push('spend');
      return Promise.resolve(true).then((v) => { order.push('flushed'); return v; });
    });
    const result = await runGate({ consumeApproval }, tool('retry_workflow_run'), { id: 'wf-1' });
    expect(result).toEqual({ continue: true });
    expect(order).toEqual(['spend', 'flushed']);
  });

  describe('fails closed', () => {
    it('denies instead of throwing when an argument overflows the canonicalizer', async () => {
      let deep: unknown = 'leaf';
      for (let i = 0; i < 60_000; i++) deep = [deep];
      const result = await runGate({}, tool('retry_workflow_run'), { id: 'wf-1', junk: deep });
      expect(isDeny(result)).toBe(true);
      expect(denialReason(result)).toContain('errored while evaluating');
    });

    it('denies when the port throws', async () => {
      const result = await runGate(
        { requestApproval: async () => { throw new Error('slack down'); } },
        tool('retry_workflow_run'),
        { id: 'wf-1' },
      );
      expect(isDeny(result)).toBe(true);
      expect(denialReason(result)).toContain('slack down');
    });

    it('still lets unmanaged tools through when the port is broken', async () => {
      const broken = { consumeApproval: () => { throw new Error('boom'); } };
      expect(await runGate(broken, 'Read', { file_path: '/x' })).toEqual({ continue: true });
      expect(await runGate(broken, tool('get_release'), {})).toEqual({ continue: true });
    });
  });
});
