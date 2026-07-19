/**
 * syncPlugins wiring: after the registry rebuild it invokes the active runtime's
 * onPluginsRefreshed() hook (opencode re-stages skills), the claude runtime
 * omits the method so it's a no-op, and the whole thing stays a no-op when the
 * plugins HEAD did not move.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories hoist above these consts; create the mock fns inside
// vi.hoisted so they exist when the factories run (same pattern as
// runtime.test.ts / llm-one-shot.test.ts).
const { refreshPlugins, initRegistry, getAgentRuntime } = vi.hoisted(() => ({
  refreshPlugins: vi.fn(),
  initRegistry: vi.fn(),
  getAgentRuntime: vi.fn(),
}));
vi.mock('../workdir.js', () => ({ refreshPlugins }));
vi.mock('../../agents/registry.js', () => ({ initRegistry }));
vi.mock('../backends.js', () => ({ getAgentRuntime }));

import { syncPlugins } from '../plugin-sync.js';

describe('syncPlugins', () => {
  beforeEach(() => {
    refreshPlugins.mockReset();
    initRegistry.mockReset();
    getAgentRuntime.mockReset();
  });

  it('is a no-op when refreshPlugins reports no change (unchanged HEAD)', async () => {
    refreshPlugins.mockResolvedValue(false);
    await syncPlugins();
    expect(initRegistry).not.toHaveBeenCalled();
    expect(getAgentRuntime).not.toHaveBeenCalled(); // hook never consulted
  });

  it('opencode runtime: invokes onPluginsRefreshed AFTER the registry rebuild', async () => {
    const order: string[] = [];
    refreshPlugins.mockResolvedValue(true);
    initRegistry.mockImplementation(() => { order.push('initRegistry'); });
    const onPluginsRefreshed = vi.fn(async () => { order.push('onPluginsRefreshed'); });
    getAgentRuntime.mockReturnValue({ kind: 'opencode', onPluginsRefreshed });

    await syncPlugins();

    expect(initRegistry).toHaveBeenCalledTimes(1);
    expect(onPluginsRefreshed).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['initRegistry', 'onPluginsRefreshed']); // staging sees the rebuilt registry
  });

  it('claude runtime: no onPluginsRefreshed hook is invoked (no opencode side effects)', async () => {
    refreshPlugins.mockResolvedValue(true);
    // Claude runtime omits the method entirely — the optional-call must no-op.
    getAgentRuntime.mockReturnValue({ kind: 'claude' });

    await expect(syncPlugins()).resolves.toBeUndefined();
    expect(initRegistry).toHaveBeenCalledTimes(1);
    expect(getAgentRuntime).toHaveBeenCalledTimes(1);
  });
});
