import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../system/plugin-loader.js', () => ({ getRootMcpConfig: vi.fn() }));

import { buildToolAllowlist } from '../tool-allowlist.js';
import { getRootMcpConfig } from '../../../system/plugin-loader.js';

const agent = (mcpServers: Record<string, any>, mcpPolicy?: Record<string, any>) =>
  ({ def: { id: 'a', mcpServers, mcpPolicy } } as any);

describe('buildToolAllowlist', () => {
  it('DISABLES external servers the agent did not declare (denylist; unlisted stay on)', () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: { jira: {}, rollbar: {}, notion: {} } });
    const out = buildToolAllowlist(agent({ jira: {} })); // agent only has jira
    expect(out).toEqual({ 'rollbar_*': false, 'notion_*': false });
    expect(out['jira_*']).toBeUndefined(); // its own server left untouched (stays on)
  });
  it('uses the <server>_* form so a deny key cannot collide with a prefix-overlapping declared server', () => {
    // MCP tools are named <server>_<tool> and body.tools globs are raw prefix
    // matches — a bare `jira*` would ALSO disable declared `jira-cloud`'s tools
    // (`jira-cloud_foo` starts with `jira`). The `_` separator prevents that.
    (getRootMcpConfig as any).mockReturnValue({ servers: { jira: {}, 'jira-cloud': {} } });
    const out = buildToolAllowlist(agent({ 'jira-cloud': {} })); // agent only has jira-cloud
    expect(out).toEqual({ 'jira_*': false }); // disables non-declared jira only
    // No bare-prefix key that would match jira-cloud's tools (jira-cloud_foo).
    expect(out['jira*']).toBeUndefined();
    expect(out['jira-cloud*']).toBeUndefined();
    expect(out['jira-cloud_*']).toBeUndefined();
  });
  it('returns {} when the agent already has every external server', () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: { jira: {} } });
    expect(buildToolAllowlist(agent({ jira: {} }))).toEqual({});
  });
  it('returns {} when there are no external servers at all', () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: {} });
    expect(buildToolAllowlist(agent({}))).toEqual({});
  });

  // The Claude path withholds `deny`-tiered tools up front via `disallowedTools`;
  // opencode's equivalent is this denylist. Without it a denied tool is only
  // refused at call time, and a server that adds one later is never withheld.
  it('withholds deny-tiered tools of a server the agent DID declare', () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: { jira: {} } });

    const out = buildToolAllowlist(agent(
      { jira: {} },
      { jira: { default: 'allow', tiers: { delete_issue: 'deny' }, titles: {} } },
    ));

    expect(out['jira_delete_issue']).toBe(false);
    expect(out['jira_*']).toBeUndefined();
  });

  it('leaves ask-tiered and allow-tiered tools on, so the call-time gate can see them', () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: { jira: {} } });

    const out = buildToolAllowlist(agent(
      { jira: {} },
      { jira: { default: 'ask', tiers: { search: 'allow', create: 'ask' }, titles: {} } },
    ));

    expect(out['jira_search']).toBeUndefined();
    expect(out['jira_create']).toBeUndefined();
  });

  // A `deny` DEFAULT is not withheld — the same rule the Claude path follows in
  // `deniedToolNames`: only listed tools can be named up front, and the gate
  // refuses whatever else arrives under the default.
  it('does not withhold tools that only fall to a deny default', () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: { jira: {} } });

    const out = buildToolAllowlist(agent(
      { jira: {} },
      { jira: { default: 'deny', tiers: {}, titles: {} } },
    ));

    expect(out).toEqual({});
  });
});
