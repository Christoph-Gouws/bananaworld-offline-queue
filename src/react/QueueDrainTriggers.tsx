"use client";

// CR-DC-069 — the page-side triggers that ask the service worker to drain the offline write queue.
//
// Anchors: CR-DC-069 (§2.3, D-2), PRD-NFR-005 (zero stock-data loss), UX-SCREEN-230, SEC-AUTH-013,
//          TECH-FE-010.
//
// 🔴 THE GAP THIS CLOSES. Before this change the replay loop was reachable from exactly two places:
// immediately after a NEW write was queued, and the Background Sync event. Tapping Retry replayed
// nothing, and the "page-side fallback for browsers without Background Sync" — a RETRY_ALL on the
// window `online` event — replayed nothing either AND only ever looked at `failed` rows, so the
// ordinary offline case (a queue full of `queued` rows) was untouched by it entirely. A tablet that
// captured work offline, was locked or closed, and reopened on WiFi drained nothing until the
// operator happened to save something else.
//
// 🔴 ONE MOUNT, IN THE LAYOUT — NEVER PER STATION. This component is rendered once by
// `app/tablet-pwa/layout.tsx`, the single layout every one of the tablet station routes renders
// inside (receiving, ripening, conversion, transfer, dispatch, run-dispatch, quality-check,
// cycle-count, stock-adjustment, returns, crates, delivery, pre-trip, fuel, meter-reading, the
// station home and the login screen). The queue itself was never per-station either — a write is
// queued on one `/tablet-pwa` prefix test — so the drain is mounted at the same altitude on purpose.
// Copying these triggers into individual station screens would re-create exactly the class of gap
// described above: one surface silently left out, with nothing to redden.
//
// The token never comes near this file. Every message below is payload-free and every replay runs
// inside the service worker, which reads the session from its own protected storage (SEC-AUTH-013).

import { useEffect, useRef } from "react";
import { askServiceWorker } from "../sync-protocol";

/**
 * At most one DRAIN_QUEUE per this window. A tablet that is picked up, put down and picked up again
 * within a few seconds should not queue three passes. Not a business threshold — a debounce.
 */
const DRAIN_THROTTLE_MS = 5_000;

export function QueueDrainTriggers() {
  const lastDrainAt = useRef<number>(0);

  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;
    let cancelled = false;

    const drain = (): void => {
      if (cancelled) return;
      // A drain with no network only burns attempts and pushes every row further into its backoff
      // window. `askServiceWorker` also returns null with no controller, so `next dev`, the e2e
      // suite's `serviceWorkers: "block"` and the very first page load are all safe no-ops.
      if (navigator.onLine === false) return;
      const now = Date.now();
      if (now - lastDrainAt.current < DRAIN_THROTTLE_MS) return;
      lastDrainAt.current = now;
      void askServiceWorker({ type: "DRAIN_QUEUE" });
    };

    // RECONNECT. This replaces the RETRY_ALL that used to fire here from `useSyncStatus`. The change
    // in behaviour is deliberate and is the correct one: reconnect now drains the `queued` rows that
    // are the actual offline case, and leaves `failed` rows in front of the operator instead of
    // silently un-failing every conflict and re-sending it with nobody having decided to.
    const onOnline = (): void => drain();

    // PICK-UP. CR-DC-069 D-2 chose this over a clock: it is the moment a station tablet actually
    // rejoins the world, it is free when nothing is happening, and it costs nothing overnight.
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") drain();
    };

    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);

    // APP START — the close-and-reopen case. The service worker is dead, the page boot starts it,
    // and the controller persists from the previous registration. `controllerchange` covers the very
    // first load, before `clients.claim()` has landed and while `controller` is still null.
    const swContainer = "serviceWorker" in navigator ? navigator.serviceWorker : null;
    const onControllerChange = (): void => drain();
    if (swContainer) {
      swContainer.addEventListener("controllerchange", onControllerChange);
      swContainer.ready.then(
        () => drain(),
        () => {
          /* no registration (dev, or a browser that refuses one) — nothing to drain through */
        },
      );
    }

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      swContainer?.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
