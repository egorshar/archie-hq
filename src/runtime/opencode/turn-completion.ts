/**
 * Turn-completion registry for the opencode runtime.
 *
 * `session.promptAsync` returns immediately (HTTP 204) and the turn runs
 * asynchronously on the opencode server; completion + the assistant's reply
 * text arrive on the SSE event stream (`message.part.updated` text parts, then
 * `session.idle`; `session.error` on failure). This registry bridges that:
 * `runtime.ts` registers a waiter per turn via {@link waitForTurn} before firing
 * `promptAsync`, and the event consumer (`events.ts`) drives it — appending text
 * parts, resolving on idle, rejecting on error.
 *
 * This replaced the blocking `session.prompt`, whose single held-open HTTP
 * request tripped undici's headers timeout (`UND_ERR_HEADERS_TIMEOUT`) on long
 * turns (a heavy glm-5.2 repo-edit turn ran past the ~5-min default), killing
 * the turn mid-flight and looping recovery (2026-07-10).
 *
 * Semantics: `completeTurn` resolves with the accumulated text; `failTurn`
 * rejects (a real turn error the caller should surface); `cancelTurn` resolves
 * EMPTY (a deliberate discard on abort/session-reset — the caller isn't using
 * the result), which also avoids any unhandled-rejection on a promise the
 * caller may drop without awaiting.
 */
interface Waiter {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  text: string[];
}

export class TurnCompletionRegistry {
  private readonly waiters = new Map<string, Waiter>();

  /**
   * Register a waiter for `sessionId`'s next turn and return a promise that
   * resolves with the accumulated reply text on idle (or rejects on error).
   * If a waiter is already pending for the session it is superseded (resolved
   * empty) so no promise is left dangling.
   */
  waitForTurn(sessionId: string): Promise<string> {
    this.cancelTurn(sessionId, 'superseded by a new turn');
    return new Promise<string>((resolve, reject) => {
      this.waiters.set(sessionId, { resolve, reject, text: [] });
    });
  }

  /** Append a streamed assistant text chunk to the pending turn (no-op if none). */
  appendText(sessionId: string, text: string): void {
    this.waiters.get(sessionId)?.text.push(text);
  }

  /** session.idle: resolve the pending turn with its accumulated text (no-op if none). */
  completeTurn(sessionId: string): void {
    const w = this.waiters.get(sessionId);
    if (!w) return;
    this.waiters.delete(sessionId);
    w.resolve(w.text.join(''));
  }

  /** session.error: reject the pending turn (no-op if none). */
  failTurn(sessionId: string, err: Error): void {
    const w = this.waiters.get(sessionId);
    if (!w) return;
    this.waiters.delete(sessionId);
    w.reject(err);
  }

  /**
   * Abort / session-reset: resolve the pending turn EMPTY (deliberate discard —
   * the caller stops using it). Resolving (not rejecting) avoids an
   * unhandled-rejection if the caller drops the promise without awaiting.
   */
  cancelTurn(sessionId: string, _reason: string): void {
    const w = this.waiters.get(sessionId);
    if (!w) return;
    this.waiters.delete(sessionId);
    w.resolve('');
  }
}

/** Process-wide singleton, shared by the event consumer and the runtime. */
export const turnCompletion = new TurnCompletionRegistry();
