// The sliding-window renewal, bound to a NEUTRAL path and threshold (CR-DC-227). The DC's own
// session-renewal.test.ts keeps proving its numbers through its binding; this proves the gates are the
// package's and the two app inputs really are inputs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionRenewal } from "../../../src/sw/session-renewal";
import { readStationSession, storeSessionToken } from "../../../src/token-storage";
import type { OfflineQueueDB } from "../../../src/schema";
import { NEUTRAL_SETTINGS } from "../../support/neutral-settings";
import { openOfflineQueueDB } from "../../support/schema";
import { stationSession, withFakeIndexedDB } from "../../helpers/fake-indexeddb";

const NOW = new Date("2026-08-22T07:30:00.000Z");
const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60 * 1000).toISOString();

const renewal = createSessionRenewal({
  renewalPath: NEUTRAL_SETTINGS.sessionRenewalPath,
  renewalThresholdMinutes: NEUTRAL_SETTINGS.renewalThresholdMinutes,
});

let db: OfflineQueueDB;
withFakeIndexedDB();
beforeEach(async () => {
  db = await openOfflineQueueDB();
});
afterEach(() => {
  db.close();
});

async function store(remainingMinutes: number, autoLogoffMinutes = 5): Promise<void> {
  await storeSessionToken(
    db,
    {
      token: "old-token",
      expiresAt: at(remainingMinutes),
      warehouseId: "wh-a",
      stationId: "station-a",
      operatorId: "operator-a",
      autoLogoffMinutes,
    },
    NOW.toISOString(),
  );
}

describe("shouldRenew — four gates, in order", () => {
  it("is false with no session, a lapsed one, an idle one, or one without an inactivity window", () => {
    expect(renewal.shouldRenew(null, NOW)).toBe(false);
    expect(
      renewal.shouldRenew(stationSession({ expiresAt: at(-1), autoLogoffMinutes: 5 }), NOW),
    ).toBe(false);
    expect(
      renewal.shouldRenew(
        stationSession({
          expiresAt: at(10),
          autoLogoffMinutes: 5,
          storedAt: at(-60),
          lastActivityAt: at(-30),
        }),
        NOW,
      ),
    ).toBe(false);
    expect(renewal.shouldRenew(stationSession({ expiresAt: at(10) }), NOW)).toBe(false);
  });

  it("uses the app's threshold: due at or under max(15, window/2) minutes remaining, not before", () => {
    const live = (remaining: number) =>
      stationSession({ expiresAt: at(remaining), autoLogoffMinutes: 5, lastActivityAt: at(-1) });
    expect(renewal.shouldRenew(live(15), NOW)).toBe(true);
    expect(renewal.shouldRenew(live(16), NOW)).toBe(false);
  });

  it("a DIFFERENT threshold from the app moves the boundary — it really is an input", () => {
    const strict = createSessionRenewal({
      renewalPath: NEUTRAL_SETTINGS.sessionRenewalPath,
      renewalThresholdMinutes: () => 2,
    });
    const session = stationSession({
      expiresAt: at(10),
      autoLogoffMinutes: 5,
      lastActivityAt: at(-1),
    });
    expect(renewal.shouldRenew(session, NOW)).toBe(true);
    expect(strict.shouldRenew(session, NOW)).toBe(false);
  });
});

describe("renewSessionIfDue", () => {
  it("posts to the app's renewal path with the worker-held token and stores the new one, keeping the cap anchor", async () => {
    await store(10);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "new-token",
            expires_at: (NOW.getTime() + 20 * 60000) / 1000,
          }),
          { status: 200 },
        ),
    );
    const outcome = await renewal.renewSessionIfDue({
      db,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(outcome).toBe("renewed");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(NEUTRAL_SETTINGS.sessionRenewalPath);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer old-token");
    expect(init.body).toBe("{}");
    const after = await readStationSession(db);
    expect(after?.token).toBe("new-token");
    expect(after?.storedAt).toBe(NOW.toISOString());
  });

  it("reports not-due without touching the network when there is plenty of life left", async () => {
    await store(60);
    const fetchImpl = vi.fn();
    expect(
      await renewal.renewSessionIfDue({
        db,
        fetch: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      }),
    ).toBe("not-due");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a refusal or an unreachable server never clears the session", async () => {
    await store(10);
    const refused = vi.fn(async () => new Response("{}", { status: 403 }));
    expect(
      await renewal.renewSessionIfDue({
        db,
        fetch: refused as unknown as typeof fetch,
        now: () => NOW,
      }),
    ).toBe("refused");
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(
      await renewal.renewSessionIfDue({
        db,
        fetch: down as unknown as typeof fetch,
        now: () => NOW,
      }),
    ).toBe("unreachable");
    expect((await readStationSession(db))?.token).toBe("old-token");
  });
});
