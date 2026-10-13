import { formatPushPolicy } from "./push.ts";
import { printableNote } from "./sites.ts";

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

Deno.test("push feedback reports when visitor feedback is on", () => {
  assertEquals(formatPushPolicy(null, true, true), "forever, password protected, feedback on");
});

Deno.test("feedback notes cannot drive the terminal", () => {
  assertEquals(printableNote("ok\x1b]0;pwned\x07\x1b[2K\tnext\nline"), "ok]0;pwned[2K\tnext\nline");
});
