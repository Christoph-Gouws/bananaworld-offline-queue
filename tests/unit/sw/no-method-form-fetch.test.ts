// Contract test — no package code calls `fetch` as a method of another object (CR-DC-240 / KI-227-01).
//
// Chromium throws "Illegal invocation" when the native `fetch` is called with a `this` that is not the
// worker global, and the replay loop swallows that as a network failure. A method-form call
// (`ctx.fetchImpl(…)`, `deps.fetch(…)`, `x.doFetch(…)`) is therefore a silent "nothing ever sends".
// This fence reads every source file (comments stripped) and fails on any such call. Each consuming app
// keeps the same fence over its own worker-side files.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// `globalThis.fetch(…)` / `self.fetch(…)` call it on the worker global, which is the CORRECT receiver.
const METHOD_FORM_FETCH = /\b(?!globalThis\b|self\b)[\w$]+\.(fetch|fetchImpl|doFetch)\s*\(/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function codeOnly(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function offenders(files: Array<{ file: string; source: string }>): string[] {
  return files.filter((f) => METHOD_FORM_FETCH.test(codeOnly(f.source))).map((f) => f.file);
}

describe("no method-form fetch anywhere under src/", () => {
  const files = walk(resolve(process.cwd(), "src"))
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((file) => ({ file, source: readFileSync(file, "utf8") }));

  it("scans a real set of files (the fence is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(15);
    expect(files.some((f) => f.file.replace(/\\/g, "/").endsWith("src/sw/replay-loop.ts"))).toBe(
      true,
    );
  });

  it("finds none today", () => {
    expect(offenders(files)).toEqual([]);
  });

  it("goes red on a planted method-form call (the fence can fail)", () => {
    const planted = [
      { file: "planted.ts", source: "const r = await ctx.fetchImpl(write.url, init);" },
      { file: "planted2.ts", source: "return deps.fetch(url);" },
    ];
    expect(offenders(planted)).toEqual(["planted.ts", "planted2.ts"]);
  });

  it("ignores a method-form call that only appears in a comment", () => {
    expect(
      offenders([{ file: "c.ts", source: "// never ctx.fetchImpl(url)\n/* x.fetch(y) */" }]),
    ).toEqual([]);
  });
});
