import { cmdVault } from "./vault.ts";
import { setJsonMode } from "../lib/fmt.ts";

Deno.test("vault policy flags forward rules and read passwords from files without printing them", async () => {
  const directory = await Deno.makeTempDir();
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const bodies: Record<string, unknown>[] = [];
  const output: string[] = [];
  await Deno.writeTextFile(`${directory}/password`, "private-visitor-password\n");
  globalThis.fetch = ((_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      Response.json({
        name: "reviews",
        hasDefaultPassword: true,
        requirePassword: true,
        maxTtl: 14,
      }),
    );
  }) as typeof fetch;
  console.log = (...args) => {
    output.push(args.map(String).join(" "));
  };
  setJsonMode(true);
  try {
    await cmdVault(
      { server: "https://test.invalid", token: "test-token", defaultVault: "reviews" },
      ["update", "reviews"],
      {
        description: "Private reviews",
        defaultTtl: "7d",
        maxTtl: "14d",
        requirePassword: true,
        defaultPasswordFile: `${directory}/password`,
      },
    );
    const policy = bodies[0];
    if (
      policy.maxTtl !== 14 || policy.defaultTtl !== 7 || policy.requirePassword !== true ||
      policy.defaultPassword !== "private-visitor-password"
    ) throw new Error("incorrect vault policy payload");
    if (output.join().includes("private-visitor-password")) throw new Error("password was printed");
    await cmdVault({ server: "https://test.invalid", token: "test-token" }, ["update", "reviews"], {
      maxTtl: "none",
      requirePassword: false,
      clearDefaultPassword: true,
    });
    if (
      bodies[1].maxTtl !== null || bodies[1].requirePassword !== false ||
      bodies[1].defaultPassword !== null
    ) {
      throw new Error("explicit policy clearing was not preserved");
    }
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    setJsonMode(false);
    await Deno.remove(directory, { recursive: true });
  }
});
