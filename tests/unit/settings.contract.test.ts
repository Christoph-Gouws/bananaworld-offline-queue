// Two contract legs on the settings boundary (CR-DC-227).
//
// 1. EVERY FIELD IS REQUIRED. The type-level half is the `@ts-expect-error` lines: if a field ever
//    gained a default (became optional) the directive would be UNUSED and `tsc` would fail. This file is
//    in the typecheck, so the leg runs in CI whether or not vitest reaches it.
// 2. THE PACKAGE NAMES NONE OF AN APP'S ROUTES. A route literal inside `src/` would be a value one app
//    quietly imposes on the other. The scan is over CODE with comments stripped — the history that
//    explains where each rule came from legitimately names the DC.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { QueueWorkerSettings } from "../../src/settings";
import { NEUTRAL_SETTINGS } from "../support/neutral-settings";

describe("settings are required, with no defaults", () => {
  it("omitting any field is a type error (checked by tsc via @ts-expect-error)", () => {
    // @ts-expect-error — `dbName` is required
    const noDb: QueueWorkerSettings = { ...NEUTRAL_SETTINGS, dbName: undefined };
    // @ts-expect-error — `sessionRenewalPath` is required
    const noRenewal: QueueWorkerSettings = { ...NEUTRAL_SETTINGS, sessionRenewalPath: undefined };
    // @ts-expect-error — `isNeverQueuedWrite` is required
    const noNever: QueueWorkerSettings = { ...NEUTRAL_SETTINGS, isNeverQueuedWrite: undefined };
    // @ts-expect-error — `isProtectedReadPath` is required
    const noProtect: QueueWorkerSettings = { ...NEUTRAL_SETTINGS, isProtectedReadPath: undefined };
    // @ts-expect-error — `backgroundSyncTag` is required
    const noTag: QueueWorkerSettings = { ...NEUTRAL_SETTINGS, backgroundSyncTag: undefined };
    expect([noDb, noRenewal, noNever, noProtect, noTag]).toHaveLength(5);
  });

  it("the neutral fixture shares NO value with the DC's own (so a leak cannot hide behind a coincidence)", () => {
    expect(NEUTRAL_SETTINGS.dbName).not.toBe("bananaworld-offline-queue");
    expect(NEUTRAL_SETTINGS.authPathPrefix).not.toBe("/api/auth/");
    expect(NEUTRAL_SETTINGS.sessionRenewalPath).not.toBe("/api/auth/pin/session");
    expect(NEUTRAL_SETTINGS.backgroundSyncTag).not.toBe("bananaworld-replay");
    expect(NEUTRAL_SETTINGS.shellCacheVersion).not.toContain("bananaworld");
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function stripComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the package source names none of an app's routes or caches", () => {
  const files = walk(resolve(process.cwd(), "src"));
  const FORBIDDEN = [
    "/tablet-pwa",
    "driver-station",
    "item-receipt",
    "/api/print",
    "/api/auth",
    "/api/station",
    "bananaworld-",
    "bananaworld_",
  ];

  it("scans a non-trivial number of files (non-vacuity)", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it.each(FORBIDDEN)("no code in src/ contains %s", (needle) => {
    const hits = files.filter((f) => stripComments(readFileSync(f, "utf8")).includes(needle));
    expect(hits).toEqual([]);
  });
});
