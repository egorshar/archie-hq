import { describe, it, expect, vi } from 'vitest';
import { handleOpencodeEvent } from '../events.js';
import { SessionRegistry } from '../bridge/registry.js';

function registryWith(sessionId: string) {
  const reg = new SessionRegistry();
  const noteActivity = vi.fn();
  const task = { noteActivity } as any;
  const agent = { def: { id: 'backend-agent' } } as any;
  reg.set(sessionId, { task, agent, readOnly: false });
  return { reg, noteActivity };
}

describe('handleOpencodeEvent', () => {
  it('routes a tool part to noteActivity with the agent id + tool name', () => {
    const { reg, noteActivity } = registryWith('S1');
    handleOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 'S1', tool: 'read', state: { input: { filePath: 'a.ts' } } } } },
      reg,
    );
    expect(noteActivity).toHaveBeenCalledWith('backend-agent', 'read', { filePath: 'a.ts' });
  });

  it('prefixes bridged repo-tool bare names to the mcp__repo-tools__ form', () => {
    const { reg, noteActivity } = registryWith('S1');
    handleOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 'S1', tool: 'push_branch', state: {} } } },
      reg,
    );
    expect(noteActivity).toHaveBeenCalledWith('backend-agent', 'mcp__repo-tools__push_branch', {});
  });

  it('prefixes every repo tool derived from REPO_TOOL_SPECS (anti-drift, e.g. code-scanning)', () => {
    const { reg, noteActivity } = registryWith('S1');
    handleOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 'S1', tool: 'list_code_scanning_alerts', state: {} } } },
      reg,
    );
    expect(noteActivity).toHaveBeenCalledWith('backend-agent', 'mcp__repo-tools__list_code_scanning_alerts', {});
  });

  it('ignores events for unknown sessions', () => {
    const { reg, noteActivity } = registryWith('S1');
    handleOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 'OTHER', tool: 'read', state: {} } } },
      reg,
    );
    expect(noteActivity).not.toHaveBeenCalled();
  });

  it('ignores non-tool parts and session.idle (no throw, no note)', () => {
    const { reg, noteActivity } = registryWith('S1');
    expect(() => handleOpencodeEvent({ type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'S1', text: 'hi' } } }, reg)).not.toThrow();
    expect(() => handleOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'S1' } }, reg)).not.toThrow();
    expect(noteActivity).not.toHaveBeenCalled();
  });

  it('never throws on a malformed event', () => {
    const { reg } = registryWith('S1');
    expect(() => handleOpencodeEvent(null, reg)).not.toThrow();
    expect(() => handleOpencodeEvent({}, reg)).not.toThrow();
    expect(() => handleOpencodeEvent({ type: 'message.part.updated' }, reg)).not.toThrow();
  });
});
