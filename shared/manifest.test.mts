import { MAX_BLOB_BYTES, MAX_UNIQUE_BLOBS } from "./limits.ts";
import { validateManifest } from "./manifest.ts";
import type { Manifest } from "./types.ts";

function manifestWithUniqueBlobs(count: number): Manifest {
  const files: Manifest["files"] = {};
  for (let i = 0; i < count; i++) {
    files[`file-${i}.txt`] = {
      h: i.toString(16).padStart(64, "0"),
      s: 1,
      ct: "text/plain",
    };
  }
  return { v: 1, files };
}

function assertThrows(fn: () => void, message: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw error;
  }
  throw new Error(`expected error containing: ${message}`);
}

Deno.test("manifest accepts the Workers Free unique-blob ceiling", () => {
  validateManifest(manifestWithUniqueBlobs(MAX_UNIQUE_BLOBS));
});

Deno.test("manifest rejects one unique blob above the Workers Free ceiling", () => {
  assertThrows(
    () => validateManifest(manifestWithUniqueBlobs(MAX_UNIQUE_BLOBS + 1)),
    `too many unique blobs (max ${MAX_UNIQUE_BLOBS})`,
  );
});

Deno.test("duplicate hashes do not consume additional unique-blob capacity", () => {
  const manifest = manifestWithUniqueBlobs(MAX_UNIQUE_BLOBS);
  manifest.files["duplicate.txt"] = { ...manifest.files["file-0.txt"] };
  validateManifest(manifest);
  if (Object.keys(manifest.files).length !== MAX_UNIQUE_BLOBS + 1) {
    throw new Error("duplicate manifest entry was not retained");
  }
});

Deno.test("manifest rejects blobs larger than the upload limit", () => {
  const manifest = manifestWithUniqueBlobs(1);
  manifest.files["file-0.txt"].s = MAX_BLOB_BYTES + 1;
  assertThrows(() => validateManifest(manifest), "blob too large");
});
