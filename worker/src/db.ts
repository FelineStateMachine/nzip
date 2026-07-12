import {
  formatAddress,
  SITES_PER_VAULT,
  type Target,
  VAULT_SLOTS,
  vaultSlotOf,
} from "../../shared/mod.ts";
import type { PushInfo, SiteDetail, SiteInfo, VaultInfo } from "../../shared/mod.ts";
import { type Env, siteUrl } from "./env.ts";

export const HISTORY_CAP = 10;

export interface SiteRow {
  address: number;
  vault_slot: number;
  alias: string | null;
  current_manifest: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  password_hash: string | null;
  auth_version: number;
}

export interface VaultRow {
  slot: number;
  name: string;
  description: string | null;
  created_at: number;
}

export async function getSiteByAddress(
  env: Env,
  address: number,
): Promise<SiteRow | null> {
  return await env.DB.prepare("SELECT * FROM sites WHERE address = ?")
    .bind(address).first<SiteRow>();
}

export async function getVaultByName(
  env: Env,
  name: string,
): Promise<VaultRow | null> {
  return await env.DB.prepare("SELECT * FROM vaults WHERE name = ?").bind(name)
    .first<VaultRow>();
}

export async function getVaultBySlot(
  env: Env,
  slot: number,
): Promise<VaultRow | null> {
  return await env.DB.prepare("SELECT * FROM vaults WHERE slot = ?").bind(slot)
    .first<VaultRow>();
}

/** Resolve an API target to an existing site row, or null if it doesn't exist. */
export async function resolveTarget(
  env: Env,
  target: Target,
): Promise<SiteRow | null> {
  if ("address" in target) return await getSiteByAddress(env, target.address);
  const vault = await getVaultByName(env, target.vault);
  if (!vault) return null;
  return await env.DB.prepare(
    "SELECT * FROM sites WHERE vault_slot = ? AND alias = ?",
  )
    .bind(vault.slot, target.alias).first<SiteRow>();
}

/**
 * Pick a random free address within a vault. Random (not sequential) so URLs
 * don't leak site count or enumerate in order.
 */
