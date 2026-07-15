import { formatPushPolicy } from "./push.ts";

function assertEquals(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}

Deno.test("push feedback reports permanent password protection", () => {
  assertEquals(formatPushPolicy(null, true), "forever, password protected");
});

Deno.test("push feedback reports finite expiry without password protection", () => {
  assertStringIncludes(
    formatPushPolicy(Math.floor(Date.now() / 1000) + 86_400, false),
    "expires in 1d, no password",
  );
});
