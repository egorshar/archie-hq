/**
 * OpencodeRuntime — the AgentRuntime backed by an embedded opencode server
 * (spec §3.3, Phase 2-A). Self-contained: it replicates the plumbing subset of
 * spawnAgent() for opencode (thin seam), reusing prepareAgentContext() for the
 * shared launch inputs. The turn primitive is client.session.prompt(): its
 * return is the session.idle/Stop equivalent. The live SSE event stream, the
 * in-process tool bridge, guards, and read-only enforcement are Phase 2-B.
 */
import type { AgentRuntime } from '../../ports/agent-runtime.js';
import type { RuntimeCapabilities } from '../../ports/capabilities.js';
import { OPENCODE_RUNTIME_CAPABILITIES } from '../../ports/capabilities.js';
import type { Agent } from '../../agents/agent.js';
import type { Task } from '../../tasks/task.js';
import { prepareAgentContext } from '../../agents/spawn.js';
import { logger } from '../../system/logger.js';
import { getOpencodeClient, concatPromptText, sharedRegistry } from './server.js';

export class OpencodeRuntime implements AgentRuntime {
  readonly kind = 'opencode' as const;

  capabilities(): RuntimeCapabilities {
    return OPENCODE_RUNTIME_CAPABILITIES;
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
    const readOnly = repo ? !repo.editAllowed : false;

    // Per-agent controller — aborts THIS agent's in-flight prompt only, never the
    // shared server. Task teardown calls handle.abort() after stopping the queue.
    const abortController = new AbortController();

    const handle = {
      running: Promise.resolve() as Promise<void>,
      isRunning: true,
      abort: () => abortController.abort(),
    };

    handle.running = (async () => {
      let sessionId = agent.session.session_id;
      let firstResponse = true;
      try {
        // Start the embedded server INSIDE the turn body so a startup failure
        // (server can't spawn) fails only this agent — logged here, marked
        // inactive by the finally + Agent.spawn's crash wiring — instead of
        // rejecting spawn() and surfacing as an unhandled rejection that
        // crashes the process when recovery re-spawns. Model routing is
        // server-global (`config.model`, set once in server.ts — spike.md §5)
        // rather than per-prompt, so there's no per-agent model to resolve here;
        // see server.ts's SERVER_MODEL_LOGICAL note for the shared-server caveat.
        const client = await getOpencodeClient();

        // Ensure a session (resume the stored one, else create).
        if (!sessionId) {
          const created = await client.session.create({ body: { title: `archie-${task.taskId}-${def.id}` } });
          sessionId = (created as any)?.data?.id;
          if (!sessionId) {
            logger.error(def.id, 'opencode session.create returned no session id');
            return;
          }
          agent.session.session_id = sessionId;
        }
        // Register this session with the bridge's SessionRegistry so bridged
        // control-tool calls (post_to_user / report_completion /
        // request_edit_mode) resolve to this Task/Agent pair; evicted in the
        // `finally` below regardless of how the turn loop exits. readOnly is the
        // repo agent's real edit mode (false for non-repo agents) — the /policy
        // read path and the bridge's write-tool rejection enforce RO from it.
        sharedRegistry.set(sessionId, { task, agent, readOnly });

        while (!agent.queue.isStopped()) {
          let msg;
          try {
            msg = await agent.queue.nextMessage();
          } catch {
            break; // queue stopped → end the turn loop
          }
          const text = msg.from ? `[From ${msg.from}]: ${msg.content}` : msg.content;

          // client.session.prompt is single-argument: Options<SessionPromptData>
          // extends Omit<RequestInit, 'body'|'headers'|'method'> & SessionPromptData,
          // so `signal` merges into the same object as `path`/`body` (the
          // `@hey-api` fetch-client convention) rather than a second argument.
          // No `body.model` here — opencode ignores it (spike.md §5); the model
          // is set once, server-wide, via `config.model` in server.ts.
          const res = await client.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: 'text', text }], system: systemPrompt },
            signal: abortController.signal,
          });

          if (firstResponse) {
            firstResponse = false;
            task.updateAgentState(def.id, true, sessionId);
          }

          const reply = concatPromptText(res);
          if (reply) logger.agent(def.id, reply);

          // Prompt-return = the session.idle/Stop equivalent for P2-A: the turn
          // ended. Mark inactive so the quiescence/idle path runs, and flush any
          // teardown a tool deferred during the turn.
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
        if (!agent.queue.isStopped()) logger.error(def.id, 'opencode turn failed', err as Error);
      } finally {
        // Evict the bridge registration on every exit path (normal, aborted, or
        // errored) so a stale sessionId can't resolve control-tool calls to a
        // dead Task/Agent pair. `sessionId` may still be unset if getOpencodeClient()
        // or session.create() failed before registration ever ran.
        if (sessionId) sharedRegistry.delete(sessionId);
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
