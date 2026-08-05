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
 * the turn mid-flight and looping recovery.
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
  /** Round-trips this turn may spend; undefined = unbudgeted. */
  maxTurns?: number;
  /** Assistant message ids seen — one id is one round-trip, however often it updates. */
  steps: Set<string>;
}

export class TurnCompletionRegistry {
  private readonly waiters = new Map<string, Waiter>();

  /**
   * Register a waiter for `sessionId`'s next turn and return a promise that
   * resolves with the accumulated reply text on idle (or rejects on error).
   * If a waiter is already pending for the session it is superseded (resolved
   * empty) so no promise is left dangling.
   */
  waitForTurn(sessionId: string, maxTurns?: number): Promise<string> {
    this.cancelTurn(sessionId, 'superseded by a new turn');
    return new Promise<string>((resolve, reject) => {
      this.waiters.set(sessionId, { resolve, reject, text: [], maxTurns, steps: new Set() });
    });
  }

  /** Append a streamed assistant text chunk to the pending turn (no-op if none). */
  appendText(sessionId: string, text: string): void {
    this.waiters.get(sessionId)?.text.push(text);
  }

  /**
   * Record one assistant message against the pending turn's step budget.
   *
   * An assistant message is one API round-trip, and `message.updated` fires
   * repeatedly for the same message as it streams — so the id, not the event,
   * is the unit. Returns true EXACTLY ONCE, on the step that takes the turn
   * over its allowance: the waiter is rejected here, and the caller must abort
   * the session server-side. Rejecting alone would only unblock Archie —
   * opencode would carry on driving the turn, still spending tokens.
   *
   * False for an unbudgeted turn, an unknown session, a repeat of a step
   * already counted, and every call after the breach (the session is aborted
   * once).
   */
  noteAssistantStep(sessionId: string, messageId: string): boolean {
    const w = this.waiters.get(sessionId);
    if (!w || w.maxTurns === undefined) return false;
    if (w.steps.has(messageId)) return false;
    w.steps.add(messageId);
    if (w.steps.size <= w.maxTurns) return false;
    this.failTurn(
      sessionId,
      new Error(`opencode turn exceeded its step budget (maxTurns=${w.maxTurns} API round-trips)`),
    );
    return true;
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
