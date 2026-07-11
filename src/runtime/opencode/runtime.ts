/**
 * OpencodeRuntime — the AgentRuntime backed by an embedded opencode server
 * (spec §3.3). Self-contained: it replicates the plumbing subset of spawnAgent()
 * for opencode (thin seam), reusing prepareAgentContext() for the shared launch
 * inputs. The turn primitive is `session.promptAsync` (returns immediately, HTTP
 * 204); the turn's completion is the `session.idle` SSE event, delivered via the
 * turn-completion registry that `events.ts` drives — NOT the HTTP response.
 * (This replaced the blocking `session.prompt`, whose held-open request tripped
 * undici's headers timeout on long turns.)
 */
import type { AgentRuntime } from '../../ports/agent-runtime.js';
import type { RuntimeCapabilities } from '../../ports/capabilities.js';
import { OPENCODE_RUNTIME_CAPABILITIES } from '../../ports/capabilities.js';
import type { Agent } from '../../agents/agent.js';
import type { Task } from '../../tasks/task.js';
import { prepareAgentContext } from '../../agents/spawn.js';
import { logger } from '../../system/logger.js';
import { sharedRegistry, closeBridge } from './server.js';
import { getAgentServe, scheduleIdleReap, markAllServesStale, closeServePool, evictTask, type AgentServeSpec, type ServeHandle } from './serve-pool.js';
import { closeOneShotServe } from './llm-one-shot.js';
import { closeEgressProxy } from './egress-proxy.js';
import type { OpencodeClient } from './embedded-server.js';
import { buildToolAllowlist } from './tool-allowlist.js';
import { turnCompletion } from './turn-completion.js';
import { opencodeAgentRoute, opencodeFooterModel } from './model.js';
import type { AgentDef } from '../../types/agent.js';

const SESSION_NOT_FOUND_RE = /session.*not.*found|not.*found.*session/i;

/**
 * True when an error-shaped object signals a missing session. Checks a 404
 * status, a not-found error name, and a not-found message — at the object's own
 * level and one level down under `.data.message` (opencode nests the human
 * message there). `NotFoundError` is treated as a session-not-found signal
 * because the only endpoint promptWithRecovery drives is session-scoped
 * (`session.prompt`), so a NotFoundError there is always the session.
 */
function errorSignalsNotFound(e: any): boolean {
  if (!e || typeof e !== 'object') return false;
  if (e.status === 404) return true;
  if (typeof e.name === 'string' && (e.name === 'NotFoundError' || SESSION_NOT_FOUND_RE.test(e.name))) return true;
  if (typeof e.message === 'string' && SESSION_NOT_FOUND_RE.test(e.message)) return true;
  if (typeof e.data?.message === 'string' && SESSION_NOT_FOUND_RE.test(e.data.message)) return true;
  return false;
}

/**
 * Detect opencode's "session does not exist" signal — a stale stored
 * session_id after a server restart / session-store loss / GC. Covers BOTH
 * shapes the SDK can hand back:
 *   • a RETURNED result object whose `.error` carries the failure. The live
 *     opencode shape (confirmed live) is
 *     `res.error = { name: "NotFoundError", data: { message: "Session not found: <id>" } }`
 *     — concatPromptText logs exactly this via `res.error`. The older
 *     `res.data.info.error.name` location is also covered.
 *   • a THROWN/caught error object carrying `name`/`message`/`status`/`data`
 *     directly (a stale session can surface either way).
 * Session-not-found is the ONE recoverable case; other errors surface normally.
 */
export function isSessionNotFound(res: unknown): boolean {
  const r = res as any;
  if (!r || typeof r !== 'object') return false;
  if (errorSignalsNotFound(r.error)) return true; // returned-result path (live shape)
  const infoName = r.data?.info?.error?.name;
  if (typeof infoName === 'string' && SESSION_NOT_FOUND_RE.test(infoName)) return true;
  if (errorSignalsNotFound(r)) return true; // thrown/caught path (error object itself)
  return false;
}

/** True when a promptAsync result/throw is an error (non-2xx) rather than the 204 accept. */
function isErrorResult(res: unknown): boolean {
  return res instanceof Error || (res != null && typeof res === 'object' && (res as { error?: unknown }).error != null);
}

