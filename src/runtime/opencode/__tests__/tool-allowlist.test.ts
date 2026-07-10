import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../system/plugin-loader.js', () => ({ getRootMcpConfig: vi.fn() }));

import { buildToolAllowlist } from '../tool-allowlist.js';
import { getRootMcpConfig } from '../../../system/plugin-loader.js';

const agent = (mcpServers: Record<string, any>) => ({ def: { id: 'a', mcpServers } } as any);

describe('buildToolAllowlist', () => {
  it('DISABLES external servers the agent did not declare (denylist; unlisted stay on)', () => {
    (getRootMcpConfig as any).mockReturnValue({ servers: { jira: {}, rollbar: {}, notion: {} } });
    const out = buildToolAllowlist(agent({ jira: {} })); // agent only has jira
    expect(out).toEqual({ 'rollbar*': false, 'notion*': false });
    expect(out['jira*']).toBeUndefined(); // its own server left untouched (stays on)
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
