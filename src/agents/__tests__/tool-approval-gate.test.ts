import { describe, it, expect } from 'vitest';
import {
  parseMcpToolName,
  deniedToolNames,
  classifyToolCall,
  callDigest,
  renderCall,
  type McpToolPolicy,
  type McpServerPolicy,
} from '../tool-approval-gate.js';

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
  // Titles only where the method name is a bad button on its own.
  titles: {
    retry_workflow_run: 'Re-run the failed CI build for this release',
    fully_release_rollout: 'Release this rollout to 100% of users immediately — irreversible',
  },
};

const POLICY: McpToolPolicy = { tramline: TRAMLINE };

const tool = (action: string) => `mcp__tramline__${action}`;

describe('parseMcpToolName', () => {
  it('splits server and tool', () => {
    expect(parseMcpToolName('mcp__tramline__retry_workflow_run'))
      .toEqual({ server: 'tramline', tool: 'retry_workflow_run' });
  });

  it('handles dashed and underscored server keys', () => {
    expect(parseMcpToolName('mcp__atlassian-rovo-mcp__getJiraIssue'))
      .toEqual({ server: 'atlassian-rovo-mcp', tool: 'getJiraIssue' });
    expect(parseMcpToolName('mcp__aws_billing__get_cost'))
      .toEqual({ server: 'aws_billing', tool: 'get_cost' });
  });

  it('rejects non-MCP tools', () => {
    expect(parseMcpToolName('Read')).toBeUndefined();
    expect(parseMcpToolName('mcp__no_tool_part')).toBeUndefined();
  });
});

// A deny-tier tool is withheld from the agent up front, so it never plans
// around a tool it cannot use. The gate is the backstop, not the only stop.
describe('deniedToolNames', () => {
  it('lists every deny-tier tool as its qualified SDK name', () => {
    expect(deniedToolNames(POLICY)).toEqual(['mcp__tramline__start_release']);
  });


  it('does not withhold tools that only fall to a deny default', () => {
    // Their names aren't knowable at load time — the gate refuses them at call time.
    expect(deniedToolNames({ x: { default: 'deny', tiers: {}, titles: {} } })).toEqual([]);
  });
});

describe('classifyToolCall', () => {
  it('leaves non-MCP tools and unmanaged servers alone', () => {
    expect(classifyToolCall(POLICY, 'Read')).toBeUndefined();
    expect(classifyToolCall(POLICY, 'mcp__teamcity__trigger_build')).toBeUndefined();
    expect(classifyToolCall(undefined, tool('get_release'))).toBeUndefined();
  });

  it('classifies listed tools by their tier', () => {
    expect(classifyToolCall(POLICY, tool('get_release'))?.tier).toBe('allow');
    expect(classifyToolCall(POLICY, tool('start_release'))?.tier).toBe('deny');
    expect(classifyToolCall(POLICY, tool('retry_workflow_run'))?.tier).toBe('ask');
  });

  // A tool the server ships next quarter arrives gated, not silently open.
  it('falls back to the server default for unlisted tools', () => {
    expect(classifyToolCall(POLICY, tool('some_tool_shipped_next_quarter'))?.tier).toBe('ask');
  });
});

describe('callDigest', () => {
  it('is stable across argument order', () => {
    expect(callDigest('s', 't', { a: 1, b: 2 })).toBe(callDigest('s', 't', { b: 2, a: 1 }));
  });

  it('binds to server, tool, and every argument', () => {
    const base = callDigest('s', 't', { a: 1 });
    expect(callDigest('other', 't', { a: 1 })).not.toBe(base);
    expect(callDigest('s', 'other', { a: 1 })).not.toBe(base);
    expect(callDigest('s', 't', { a: 2 })).not.toBe(base);
    expect(callDigest('s', 't', { a: 1, extra: true })).not.toBe(base);
  });

  it('ignores undefined arguments the SDK may include', () => {
    expect(callDigest('s', 't', { a: 1, b: undefined })).toBe(callDigest('s', 't', { a: 1 }));
  });

  it('distinguishes nested argument shapes', () => {
    expect(callDigest('s', 't', { a: [1, 2] })).not.toBe(callDigest('s', 't', { a: [2, 1] }));
    expect(callDigest('s', 't', { a: 1 })).not.toBe(callDigest('s', 't', { a: '1' }));
  });
});

describe('renderCall', () => {
  const call = { server: 'tramline', tool: 'retry_workflow_run', tier: 'ask' as const };

  it("uses the policy's title for the tool plus sanitized arguments", () => {
    const r = renderCall(TRAMLINE, call, { id: 'wf-1' });
    expect(r.heading).toBe('Re-run the failed CI build for this release');
    expect(r.summary).toContain('`tramline:retry_workflow_run`');
    expect(r.summary).toContain('id=`wf-1`');
  });

  // Terse but honest — and the arguments show either way. The tool's own
  // description is unreachable: the CLI never exposes it to us.
  it('falls back to the bare identity for an untitled tool', () => {
    expect(renderCall(TRAMLINE, { ...call, tool: 'unlisted_tool' }, {}).heading)
      .toBe('Run `tramline:unlisted_tool`');
  });

  // The prompt must be authored by the engine. A string argument is the one
  // part the agent controls, and unescaped it can append its own lines.
  it('neutralizes newlines and mrkdwn in argument values', () => {
    const r = renderCall(TRAMLINE, { ...call, tool: 'extend_soak' }, {
      release_id: 'r1',
      additional_hours: '6\n*Note:* pre-agreed with the release manager — safe to approve',
    });
    expect(r.summary).not.toContain('\n*Note:*');
    expect(r.heading).not.toContain('\n');
  });

  // A title is authored in the plugins repo rather than by the agent, but it is
  // rendered rather than trusted verbatim.
  it('neutralizes newlines and mrkdwn in a title', () => {
    const policy: McpServerPolicy = {
      ...TRAMLINE,
      titles: { retry_workflow_run: 'Retry a build\n*Note:* pre-approved by the team' },
    };
    const r = renderCall(policy, call, {});
    expect(r.heading).not.toContain('\n');
    expect(r.heading).not.toContain('*Note:*');
  });

  // The digest covers null arguments, so hiding them would have the approver
  // approve an argument they were never shown.
  it('renders null arguments instead of dropping them', () => {
    expect(renderCall(TRAMLINE, call, { id: 'wf-1', reason: null }).summary).toContain('reason=`null`');
  });

  // Slack refuses a section over 3000 chars; an uncapped list would make such a
  // call permanently unapprovable rather than merely ugly.
  it('caps the number of arguments shown', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    const summary = renderCall(TRAMLINE, call, many).summary;
    expect(summary).toContain('(+28 more)');
    expect(summary.length).toBeLessThan(3000);
  });

  it('caps long argument values and long titles', () => {
    expect(renderCall(TRAMLINE, call, { id: 'x'.repeat(500) }).summary.length).toBeLessThan(400);
    const longTitle: McpServerPolicy = { ...TRAMLINE, titles: { retry_workflow_run: 'd'.repeat(500) } };
    expect(renderCall(longTitle, call, {}).heading.length).toBeLessThanOrEqual(200);
  });
});