/**
 * Run ONE turn via `session.promptAsync` (returns immediately, HTTP 204) and
 * await completion off the SSE stream (`session.idle` → the turn-completion
 * registry), NOT the HTTP response — so a long turn can't trip undici's headers
 * timeout the way the blocking `session.prompt` did.
 *
 * Session-not-found recovery is preserved: `promptAsync` still returns/throws a
 * 404 fast on a stale session, so on not-found we discard it, create a fresh
 * session (re-register with the bridge + clear `agent.session.session_id` so an
 * outer recovery re-spawn also starts fresh), and retry ONCE. A non-not-found
 * error is surfaced (thrown) — the caller's turn-loop catch logs it. `onSession`
 * is called with the active session id (initial + after a reset) so the caller
 * can keep its abort target current.
 *
 * Returns the accumulated reply text (best-effort, streamed text deltas) or ''
 * when recovery can't produce a fresh session. Rejects only if the turn itself
 * errored (`session.error`) or promptAsync surfaced a non-recoverable error.
 */
export async function runPromptTurn(args: {
  client: OpencodeClient;
  agent: Agent;
  task: Task;
  sessionId: string;
  readOnly: boolean;
  body: { parts: { type: 'text'; text: string }[]; system: string; tools?: Record<string, boolean> };
  onSession?: (sessionId: string) => void;
}): Promise<{ reply: string; sessionId: string }> {
  const { client, agent, task, readOnly, body, onSession } = args;
  let sessionId = args.sessionId;
  onSession?.(sessionId);

  // Register the completion waiter BEFORE firing so no idle/text event is missed.
  const fire = async (sid: string): Promise<{ res: unknown; turn: Promise<string> }> => {
    const turn = turnCompletion.waitForTurn(sid);
    try {
      const res = await client.session.promptAsync({ path: { id: sid }, body });
      return { res, turn };
    } catch (err) {
      return { res: err, turn }; // hand a thrown error back as `res` for uniform handling
    }
  };

  let { res, turn } = await fire(sessionId);

  if (isSessionNotFound(res)) {
    turnCompletion.cancelTurn(sessionId, 'session not found — resetting');
    logger.warn(agent.def.id, `opencode session ${sessionId} not found — resetting and retrying once`);
    sharedRegistry.delete(sessionId);
    agent.session.session_id = undefined;
    const created = await client.session.create({ body: { title: `archie-${task.taskId}-${agent.def.id}` } });
    const fresh = (created as { data?: { id?: string } })?.data?.id;
    if (!fresh) {
      logger.error(agent.def.id, 'opencode session.create returned no id during recovery');
      return { reply: '', sessionId };
    }
    sessionId = fresh;
    agent.session.session_id = sessionId;
    sharedRegistry.set(sessionId, { task, agent, readOnly });
    onSession?.(sessionId);
    ({ res, turn } = await fire(sessionId));
  }

  if (isErrorResult(res)) {
    // Non-recoverable (400, still-not-found after reset, or a thrown network
    // error). Discard the waiter and surface it to the turn-loop catch.
    turnCompletion.cancelTurn(sessionId, 'promptAsync error');
    throw res instanceof Error ? res : new Error(`opencode promptAsync failed: ${JSON.stringify((res as { error?: unknown }).error)}`);
  }

  // Accepted (204). Await the async turn's completion via session.idle (resolves
  // with the streamed reply text) — an in-process promise, no held-open request.
  const reply = await turn; // rejects on session.error
  return { reply, sessionId };
}

export class OpencodeRuntime implements AgentRuntime {
  readonly kind = 'opencode' as const;

  capabilities(): RuntimeCapabilities {
    return OPENCODE_RUNTIME_CAPABILITIES;
  }

  /** The agent's opencode route as a beautify-ready id, or null when unresolved. */
  footerModelToken(def: AgentDef): string | null {
    return opencodeAgentRoute(def);
  }

  /** The server-global default route, or null when unresolved. */
  footerModelDefaultToken(): string | null {
    return opencodeFooterModel();
  }

  /** Tear down every per-agent serve child, then the bridge, then the P3b
   * egress proxy, then the one-shot utility serve (P3a/P3b error-handling
   * order) — so a dev reload leaves no orphaned `opencode serve` children and
   * no dangling proxy listener. */
  async shutdown(): Promise<void> {
    await closeServePool();
    await closeBridge();
    await closeEgressProxy();
    await closeOneShotServe();
  }

  /**
   * Plugins hot-reload: mark every live child stale; each recycles at its own
   * next turn boundary and re-stages fresh skills on boot (per-child restart —
   * tiny blast radius vs the old shared-server managed restart). Agents spawned
   * after the push stage fresh by construction. Best-effort, never throws.
   */
  async onPluginsRefreshed(): Promise<void> {
    markAllServesStale('plugins');
  }

