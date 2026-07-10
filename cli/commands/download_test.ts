import { type Manifest, sha256hex, type SourceResponse } from "@nzip/shared";
import { downloadSource } from "./download.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("downloadSource reconstructs each manifest file and reports the total", async () => {
  const files = new Map<string, Uint8Array>([
    ["index.html", new TextEncoder().encode("<h1>recovered</h1>\n")],
    ["assets/app.js", new TextEncoder().encode("console.log('ok')\n")],
  ]);
  const manifest: Manifest = { v: 1, files: {} };
  for (const [path, bytes] of files) {
    manifest.files[path] = { h: await sha256hex(bytes), s: bytes.length, ct: "text/plain" };
  }
  const response: SourceResponse = { address: "2a3f", manifestHash: "a".repeat(64), manifest };
  const byHash = new Map(Object.values(manifest.files).map((entry) => [entry.h, entry]));
  const output = await Deno.makeTempDir();

  try {
    const result = await downloadSource(
      {
        source: async () => response,
        downloadSourceBlob: async (_target, hash) => {
          const entry = byHash.get(hash)!;
          return files.get(Object.entries(manifest.files).find(([, f]) => f === entry)![0])!;
        },
      },
      "work:demo",
      output,
      false,
    );

    assertEquals(await Deno.readTextFile(`${output}/index.html`), "<h1>recovered</h1>\n");
    assertEquals(await Deno.readTextFile(`${output}/assets/app.js`), "console.log('ok')\n");
    assertEquals(result, {
      address: "2a3f",
      manifestHash: "a".repeat(64),
      destination: output,
      files: 2,
      bytes: 37,
    });
  } finally {
    await Deno.remove(output, { recursive: true });
  }
});
