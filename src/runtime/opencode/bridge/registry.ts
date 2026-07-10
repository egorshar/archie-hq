/**
 * Session registry for the opencode tool bridge.
 *
 * Maps an opencode session id to the live Archie `Task`/`Agent` pair the
 * bridge should dispatch control-tool calls against. Map-backed; no
 * persistence — entries live only as long as the process (and the mapped
 * agent spawn) does.
 */
import type { Task } from '../../../tasks/task.js';
import type { Agent } from '../../../agents/agent.js';

export interface BridgeSession {
  task: Task;
  agent: Agent;
  /**
   * Whether this session is restricted to read-only tool use. Derived at
   * spawn time from the repo agent's edit mode; the bridge's `/policy` endpoint
   * surfaces this to the opencode plugin guard so it can block write-shaped
   * built-in tools.
   */
  readOnly: boolean;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, BridgeSession>();

  set(sessionId: string, session: BridgeSession): void {
    this.sessions.set(sessionId, session);
  }

  get(sessionId: string): BridgeSession | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
