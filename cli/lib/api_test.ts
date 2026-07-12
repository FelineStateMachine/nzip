import { commitTargetFor, resolveCliTarget } from "./api.ts";
import type { Config } from "./config.ts";

const unrestricted: Config = {
  server: "https://example.com",
  token: "test",
};

const restricted: Config = {
  ...unrestricted,
  allowVaults: ["home"],
};

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw error;
  }
  throw new Error(`expected error containing ${JSON.stringify(message)}`);
}

Deno.test("raw addresses remain available without allowVaults", () => {
  assertEquals(resolveCliTarget("2a3f", unrestricted), "2a3f");
  assertEquals(commitTargetFor("2a3f", unrestricted), { address: 0x2a3f });
});

Deno.test("resolveCliTarget refuses a raw address when allowVaults is set", () => {
  assertThrows(
    () => resolveCliTarget("2a3f", restricted),
    "raw address targets are not allowed by this config because allowVaults is set",
  );
});

Deno.test("commitTargetFor refuses a raw address when allowVaults is set", () => {
  assertThrows(
    () => commitTargetFor("2a3f", restricted),
    "raw address targets are not allowed by this config because allowVaults is set",
  );
});

Deno.test("allowVaults still accepts an allowed named target", () => {
  assertEquals(resolveCliTarget("home:demo", restricted), "home:demo");
  assertEquals(commitTargetFor("home:demo", restricted), {
    vault: "home",
    alias: "demo",
  });
});
