// Transport-independent upload/commit operation. No printing, prompts, or local state.
import type { CommitRequest, CommitResponse } from "@nzip/shared";
import type { ApiClient } from "./api.ts";
import type { Bundle } from "./bundle.ts";

export interface PublishProgress {
  progress: number;
  total: number;
  message: string;
}

export type PublishResult = CommitResponse & {
  files: number;
  newBlobs: number;
  dedupedBlobs: number;
  warnings: string[];
};

export async function publishBundle(
  api: Pick<ApiClient, "prepare" | "uploadBlob" | "commit">,
  bundle: Bundle,
  policy: Omit<CommitRequest, "manifest">,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: PublishProgress) => void | Promise<void>;
  } = {},
): Promise<PublishResult> {
  options.signal?.throwIfAborted();
  const prep = await api.prepare(bundle.manifest);
  const total = prep.missing.length + 1; // commit is the final step
  const report = async (progress: number, message: string) => {
    // Progress is advisory; a disconnected observer must not turn an accepted commit into failure.
    try {
      await options.onProgress?.({ progress, total, message });
    } catch { /* best effort */ }
  };
  await report(0, `Prepared ${prep.missing.length} new blobs`);
  let done = 0;
  let failed = false;
  const queue = [...prep.missing];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    try {
      while (!failed && queue.length) {
        options.signal?.throwIfAborted();
        const hash = queue.shift()!;
        const bytes = bundle.blobs.get(hash);
        if (!bytes) throw new Error(`internal: missing blob bytes for ${hash}`);
        await api.uploadBlob(hash, bytes);
        await report(++done, `Uploaded ${done}/${prep.missing.length} blobs`);
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  });
  // Drain in-flight uploads even when one fails; never commit a partial upload.
  const uploaded = await Promise.allSettled(workers);
  for (const result of uploaded) {
    if (result.status === "rejected") throw result.reason;
  }
  options.signal?.throwIfAborted();
  const result = await api.commit({ manifest: bundle.manifest, ...policy });
  await report(total, "Published");
  return {
    ...result,
    files: Object.keys(bundle.manifest.files).length,
    newBlobs: prep.missing.length,
    dedupedBlobs: bundle.blobs.size - prep.missing.length,
    warnings: bundle.warnings,
  };
}
