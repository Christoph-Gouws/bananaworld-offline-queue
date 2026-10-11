// Idempotency-Key generation per API-PRINCIPLE-008 / API-REQ-002 / API-MVP-013.
//
// Anchors: EPIC-001-M007-SCOPE-005, QUALITY-API-007, QA-AUTO-042 (replay safety).
//
// Per API-PRINCIPLE-008 every tablet-flow write carries a UUID v4 in the
// `Idempotency-Key` header. The SAME key is reused across every replay attempt
// for the same pending write — that is the replay-safety contract. The server
// resolves `same key + same payload` → return original outcome (deduplication),
// and `same key + different payload` → return 409 IDEMPOTENCY_CONFLICT (queue
// bug — flagged loudly per M007-DEC-004).

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/**
 * Generate a fresh UUID v4 for a newly-enqueued write. Uses `crypto.randomUUID()`
 * which is available in both service worker and modern browser main-thread
 * contexts (Chrome on Android 12+ per TECH-FE-003; SW spec mandates `crypto`
 * globally since 2021). No polyfill required.
 *
 * Throws if `crypto.randomUUID` is unavailable, which would indicate the queue
 * is running in an unsupported environment — fail loudly rather than silently
 * fall back to a weaker generator.
 */
export function generateIdempotencyKey(): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error(
      "[offline-queue] crypto.randomUUID is required for Idempotency-Key generation. " +
        "Bananaworld-DC supports Chrome on Android 12+ per TECH-FE-003.",
    );
  }
  return crypto.randomUUID();
}

/**
 * Sanity check: a string looks like a UUID v4. Used by replay-side validation
 * (an unexpectedly-shaped key indicates a corrupted queue row).
 *
 * Pattern: 8-4-4-4-12 hex with version digit 4 and variant 8/9/a/b.
 */
export function looksLikeIdempotencyKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
