import {
  formatAddress,
  GLOBAL_DEFAULT_TTL,
  SITES_PER_VAULT,
  type Target,
  VAULT_SLOTS,
  vaultSlotOf,
} from "../../shared/mod.ts";
import type {
  AppReservationInfo,
  DefaultVaults,
  PushInfo,
  SiteDetail,
  SiteInfo,
  Ttl,
  VaultInfo,
  VaultLifecycle,
} from "../../shared/mod.ts";
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
  content_security_policy: string | null;
  auth_version: number;
}

export interface VaultRow {
  slot: number;
  name: string;
  description: string | null;
  default_ttl: number | null;
  created_at: number;
}

export interface AppReservationRow {
  address: number;
  vault_slot: number;
  alias: string;
  created_at: number;
  retired_at: number | null;
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

export async function getAppReservationByAddress(
  env: Env,
  address: number,
): Promise<AppReservationRow | null> {
  return await env.DB.prepare(
    "SELECT * FROM app_reservations WHERE address = ?",
  ).bind(address).first<AppReservationRow>();
}

export async function getAppReservationByAlias(
  env: Env,
  vaultSlot: number,
  alias: string,
): Promise<AppReservationRow | null> {
  return await env.DB.prepare(
    "SELECT * FROM app_reservations WHERE vault_slot = ? AND alias = ?",
  ).bind(vaultSlot, alias).first<AppReservationRow>();
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
    `SELECT address FROM sites WHERE vault_slot = ?
     UNION
     SELECT address FROM app_reservations WHERE vault_slot = ?`,
  )
    .bind(slot, slot).all<{ address: number }>();
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
  /** undefined preserves an existing CSP; null explicitly clears it */
  contentSecurityPolicy?: string | null;
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
         address, vault_slot, alias, current_manifest, created_at, updated_at, expires_at,
         password_hash, content_security_policy
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      p.address,
      p.vaultSlot,
      p.alias,
      p.manifestHash,
      now,
      now,
      p.expiresAt,
      p.passwordHash ?? null,
      p.contentSecurityPolicy ?? null,
    )
    : p.passwordHash === undefined && p.contentSecurityPolicy === undefined
    ? env.DB.prepare(
      `UPDATE sites SET current_manifest = ?, updated_at = ?, expires_at = ?, alias = COALESCE(?, alias)
       WHERE address = ?`,
    ).bind(p.manifestHash, now, p.expiresAt, p.alias, p.address)
    : env.DB.prepare(
      `UPDATE sites SET current_manifest = ?, updated_at = ?, expires_at = ?,
         alias = COALESCE(?, alias),
         password_hash = CASE WHEN ? = 1 THEN ? ELSE password_hash END,
         content_security_policy = CASE WHEN ? = 1 THEN ? ELSE content_security_policy END,
         auth_version = auth_version + ?
       WHERE address = ?`,
    ).bind(
      p.manifestHash,
      now,
      p.expiresAt,
      p.alias,
      p.passwordHash === undefined ? 0 : 1,
      p.passwordHash ?? null,
      p.contentSecurityPolicy === undefined ? 0 : 1,
      p.contentSecurityPolicy ?? null,
      p.passwordHash === undefined ? 0 : 1,
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

export function vaultRowToInfo(
  row: VaultRow,
  siteCount: number,
  defaultFor: VaultLifecycle[] = [],
): VaultInfo {
  const defaultTtl: Ttl | null = row.default_ttl === null
    ? null
    : row.default_ttl === 0
    ? "forever"
    : row.default_ttl;
  return {
    slot: row.slot,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    siteCount,
    defaultTtl,
    effectiveDefaultTtl: defaultTtl ?? GLOBAL_DEFAULT_TTL,
    defaultFor,
  };
}

export async function listVaults(env: Env): Promise<VaultInfo[]> {
  const [res, defaults] = await Promise.all([
    env.DB.prepare(
      `SELECT v.slot, v.name, v.description, v.default_ttl,
            v.created_at, COUNT(s.address) AS site_count
     FROM vaults v LEFT JOIN sites s ON s.vault_slot = v.slot
     GROUP BY v.slot ORDER BY v.slot`,
    ).all<VaultRow & { site_count: number }>(),
    env.DB.prepare("SELECT lifecycle, vault_slot FROM vault_defaults")
      .all<{ lifecycle: VaultLifecycle; vault_slot: number }>(),
  ]);
  return res.results.map((r) =>
    vaultRowToInfo(
      r,
      r.site_count,
      defaults.results.filter((item) => item.vault_slot === r.slot).map((
        item,
      ) => item.lifecycle),
    )
  );
}

export async function createVault(
  env: Env,
  name: string,
  slot?: number,
  description: string | null = null,
  defaultTtl: Ttl | null = null,
  defaultFor: VaultLifecycle | null = null,
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
  const insert = env.DB.prepare(
    `INSERT INTO vaults
     (slot, name, description, default_ttl, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      chosen,
      name,
      description,
      defaultTtl === "forever" ? 0 : defaultTtl,
      now,
    );
  if (defaultFor === null) await insert.run();
  else {
    await env.DB.batch([
      insert,
      env.DB.prepare(
        `INSERT INTO vault_defaults (lifecycle, vault_slot) VALUES (?, ?)
         ON CONFLICT(lifecycle) DO UPDATE SET vault_slot = excluded.vault_slot`,
      ).bind(defaultFor, chosen),
    ]);
  }
  return {
    slot: chosen,
    name,
    description,
    default_ttl: defaultTtl === "forever" ? 0 : defaultTtl,
    created_at: now,
  };
}

export async function updateVault(
  env: Env,
  currentName: string,
  patch: {
    name?: string;
    description?: string | null;
    defaultTtl?: Ttl | null;
    defaultFor?: VaultLifecycle | null;
  },
): Promise<VaultInfo | null> {
  const current = await getVaultByName(env, currentName);
  if (!current) return null;
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
  if (patch.defaultTtl !== undefined) {
    assignments.push("default_ttl = ?");
    values.push(patch.defaultTtl === "forever" ? 0 : patch.defaultTtl);
  }
  const statements: D1PreparedStatement[] = [];
  if (assignments.length > 0) {
    statements.push(
      env.DB.prepare(
        `UPDATE vaults SET ${assignments.join(", ")} WHERE name = ?`,
      )
        .bind(...values, currentName),
    );
  }
  if (patch.defaultFor === null) {
    statements.push(
      env.DB.prepare("DELETE FROM vault_defaults WHERE vault_slot = ?").bind(
        current.slot,
      ),
    );
  } else if (patch.defaultFor !== undefined) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO vault_defaults (lifecycle, vault_slot) VALUES (?, ?)
         ON CONFLICT(lifecycle) DO UPDATE SET vault_slot = excluded.vault_slot`,
      ).bind(patch.defaultFor, current.slot),
    );
  }
  if (statements.length === 0) return null;
  await env.DB.batch(statements);

  const updatedName = patch.name ?? currentName;
  const row = await getVaultByName(env, updatedName);
  if (!row) return null;
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sites WHERE vault_slot = ?",
  ).bind(row.slot).first<{ n: number }>();
  const defaults = await env.DB.prepare(
    "SELECT lifecycle FROM vault_defaults WHERE vault_slot = ? ORDER BY lifecycle",
  ).bind(row.slot).all<{ lifecycle: VaultLifecycle }>();
  return vaultRowToInfo(
    row,
    count?.n ?? 0,
    defaults.results.map((r) => r.lifecycle),
  );
}

