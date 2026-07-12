import { parseSiteInvocation } from "./site.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("site groups the complete target lifecycle", () => {
  assertEquals(parseSiteInvocation(["push", "./demo", "work:demo"]), {
    kind: "push",
    source: "./demo",
    target: "work:demo",
  });
  assertEquals(parseSiteInvocation(["cp", "work:demo", "./demo"]), {
    kind: "cp",
    target: "work:demo",
    dir: "./demo",
  });
  assertEquals(parseSiteInvocation(["show", "work:demo"]), {
    kind: "show",
    target: "work:demo",
  });
  assertEquals(parseSiteInvocation(["update", "work:demo"]), {
    kind: "update",
    target: "work:demo",
  });
  assertEquals(parseSiteInvocation(["ls", "work"]), { kind: "ls", vault: "work" });
  assertEquals(parseSiteInvocation(["where", "work:demo"]), {
    kind: "where",
    target: "work:demo",
  });
  assertEquals(parseSiteInvocation(["rm", "work:demo"]), {
    kind: "rm",
    target: "work:demo",
  });
  assertEquals(parseSiteInvocation(["revert", "work:demo"]), {
    kind: "revert",
    target: "work:demo",
  });
});
