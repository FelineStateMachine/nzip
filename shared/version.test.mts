import { VERSION } from "./version.ts";

Deno.test("workspace package versions match the runtime version", async () => {
  const cli = JSON.parse(await Deno.readTextFile("cli/deno.json"));
  const shared = JSON.parse(await Deno.readTextFile("shared/deno.json"));
  if (cli.version !== VERSION || shared.version !== VERSION) {
    throw new Error(
      `version mismatch: runtime=${VERSION}, cli=${cli.version}, shared=${shared.version}`,
    );
  }
});