export async function defaultVaults(env: Env): Promise<DefaultVaults> {
  const rows = await env.DB.prepare(
    `SELECT v.name, d.lifecycle
     FROM vault_defaults d JOIN vaults v ON v.slot = d.vault_slot`,
  ).all<{ name: string; lifecycle: VaultLifecycle }>();
  const result: DefaultVaults = { temporary: null, permanent: null };
  for (const row of rows.results) result[row.lifecycle] = row.name;
  return result;
}

export async function setDefaultVault(
  env: Env,
  lifecycle: VaultLifecycle,
  name: string,
): Promise<VaultInfo | null> {
  const vault = await getVaultByName(env, name);
  if (!vault) return null;
  await env.DB.prepare(
    `INSERT INTO vault_defaults (lifecycle, vault_slot) VALUES (?, ?)
     ON CONFLICT(lifecycle) DO UPDATE SET vault_slot = excluded.vault_slot`,
  ).bind(lifecycle, vault.slot).run();
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sites WHERE vault_slot = ?",
  ).bind(vault.slot).first<{ n: number }>();
  const defaults = await env.DB.prepare(
    "SELECT lifecycle FROM vault_defaults WHERE vault_slot = ? ORDER BY lifecycle",
  ).bind(vault.slot).all<{ lifecycle: VaultLifecycle }>();
  return vaultRowToInfo(
    vault,
    count?.n ?? 0,
    defaults.results.map((r) => r.lifecycle),
  );
}

export async function reserveAppOrigin(
  env: Env,
  vault: VaultRow,
  alias: string,
): Promise<AppReservationRow> {
  const existing = await getAppReservationByAlias(env, vault.slot, alias);
  if (existing) return existing;

  const site = await resolveTarget(env, { vault: vault.name, alias });
  const address = site?.address ?? await allocateAddress(env, vault.slot);
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO app_reservations
       (address, vault_slot, alias, created_at, retired_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ).bind(address, vault.slot, alias, now).run();
  } catch (cause) {
    const raced = await getAppReservationByAlias(env, vault.slot, alias);
    if (raced) return raced;
    throw cause;
  }
  return {
    address,
    vault_slot: vault.slot,
    alias,
    created_at: now,
    retired_at: null,
  };
}

export async function appReservationToInfo(
  env: Env,
  row: AppReservationRow,
  vaultName: string,
): Promise<AppReservationInfo> {
  const address = formatAddress(row.address);
  return {
    address,
    vault: vaultName,
    alias: row.alias,
    url: siteUrl(env, address),
    createdAt: row.created_at,
    deployed: (await getSiteByAddress(env, row.address)) !== null,
  };
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
