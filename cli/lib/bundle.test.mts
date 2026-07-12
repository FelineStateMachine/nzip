import { MAX_BLOB_BYTES, MAX_UNIQUE_BLOBS } from "@nzip/shared";
import { buildBundle } from "./bundle.ts";

Deno.test("bundle rejects an oversized file before reading it", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/oversized.bin`;
  try {
    await Deno.writeFile(path, new Uint8Array());
    await Deno.truncate(path, MAX_BLOB_BYTES + 1);
    try {
      await buildBundle(path);
      throw new Error("expected oversized bundle to be rejected");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("file too large (max 50 MiB)")
      ) {
        throw error;
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundle rejects the first unique blob above the Worker ceiling", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Promise.all(
      Array.from(
        { length: MAX_UNIQUE_BLOBS + 1 },
        (_, i) => Deno.writeTextFile(`${dir}/file-${i}.txt`, `unique-${i}`),
      ),
    );
    try {
      await buildBundle(dir);
      throw new Error("expected excessive unique blobs to be rejected");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes(
          `too many unique blobs (max ${MAX_UNIQUE_BLOBS})`,
        )
      ) {
        throw error;
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
