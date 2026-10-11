// The worker's own `fetch`, as a plain function that ignores `this` (CR-DC-240 / KI-227-01).
//
// The native `fetch` is a WebIDL operation on the worker's global scope. Called with any OTHER `this`
// — which is what `ctx.fetchImpl(url)` does when the native function is stored on a context object —
// Chromium throws "TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation".
// The replay loop read that throw as a network failure, so nothing saved offline reached a server
// from 2026-05-28 until this fix.
//
// This wrapper always calls it on `globalThis`, so it stays correct however a later edit stores or
// calls it. Every worker module that needs a default `fetch` takes THIS one — never the bare native
// function, and never `deps.fetch(…)` in method form (fenced in the package by
// tests/unit/sw/no-method-form-fetch.test.ts and in each app that ships the worker).
export const globalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