  /** Close this task's serve children and rm their synthetic serve roots
   * (pool.evictTask) — the ONLY place serve roots are removed (P3a A5).
   * Best-effort: never throws into task teardown. */
  async onTaskTeardown(taskId: string): Promise<void> {
    try {
      await evictTask(taskId);
    } catch (err) {
      logger.warn('opencode', `evictTask(${taskId}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async spawn(agent: Agent, task: Task): Promise<void> {
    const { def } = agent;
    // Mark active before heavy setup so the idle-check can't park the agent
    // mid-boot (mirrors spawnAgent).
    task.updateAgentState(def.id, true);

    // Shared launch inputs (also sets agent.sandbox). opencode has no OS sandbox,
    // so no Claude session dirs are added to the sandbox in this path. `repo` is
    // only populated for repo agents (undefined for PM/plugin agents, which have
    // no file/repo write surface to gate) — its `editAllowed` is the exact same
    // edit-mode signal spawnAgent uses (it also sets agent.editModeAtSpawn from
    // it), so reusing it here keeps the two runtimes' RO/edit decision identical
    // instead of re-deriving it from agent.editModeAtSpawn / task.metadata by hand.
    const { systemPrompt, repo } = await prepareAgentContext(agent, task, {
      claudeReadDirs: [],
      claudeWriteDirs: [],
    });
    // Parity with the Claude runtime: the Claude path denies PM/plugin agents
    // Bash/Edit/Write entirely, and only grants them to repo agents once edit
    // mode is approved. opencode has no OS sandbox, so its built-in
    // edit/write/bash tools are the only thing standing between "readOnly"
    // and full write access — readOnly must therefore be true for BOTH
    // non-repo (PM/plugin) agents and read-only repo agents, and false only
    // for edit-mode repo agents. PM/plugin agents are unaffected in practice:
    // they only ever use their bridged custom tools (post_to_user etc. — not
    // built-ins, never blocked) and built-in READ tools (read/grep/glob — not
    // in RO_BUILTIN_BLOCK).
    const readOnly = !(repo && repo.editAllowed);

    // Per-agent child placement (P3a A3/S2): a repo agent's child runs in its
    // PRIMARY clone (the git-worktree boundary bounds skill discovery — spike
    // S2); clone-less agents (PM/plugin) get a synthetic git-init root under
    // <workdir>/opencode-server/<taskId>/<agentId>.
    const primaryClone =
      repo?.repoMounts.find((m) => m.github === def.repo?.primary)?.clonePath ??
      repo?.repoMounts[0]?.clonePath;
    const serveSpec: AgentServeSpec = primaryClone ? { clonePath: primaryClone } : {};

    // Abort target — the current opencode session id + this turn's serve
    // child's client, kept current as the loop resumes/resets sessions and
    // recycles children. Task teardown calls handle.abort() AFTER stopping
    // the queue. With the promptAsync turn model there's no held-open HTTP
    // request to abort; instead we unblock the in-flight `await turn`
    // (turn-completion registry) and tell opencode to abort the running turn
    // server-side.
    let currentSessionId: string | undefined = agent.session.session_id;
    let clientRef: OpencodeClient | undefined;

    const handle = {
      running: Promise.resolve() as Promise<void>,
      isRunning: true,
      abort: () => {
        const sid = currentSessionId;
        if (!sid) return;
        turnCompletion.cancelTurn(sid, 'aborted');
        clientRef?.session.abort({ path: { id: sid } }).catch(() => {});
      },
    };

    handle.running = (async () => {
      let sessionId = agent.session.session_id;
      let firstResponse = true;
      let lastServe: ServeHandle | undefined; // last acquired child, closed at wind-down
      try {
        while (!agent.queue.isStopped()) {
          let msg;
          // Idle reap (A1): armed ONLY while parked on nextMessage(), disarmed
          // synchronously the moment a message lands — so the reap acts only at
          // the parked/turn-boundary signal, never mid-turn. A reaped child is
          // transparently re-acquired below (context-free — S1=RESUME).
          const disarmReap = scheduleIdleReap(agent, task);
          try {
            msg = await agent.queue.nextMessage();
          } catch {
            break; // queue stopped → end the turn loop
          } finally {
            disarmReap();
          }

          // A message can land in the same tick task.stop() runs (the queue is
          // drained, not rejected). Re-check before acquiring so a stopped task
          // never re-boots a reaped child or re-creates an evicted serve root.
          if (agent.queue.isStopped()) break;

          // Acquire this agent's serve child for the turn: boots on demand,
          // reuses a warm handle, recycles a stale one (plugins push / RO→RW
          // mode transition) — the single turn-boundary recycle point (P3a §5).
          // A boot failure throws to the outer catch → the agent is marked
          // inactive and the task's bounded recovery loop runs (parity with the
          // old in-turn embedded-client-boot failure).
          const serve = await getAgentServe(agent, task, serveSpec);
          clientRef = serve.client;
          lastServe = serve;

          // Ensure a session (resume the stored one, else create). Sessions
          // persist in opencode's GLOBAL store (spike S1) — they survive child
          // recycles/reaps, so this runs once per agent, not per child.
          if (!sessionId) {
            const created = await serve.client.session.create({ body: { title: `archie-${task.taskId}-${def.id}` } });
            sessionId = (created as any)?.data?.id;
            if (!sessionId) {
              logger.error(def.id, 'opencode session.create returned no session id');
              return;
            }
            agent.session.session_id = sessionId;
          }
          currentSessionId = sessionId;
          // (Re-)register with the bridge each turn — idempotent, and keeps the
          // registration alive across child recycles; evicted in `finally`.
          sharedRegistry.set(sessionId, { task, agent, readOnly });

          const text = msg.from ? `[From ${msg.from}]: ${msg.content}` : msg.content;

          // Fresh per-turn state for the bridge's double-post dedup.
          const regForTurn = sharedRegistry.get(sessionId);
          if (regForTurn) regForTurn.postedThisTurn = false;

          // NO body.model: the child's config.model IS this agent's route (P3a
          // §6 — the per-turn override is dropped). `tools` remains the
          // per-agent external-MCP denylist (tool-allowlist.ts).
          const toolAllow = buildToolAllowlist(agent);
          const body = {
            parts: [{ type: 'text' as const, text }],
            system: systemPrompt,
            ...(Object.keys(toolAllow).length > 0 ? { tools: toolAllow } : {}),
          };
          // Fire via promptAsync + await completion off the SSE session.idle
          // event (runPromptTurn), not the HTTP response — a long turn no longer
          // trips undici's headers timeout.
          const { reply, sessionId: activeId } = await runPromptTurn({
            client: serve.client, agent, task, sessionId, readOnly, body,
            onSession: (sid) => { currentSessionId = sid; },
          });
          sessionId = activeId;

          if (firstResponse) {
            firstResponse = false;
            task.updateAgentState(def.id, true, sessionId);
          }

          if (reply) logger.agent(def.id, reply);

          // session.idle (the turn completed) is the Stop equivalent: mark
          // inactive so the quiescence/idle path runs, and flush any teardown a
          // tool deferred during the turn.
          task.updateAgentState(def.id, false);
          if (agent.pendingTeardown) {
            const teardown = agent.pendingTeardown;
            agent.clearPendingTeardown();
            await teardown().catch((err) =>
              logger.error(def.id, 'Error during deferred teardown', err),
            );
          }
        }
      } catch (err) {
        if (!agent.queue.isStopped()) {
          logger.error(def.id, 'opencode turn failed', err as Error);
          // Route the error into the task-level recovery loop (parity with the
          // Claude runtime — spawn.ts "marking inactive so recovery can run").
          // Without this the agent's session stays active, `scheduleIdleCheck`
          // never fires, and the task hangs in_progress. Marking inactive
          // triggers the idle-check → recover (re-engage/retry, bounded to 3
          // attempts then nuclear) or complete. Guarded by !isStopped so a
          // stopped/completed task isn't re-woken.
          task.updateAgentState(def.id, false);
        }
      } finally {
        // Evict the bridge registration + resolve any lingering turn waiter on
        // every exit path (normal, aborted, or errored) so a stale sessionId
        // can't resolve control-tool calls to a dead Task/Agent pair and no
        // completion promise is left dangling. Use the LIVE id: runPromptTurn's
        // 404 recovery registers a fresh session (reported via onSession →
        // currentSessionId) but the loop-local `sessionId` only advances on a
        // successful turn — if the retried turn then throws, deleting the old
        // `sessionId` would leak the fresh registry entry. `currentSessionId`
        // may still be unset if getAgentServe()/session.create() failed before
        // any registration ran.
        const liveId = currentSessionId ?? sessionId;
        if (liveId) {
          sharedRegistry.delete(liveId);
          turnCompletion.cancelTurn(liveId, 'turn loop exited');
        }
        // Agent wind-down (P3a data flow): close this agent's child if one was
        // acquired (root kept — evictTask rm's it at task teardown; sessions
        // persist in opencode's global store, so a later re-spawn resumes).
        // Never boot a child just to close it; best-effort — never mask the
        // loop's exit.
        if (lastServe) await lastServe.close().catch(() => {});
        handle.isRunning = false;
        agent.backgroundTasks.clear();
        if (agent.pendingTeardown) {
          const teardown = agent.pendingTeardown;
          agent.clearPendingTeardown();
          await teardown().catch((err) =>
            logger.error(def.id, 'Error during deferred teardown (exit)', err),
          );
        }
      }
    })();

    agent.handle = handle;
  }
}

export const opencodeRuntime = new OpencodeRuntime();
