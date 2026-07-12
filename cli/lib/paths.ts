// Local breadcrumb registry: which directory on *this* machine produced each
// pushed site. The server never learns the source path, so we keep a small
// map here so `nzip site where <target>` can answer "where does that live on disk".
//
// Kept clean by three forces: expired entries are dropped on every write,
// `nzip site rm` deletes its entry, and `nzip site ls` reconciles against the live set.

import { join, resolve } from "@std/path";
import { configDir } from "./config.ts";

export interface PathEntry {
  address: string; // 4-hex, canonical identity of the site
  vault?: string;
  alias?: string;
  path: string; // absolute source dir/file this machine pushed from
  url: string;
  expiresAt: number | null; // unix seconds, null = permanent
  pushedAt: number; // unix seconds
}

/** address → entry */
type Registry = Record<string, PathEntry>;

function pathsFile(): string {
  return join(configDir(), "paths.json");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function load(): Promise<Registry> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(pathsFile())) as Registry;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function save(reg: Registry): Promise<void> {
  await Deno.mkdir(configDir(), { recursive: true });
  const file = pathsFile();
  await Deno.writeTextFile(file, JSON.stringify(reg, null, 2) + "\n");
  await Deno.chmod(file, 0o600);
}

/** Drop entries whose TTL has already elapsed — the server has GC'd them. */
function pruneExpired(reg: Registry, now = nowSeconds()): Registry {
  for (const [addr, e] of Object.entries(reg)) {
    if (e.expiresAt !== null && e.expiresAt <= now) delete reg[addr];
  }
  return reg;
}

/** Record (or refresh) the source path for a site just pushed from `path`. */
export async function recordPush(entry: {
  address: string;
  vault?: string;
  alias?: string | null;
  path: string;
  url: string;
  expiresAt: number | null;
}): Promise<void> {
  const reg = pruneExpired(await load());
  // An alias points at exactly one address at a time; clear any stale
  // entry that still claims this vault:alias under a different address.
  if (entry.vault && entry.alias) {
    for (const [addr, e] of Object.entries(reg)) {
      if (
        addr !== entry.address && e.vault === entry.vault &&
        e.alias === entry.alias
      ) {
        delete reg[addr];
      }
    }
  }
  let abs: string;
  try {
    abs = Deno.realPathSync(entry.path); // canonical absolute path; file exists now
  } catch {
    abs = resolve(entry.path);
  }
  reg[entry.address] = {
    address: entry.address,
    vault: entry.vault,
    alias: entry.alias ?? undefined,
    path: abs,
    url: entry.url,
    expiresAt: entry.expiresAt,
    pushedAt: nowSeconds(),
  };
  await save(reg);
}

/** Look up a tracked source path by address or by vault:alias. */
export async function lookup(
  q: { address?: string; vault?: string; alias?: string },
): Promise<PathEntry | null> {
  const reg = pruneExpired(await load());
  if (q.address && reg[q.address]) return reg[q.address];
  if (q.vault && q.alias) {
    for (const e of Object.values(reg)) {
      if (e.vault === q.vault && e.alias === q.alias) return e;
    }
  }
  return null;
}

/** Rewrite breadcrumbs after `nzip vault update --name` so `nzip site where` keeps working. */
export async function renameVault(
  oldName: string,
  newName: string,
): Promise<void> {
  const reg = pruneExpired(await load());
  for (const e of Object.values(reg)) {
    if (e.vault === oldName) e.vault = newName;
  }
  await save(reg);
}

/** Forget a single site (called from `nzip site rm`). */
export async function forget(
  q: { address?: string; vault?: string; alias?: string },
): Promise<void> {
  const reg = await load();
  let changed = false;
  for (const [addr, e] of Object.entries(reg)) {
    const hit = (q.address && addr === q.address) ||
      (q.vault && q.alias && e.vault === q.vault && e.alias === q.alias);
    if (hit) {
      delete reg[addr];
      changed = true;
    }
  }
  if (changed) await save(reg);
}

/**
 * Drop registry entries the server no longer lists. `live` is the set of
 * addresses returned by the API; when `scopeVault` is set only entries in
 * that vault are eligible for removal (the listing was vault-scoped).
 */
export async function reconcile(
  live: Set<string>,
  scopeVault?: string,
): Promise<void> {
  const reg = pruneExpired(await load());
  let changed = false;
  for (const [addr, e] of Object.entries(reg)) {
    if (scopeVault && e.vault !== scopeVault) continue;
    if (!live.has(addr)) {
      delete reg[addr];
      changed = true;
    }
  }
  // pruneExpired above may also have removed entries — persist either way.
  await save(reg);
  void changed;
}
