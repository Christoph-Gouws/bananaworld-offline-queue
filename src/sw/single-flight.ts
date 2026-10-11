// CR-DC-069 — one in-flight pass at a time.
//
// Anchors: CR-DC-069 (§2.6), PRD-NFR-005 (zero data loss), CR-DC-067 (the server-side
//          Idempotency-Key guard this backs up rather than leans on).
//
// 🔴 WHY THIS EXISTS. `src/sw/replay-loop.ts` carried a comment claiming the loop was safe under
// concurrency — that "the markWriteAttempt status flips to `syncing` to prevent the same write being
// attempted by two passes at once". It never did: `getPendingWrites` RANKS `syncing` rows, it does
// not exclude them, and `replayOneWrite` skips only `failed`. Two overlapping passes both read a row
// before either marks it, and both send it.
//
// Until this change that was nearly unreachable — the loop had exactly two triggers and they rarely
// coincided. CR-DC-069 adds four more, several of which fire within milliseconds of each other (a
// tablet picked up on WiFi fires reconnect + visibility + Background Sync at once). Leaving the race
// in place and trusting the server's idempotency guard alone would be shipping a known duplicate-send
// and calling it someone else's problem. So: overlapping triggers COALESCE into one pass here, on the
// device, and CR-DC-067's guard stays the backstop rather than the mechanism.
//
// ⚠ The in-flight promise is module state, so it dies when the browser terminates an idle service
// worker. That is correct and harmless: a terminated worker has no pass in flight. A row left
// `syncing` by a mid-flight termination is picked up by the next pass (replayOneWrite skips only
// `failed`) and is protected by the same Idempotency-Key. No new status, no new field, no new store.
//
// NO BARREL. Imported by leaf path from `src/sw/index.ts` only (SESSION_HANDOVER — a barrel that a
// client component can reach is how a `node:` import fails `next build` while every test passes).

/**
 * Wrap an async function so that concurrent callers share ONE execution.
 *
 * While a call is in flight every subsequent caller receives the SAME promise rather than starting a
 * second run; the slot clears when that promise settles, success or failure alike, so the next
 * trigger after it starts a genuinely fresh pass.
 *
 * Rejection propagates to every caller that was coalesced into the run — the wrapper adds no
 * swallowing of its own, because a drain failure that disappears silently is exactly the class of
 * bug this change exists to remove. Call sites decide what to do with it.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  return function runSingleFlight(): Promise<T> {
    if (inFlight !== null) return inFlight;
    // `run` is captured by its own settle handler; the handler only ever executes on a later
    // microtask, by which time the assignment below has happened. The identity check means a pass
    // that settles after a newer one has already started cannot clear the newer one's slot.
    const run: Promise<T> = fn().finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  };
}
