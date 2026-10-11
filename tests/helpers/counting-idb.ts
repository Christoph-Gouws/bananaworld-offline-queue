// Test helper — CR-DC-070: count the rows a read path actually pulls OUT of `sync_history`.
//
// Anchors: CR-DC-070 (§4 test 3), SESSION_HANDOVER "ASSERT NON-VACUITY NUMERICALLY".
//
// 🔴 WHY A COUNTER AND NOT A STOPWATCH. The claim under test is "showing 'Online' no longer costs
// more as the station gets older". A wall-clock assertion for that is a flake generator on CI and
// proves nothing about the algorithm; the number of rows read IS the property, and it is exact.
//
// 🔴 WHY BOTH `getAll` AND `openCursor` ARE COUNTED, and this is the whole reason this file is not
// three lines. If only the cursor were instrumented, the OLD implementation — which called
// `index.getAll()` and sorted in JS — would report ZERO rows read and sail through a "≤ 21"
// assertion. That is precisely the vacuous check this estate has been bitten by twice (-062, -064).
// Every path that can yield a `sync_history` row is counted, so the assertion reddens against the
// old code instead of passing against it (proved by mutation at build). The suite then asserts the
// SAME number at two very different store sizes, which no vacuous counter can satisfy.

import type { OfflineQueueDB } from "@/lib/offline-queue";

export interface SyncHistoryReadCounter {
  /** Rows yielded out of `sync_history` by any read path since the last reset. */
  rowsRead: number;
  reset(): void;
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Forward an untouched member. Methods are bound to the real target so `idb`'s own internals keep
 * working; everything else passes straight through.
 */
function passThrough(target: object, prop: PropertyKey): unknown {
  const value = Reflect.get(target, prop, target);
  return typeof value === "function" ? (value as AnyFn).bind(target) : value;
}

/** Invoke a promise-returning member of the wrapped object. Method names are always literals at the
 *  call sites below, so nothing user-supplied ever reaches this. */
function callAsync(target: object, method: string, args: unknown[]): Promise<unknown> {
  const fn = Reflect.get(target, method, target) as AnyFn;
  return fn.apply(target, args) as Promise<unknown>;
}

/**
 * `.then()` rather than `await` throughout: it adds one microtask tick instead of two, which keeps
 * the wrapper's timing as close as possible to `idb`'s own promise plumbing so an IndexedDB
 * transaction cannot auto-commit between a cursor and its `continue()`.
 */
function wrapCursor(cursor: unknown, counter: SyncHistoryReadCounter): unknown {
  if (cursor === null || cursor === undefined) return cursor;
  counter.rowsRead += 1;
  return new Proxy(cursor as object, {
    get(target, prop) {
      // Named explicitly rather than reached by a computed key — a dynamic member call here is an
      // object-injection sink, and only these two advance a cursor.
      if (prop === "continue") {
        return (...args: unknown[]) =>
          callAsync(target, "continue", args).then((next) => wrapCursor(next, counter));
      }
      if (prop === "advance") {
        return (...args: unknown[]) =>
          callAsync(target, "advance", args).then((next) => wrapCursor(next, counter));
      }
      return passThrough(target, prop);
    },
  });
}

function countRows(rows: unknown, counter: SyncHistoryReadCounter): unknown {
  if (Array.isArray(rows)) counter.rowsRead += rows.length;
  return rows;
}

/** An index or a store — both expose the two read shapes that can yield rows. */
function wrapReadSource(source: unknown, counter: SyncHistoryReadCounter): unknown {
  return new Proxy(source as object, {
    get(target, prop) {
      if (prop === "getAll") {
        return (...args: unknown[]) =>
          callAsync(target, "getAll", args).then((rows) => countRows(rows, counter));
      }
      if (prop === "openCursor") {
        return (...args: unknown[]) =>
          callAsync(target, "openCursor", args).then((cursor) => wrapCursor(cursor, counter));
      }
      if (prop === "index") {
        return (...args: unknown[]) => {
          const index = (Reflect.get(target, "index", target) as AnyFn).apply(target, args);
          return wrapReadSource(index, counter);
        };
      }
      return passThrough(target, prop);
    },
  });
}

function wrapTransaction(tx: unknown, names: unknown, counter: SyncHistoryReadCounter): unknown {
  return new Proxy(tx as object, {
    get(target, prop) {
      if (prop === "objectStore") {
        return (name: string) => {
          const store = (Reflect.get(target, "objectStore", target) as AnyFn).apply(target, [name]);
          return name === "sync_history" ? wrapReadSource(store, counter) : store;
        };
      }
      if (prop === "store" && names === "sync_history") {
        return wrapReadSource(Reflect.get(target, prop, target), counter);
      }
      return passThrough(target, prop);
    },
  });
}

/**
 * Wrap an offline-queue DB so every row read out of `sync_history` is counted. Reads of the other
 * two stores, and every WRITE, pass through untouched.
 */
export function countingHistoryDb(db: OfflineQueueDB): {
  db: OfflineQueueDB;
  counter: SyncHistoryReadCounter;
} {
  const counter: SyncHistoryReadCounter = {
    rowsRead: 0,
    reset() {
      counter.rowsRead = 0;
    },
  };

  const wrapped = new Proxy(db as object, {
    get(target, prop) {
      if (prop === "transaction") {
        return (...args: unknown[]) => {
          const tx = (Reflect.get(target, "transaction", target) as AnyFn).apply(target, args);
          return wrapTransaction(tx, args.at(0), counter);
        };
      }
      // The `db.getAll("sync_history")` shorthand, counted for the same reason `index.getAll` is.
      if (prop === "getAll") {
        return (...args: unknown[]) =>
          callAsync(target, "getAll", args).then((rows) =>
            args.at(0) === "sync_history" ? countRows(rows, counter) : rows,
          );
      }
      return passThrough(target, prop);
    },
  });

  return { db: wrapped as OfflineQueueDB, counter };
}
