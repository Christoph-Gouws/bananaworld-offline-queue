// Unit test — Idempotency-Key generation (API-PRINCIPLE-008 / API-REQ-002).
//
// Anchors: EPIC-001-M007-SCOPE-005, QA-AUTO-042 (replay safety), QUALITY-API-007.

import { describe, expect, it } from "vitest";
import {
  generateIdempotencyKey,
  IDEMPOTENCY_HEADER,
  looksLikeIdempotencyKey,
} from "@/lib/offline-queue";

describe("generateIdempotencyKey (API-PRINCIPLE-008)", () => {
  it("produces a UUID v4 string", () => {
    const key = generateIdempotencyKey();
    expect(looksLikeIdempotencyKey(key)).toBe(true);
  });

  it("never produces the same key twice across 1000 calls (uniqueness floor)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generateIdempotencyKey());
    }
    expect(seen.size).toBe(1000);
  });
});

describe("looksLikeIdempotencyKey (corruption guard)", () => {
  it("accepts a fresh generateIdempotencyKey() output", () => {
    expect(looksLikeIdempotencyKey(generateIdempotencyKey())).toBe(true);
  });

  it("rejects empty string + non-UUID shapes + UUID v1 shapes", () => {
    expect(looksLikeIdempotencyKey("")).toBe(false);
    expect(looksLikeIdempotencyKey("not-a-uuid")).toBe(false);
    // UUID v1 has version digit 1, not 4 — must be rejected.
    expect(looksLikeIdempotencyKey("11111111-1111-1111-9999-111111111111")).toBe(false);
  });
});

describe("IDEMPOTENCY_HEADER constant", () => {
  it("matches the API-REQ-002 wire-protocol header name verbatim", () => {
    // Per API-REQ-002 the header on the wire is exactly "Idempotency-Key".
    expect(IDEMPOTENCY_HEADER).toBe("Idempotency-Key");
  });
});
