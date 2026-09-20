import type { CommitResponse } from "@nzip/shared";
import type { Bundle } from "./bundle.ts";
import { publishBundle } from "./publish.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const bundle: Bundle = {
  manifest: { v: 1, files: {} },
  blobs: new Map([["one", new Uint8Array([1])], ["two", new Uint8Array([2])]]),
  totalBytes: 2,
  warnings: [],
};

Deno.test("publish waits for in-flight uploads and never commits after an upload failure", async () => {
  let drained = false;
  let committed = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = publishBundle(
    {
      prepare: () => Promise.resolve({ manifestHash: "hash", missing: ["one", "two"] }),
      uploadBlob: async (hash) => {
        if (hash === "one") {
          release();
          throw new Error("upload failed");
        }
        await pending;
        drained = true;
        return { ok: true };
      },
      commit: () => {
        committed = true;
        return Promise.resolve({} as CommitResponse);
      },
    },
    bundle,
    { target: { vault: "home" } },
  );
  try {
    await result;
    throw new Error("expected failure");
  } catch (error) {
    assert(error instanceof Error && error.message === "upload failed");
  }
  assert(drained && !committed);
});

Deno.test("publish cancellation between upload and commit prevents commit", async () => {
  const controller = new AbortController();
  let committed = false;
  try {
    await publishBundle(
      {
        prepare: () => Promise.resolve({ manifestHash: "hash", missing: ["one"] }),
        uploadBlob: () => {
          controller.abort();
          return Promise.resolve({ ok: true });
        },
        commit: () => {
          committed = true;
          return Promise.resolve({} as CommitResponse);
        },
      },
      bundle,
      { target: { vault: "home" } },
      { signal: controller.signal },
    );
    throw new Error("expected cancellation");
  } catch (error) {
    assert(error instanceof DOMException && error.name === "AbortError");
  }
  assert(!committed);
});

Deno.test("progress observer failures do not misreport an accepted commit", async () => {
  const result = await publishBundle(
    {
      prepare: () => Promise.resolve({ manifestHash: "hash", missing: [] }),
      uploadBlob: () => {
        throw new Error("not needed");
      },
      commit: () => Promise.resolve({ address: "2001" } as CommitResponse),
    },
    bundle,
    { target: { vault: "home" } },
    {
      onProgress: () => {
        throw new Error("observer disconnected");
      },
    },
  );
  assert(result.address === "2001");
});
