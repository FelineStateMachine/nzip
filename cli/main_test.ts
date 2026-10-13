import { VERSION } from "@nzip/shared";
import { main } from "./main.ts";
import { parseCliArgs } from "./lib/args.ts";

async function captureStdout(argv: string[]): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await main(argv);
  } finally {
    console.log = original;
  }
  return lines;
}

Deno.test("version prints the installed CLI version without configuration", async () => {
  const lines = await captureStdout(["--version"]);
  if (lines.length !== 1 || lines[0] !== `nzip ${VERSION}`) {
    throw new Error(`unexpected version output: ${JSON.stringify(lines)}`);
  }
});

Deno.test("version supports agent-readable JSON", async () => {
  const lines = await captureStdout(["--version", "--json"]);
  if (lines.length !== 1) throw new Error(`unexpected version output: ${JSON.stringify(lines)}`);

  const output = JSON.parse(lines[0]);
  if (output.version !== VERSION) {
    throw new Error(`unexpected version JSON: ${lines[0]}`);
  }
});

Deno.test("hex addresses that look numeric stay strings", () => {
  const positionals = parseCliArgs(["site", "push", "./page", "3e21", "0123"])._;
  if (JSON.stringify(positionals) !== JSON.stringify(["site", "push", "./page", "3e21", "0123"])) {
    throw new Error(`positionals were coerced: ${JSON.stringify(positionals)}`);
  }
});
