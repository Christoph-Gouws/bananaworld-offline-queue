import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const here = import.meta.dirname;
const support = (name: string) => resolve(here, "tests/support", name);

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    // The suites ported from the DC import `@/lib/offline-queue` and `@/sw/*`. They are pointed at the
    // package source, bound to NEUTRAL settings (tests/support/neutral-settings.ts) — never the DC's.
    alias: [
      { find: "@/lib/offline-queue/schema", replacement: support("schema.ts") },
      { find: /^@\/lib\/offline-queue$/, replacement: support("offline-queue.ts") },
      { find: "@/sw/message-handlers", replacement: support("message-handlers.ts") },
      { find: "@/sw/build-id", replacement: support("build-id.ts") },
      { find: "@/sw/pre-update-clear", replacement: support("pre-update-clear.ts") },
      { find: /^@\/sw\/(.*)$/, replacement: resolve(here, "src/sw/$1") },
    ],
  },
});