export async function allocateAddress(env: Env, slot: number): Promise<number> {
  const taken = await env.DB.prepare(
    "SELECT address FROM sites WHERE vault_slot = ?",
  )
    .bind(slot).all<{ address: number }>();
  const used = new Set(taken.results.map((r) => r.address));
  if (used.size >= SITES_PER_VAULT) throw new Error("vault is full");
  for (let i = 0; i < 64; i++) {
    const candidate = (slot << 12) |
      (crypto.getRandomValues(new Uint32Array(1))[0] & 0xfff);
    if (!used.has(candidate)) return candidate;
  }
  // Vault nearly full and randomness unlucky: fall back to first free slot.
  for (let id = 0; id < SITES_PER_VAULT; id++) {
    const candidate = (slot << 12) | id;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("vault is full");
}

export interface CommitParams {
  address: number;
  vaultSlot: number;
  alias: string | null;
  manifestHash: string;
  expiresAt: number | null;
  /** undefined preserves an existing password; null explicitly clears it */
  passwordHash?: string | null;
  isNew: boolean;
  note?: string;
}

/** Atomic commit: upsert site, append history, prune beyond HISTORY_CAP. Returns new seq. */
export async function commitSite(env: Env, p: CommitParams): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const seqRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS s FROM pushes WHERE address = ?",
  )
    .bind(p.address).first<{ s: number }>();
  const seq = (seqRow?.s ?? 0) + 1;

  const siteCommit = p.isNew
    ? env.DB.prepare(
      `INSERT INTO sites (
         address, vault_slot, alias, current_manifest, created_at, updated_at, expires_at, password_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      p.address,
      p.vaultSlot,
      p.alias,
      p.manifestHash,
      now,
      now,
      p.expiresAt,
      p.passwordHash ?? null,
    )
    : p.passwordHash === undefined
    ? env.DB.prepare(
      `UPDATE sites SET current_manifest = ?, updated_at = ?, expires_at = ?, alias = COALESCE(?, alias)
       WHERE address = ?`,
    ).bind(p.manifestHash, now, p.expiresAt, p.alias, p.address)
    : env.DB.prepare(
      `UPDATE sites SET current_manifest = ?, updated_at = ?, expires_at = ?,
         alias = COALESCE(?, alias), password_hash = ?, auth_version = auth_version + 1
       WHERE address = ?`,
    ).bind(
      p.manifestHash,
      now,
      p.expiresAt,
      p.alias,
      p.passwordHash,
      p.address,
    );

  const statements = [
    siteCommit,
    env.DB.prepare(
      "INSERT INTO pushes (address, seq, manifest_hash, pushed_at, note) VALUES (?, ?, ?, ?, ?)",
    ).bind(p.address, seq, p.manifestHash, now, p.note ?? null),
    env.DB.prepare(
      "DELETE FROM pushes WHERE address = ? AND seq <= ?",
    ).bind(p.address, seq - HISTORY_CAP),
  ];
  await env.DB.batch(statements);
  return seq;
}

export async function listSites(
  env: Env,
  vaultSlot?: number,
): Promise<(SiteRow & { vault_name: string })[]> {
  const base =
    `SELECT s.*, v.name AS vault_name FROM sites s JOIN vaults v ON v.slot = s.vault_slot`;
  const stmt = vaultSlot === undefined
    ? env.DB.prepare(`${base} ORDER BY s.updated_at DESC`)
    : env.DB.prepare(
      `${base} WHERE s.vault_slot = ? ORDER BY s.updated_at DESC`,
    ).bind(vaultSlot);
  const res = await stmt.all<SiteRow & { vault_name: string }>();
  return res.results;
}

export async function siteHistory(
  env: Env,
  address: number,
): Promise<PushInfo[]> {
  const res = await env.DB.prepare(
    "SELECT seq, manifest_hash, pushed_at, note FROM pushes WHERE address = ? ORDER BY seq DESC",
  ).bind(address).all<
    {
      seq: number;
      manifest_hash: string;
      pushed_at: number;
      note: string | null;
    }
  >();
  return res.results.map((r) => ({
    seq: r.seq,
    manifestHash: r.manifest_hash,
    pushedAt: r.pushed_at,
    note: r.note,
  }));
}

export function vaultRowToInfo(row: VaultRow, siteCount: number): VaultInfo {
  return {
    slot: row.slot,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    siteCount,
  };
}

export async function listVaults(env: Env): Promise<VaultInfo[]> {
  const res = await env.DB.prepare(
    `SELECT v.slot, v.name, v.description, v.created_at, COUNT(s.address) AS site_count
     FROM vaults v LEFT JOIN sites s ON s.vault_slot = v.slot
     GROUP BY v.slot ORDER BY v.slot`,
  ).all<VaultRow & { site_count: number }>();
  return res.results.map((r) => vaultRowToInfo(r, r.site_count));
}

export async function createVault(
  env: Env,
  name: string,
  slot?: number,
  description: string | null = null,
): Promise<VaultRow> {
  const now = Math.floor(Date.now() / 1000);
  let chosen = slot;
  if (chosen === undefined) {
    const takenRes = await env.DB.prepare("SELECT slot FROM vaults").all<
      { slot: number }
    >();
    const taken = new Set(takenRes.results.map((r) => r.slot));
    for (let s = 0; s < VAULT_SLOTS; s++) {
      if (!taken.has(s)) {
        chosen = s;
        break;
      }
    }
    if (chosen === undefined) throw new Error("all 16 vault slots are taken");
  }
  await env.DB.prepare(
    "INSERT INTO vaults (slot, name, description, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(chosen, name, description, now).run();
  return { slot: chosen, name, description, created_at: now };
}

export async function updateVault(
  env: Env,
  currentName: string,
  patch: { name?: string; description?: string | null },
): Promise<VaultInfo | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    assignments.push("name = ?");
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    assignments.push("description = ?");
    values.push(patch.description);
  }
  if (assignments.length === 0) return null;

  const result = await env.DB.prepare(
    `UPDATE vaults SET ${assignments.join(", ")} WHERE name = ?`,
  ).bind(...values, currentName).run();
  if (result.meta.changes === 0) return null;

  const updatedName = patch.name ?? currentName;
  const row = await getVaultByName(env, updatedName);
  if (!row) return null;
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sites WHERE vault_slot = ?",
  ).bind(row.slot).first<{ n: number }>();
  return vaultRowToInfo(row, count?.n ?? 0);
}

export function siteRowToInfo(
  env: Env,
  row: SiteRow,
  vaultName: string,
): SiteInfo {
  const address = formatAddress(row.address);
  return {
    address,
    vault: vaultName,
    alias: row.alias,
    manifestHash: row.current_manifest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    url: siteUrl(env, address),
    protected: row.password_hash !== null,
  };
}

export async function siteRowToDetail(
  env: Env,
  row: SiteRow,
): Promise<SiteDetail> {
  const vault = await getVaultBySlot(env, vaultSlotOf(row.address));
  return {
    ...siteRowToInfo(env, row, vault?.name ?? `slot-${row.vault_slot}`),
    history: await siteHistory(env, row.address),
  };
}
