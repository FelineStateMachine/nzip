// Recover the current uploaded bundle for a site into a local directory.

import { dirname, join } from "@std/path";
import { sha256hex, validatePath } from "@nzip/shared";
import { ApiClient, resolveCliTarget } from "../lib/api.ts";
import { formatBytes } from "../lib/bundle.ts";
import type { Config } from "../lib/config.ts";
import { bold, cyan, emit, fail, green } from "../lib/fmt.ts";

const DOWNLOAD_CONCURRENCY = 6;

interface SourceApi {
  source(target: string): ReturnType<ApiClient["source"]>;
  downloadSourceBlob(target: string, hash: string): ReturnType<ApiClient["downloadSourceBlob"]>;
}

export interface CopyResult {
  address: string;
  manifestHash: string;
  destination: string;
  files: number;
  bytes: number;
}

function targetOrFail(raw: string | undefined, config: Config): string {
  if (!raw) fail("usage: nzip cp <target> [dir] [--overwrite]");
  try {
    return resolveCliTarget(raw, config);
  } catch (e) {
    return fail((e as Error).message);
  }
}

async function prepareDestination(path: string, overwrite: boolean): Promise<void> {
  try {
    const stat = await Deno.lstat(path);
    if (!stat.isDirectory || stat.isSymlink) fail(`destination is not a directory: ${path}`);
    for await (const _entry of Deno.readDir(path)) {
      if (!overwrite) fail(`destination is not empty: ${path} (pass --overwrite to replace files)`);
      break;
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      await Deno.mkdir(path, { recursive: true });
      return;
    }
    throw e;
  }
}

async function makeParent(path: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
}

async function writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<void> {
  try {
    const existing = await Deno.lstat(path);
    if (existing.isDirectory || existing.isSymlink) fail(`refusing to replace non-file: ${path}`);
    if (!overwrite) fail(`destination file already exists: ${path}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const temporary = `${path}.nzip-download-${crypto.randomUUID()}`;
  try {
    await Deno.writeFile(temporary, bytes);
    await Deno.rename(temporary, path);
  } finally {
    await Deno.remove(temporary).catch(() => {});
  }
}

export async function cmdCp(
  config: Config,
  raw: string | undefined,
  destinationRaw: string | undefined,
  overwrite: boolean,
): Promise<void> {
  const target = targetOrFail(raw, config);
  const api = new ApiClient(config);
  const result = await downloadSource(api, target, destinationRaw, overwrite);

  emit(
    () =>
      console.log(
        `${green("✓")} copied ${bold(result.address)} → ${
          cyan(result.destination)
        }  (${result.files} files, ${formatBytes(result.bytes)})`,
      ),
    { ok: true, ...result },
  );
}

/** Reconstruct a source response locally; exported to keep recovery behavior testable. */
export async function downloadSource(
  api: SourceApi,
  target: string,
  destinationRaw: string | undefined,
  overwrite: boolean,
): Promise<CopyResult> {
  const source = await api.source(target);
  const destination = destinationRaw ?? `${source.address}-source`;
  await prepareDestination(destination, overwrite);

  const files = Object.entries(source.manifest.files);
  const totalBytes = files.reduce((total, [, entry]) => total + entry.s, 0);
  const queue = [...files];
  let downloaded = 0;
  const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const [relativePath, entry] = next;
      if (!validatePath(relativePath)) fail(`invalid path in source manifest: ${relativePath}`);
      const bytes = await api.downloadSourceBlob(target, entry.h);
      if (bytes.length !== entry.s) fail(`size mismatch while downloading ${relativePath}`);
      if (await sha256hex(bytes) !== entry.h) {
        fail(`hash mismatch while downloading ${relativePath}`);
      }
      const outputPath = join(destination, ...relativePath.split("/"));
      await makeParent(outputPath);
      await writeFile(outputPath, bytes, overwrite);
      downloaded++;
    }
  });
  await Promise.all(workers);

  return {
    address: source.address,
    manifestHash: source.manifestHash,
    destination,
    files: downloaded,
    bytes: totalBytes,
  };
}
