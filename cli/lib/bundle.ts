// Directory walking, hashing, and manifest building for `nzip push`.

import { globToRegExp, join, relative } from "@std/path";
import { contentTypeFor, sha256hex, validatePath } from "@nzip/shared";
import type { Manifest } from "@nzip/shared";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface Bundle {
  manifest: Manifest;
  /** blob hash → bytes (deduped) */
  blobs: Map<string, Uint8Array>;
  totalBytes: number;
  warnings: string[];
}

async function loadIgnore(dir: string): Promise<RegExp[]> {
  try {
    const text = await Deno.readTextFile(join(dir, ".nzipignore"));
    return text.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((glob) => globToRegExp(glob, { extended: true, globstar: true }));
  } catch {
    return [];
  }
}

async function* walk(root: string, dir: string, ignore: RegExp[]): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (ignore.some((re) => re.test(rel))) continue;
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(root, full, ignore);
    } else if (entry.isFile) {
      yield rel;
    }
  }
}

export async function buildBundle(path: string): Promise<Bundle> {
  const stat = await Deno.stat(path);
  const warnings: string[] = [];
  const manifest: Manifest = { v: 1, files: {} };
  const blobs = new Map<string, Uint8Array>();
  let totalBytes = 0;

  const addFile = async (storedPath: string, filePath: string) => {
    const bytes = await Deno.readFile(filePath);
    const hash = await sha256hex(bytes);
    manifest.files[storedPath] = { h: hash, s: bytes.length, ct: contentTypeFor(storedPath) };
    if (!blobs.has(hash)) blobs.set(hash, bytes);
    totalBytes += bytes.length;
  };

  if (stat.isFile) {
    // Single-file push: an HTML file becomes the site's index.html.
    const name = path.split("/").pop()!;
    const stored = /\.html?$/i.test(name) ? "index.html" : name;
    await addFile(stored, path);
    return { manifest, blobs, totalBytes, warnings };
  }

  const ignore = await loadIgnore(path);
  for await (const rel of walk(path, path, ignore)) {
    const stored = rel.replaceAll("\\", "/");
    if (!validatePath(stored)) {
      warnings.push(`skipped (unsupported path): ${stored}`);
      continue;
    }
    await addFile(stored, join(path, rel));
  }

  if (Object.keys(manifest.files).length === 0) {
    throw new Error(`no files to push in ${path}`);
  }
  if (!manifest.files["index.html"]) {
    warnings.push("no root index.html — the site URL will 404 until one exists");
  }
  return { manifest, blobs, totalBytes, warnings };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
