import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../system/plugin-loader.js', () => ({ getRootMcpConfig: vi.fn() }));

import { buildToolAllowlist } from '../tool-allowlist.js';
import { getRootMcpConfig } from '../../../system/plugin-loader.js';

const agent = (mcpServers: Record<string, any>) => ({ def: { id: 'a', mcpServers } } as any);

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
});
