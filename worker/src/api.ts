import {
  canonicalManifestBytes,
  formatAddress,
  isValidName,
  manifestHash,
  parseManifest,
  parseTarget,
  sha256hex,
  VAULT_SLOTS,
  vaultSlotOf,
} from "../../shared/mod.ts";
import type {
  CommitRequest,
  CommitResponse,
  Manifest,
  PatchSiteRequest,
  PrepareRequest,
  PrepareResponse,
  RevertRequest,
  SourceResponse,
  StatusResponse,
  Target,
} from "../../shared/mod.ts";
import {
  allocateAddress,
  commitSite,
  createVault,
  getSiteByAddress,
  getVaultByName,
  getVaultBySlot,
  listSites,
  listVaults,
  resolveTarget,
  siteHistory,
  siteRowToDetail,
  siteRowToInfo,
  type SiteRow,
} from "./db.ts";
import { type Env, err, json, siteUrl } from "./env.ts";
import { purgeSiteCache } from "./cache.ts";
import { hashPassword } from "./password.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const DEFAULT_TTL_DAYS = 14;
const MAX_BLOB_BYTES = 50 * 1024 * 1024;
const HEAD_CHUNK = 40; // stay under Worker subrequest limits on big bundles

function ttlToExpiry(ttl: number | "forever" | undefined): number | null {
  if (ttl === "forever") return null;
  const days = ttl ?? DEFAULT_TTL_DAYS;
  if (!Number.isFinite(days) || days <= 0 || days > 3650) {
    throw new Error("ttl must be 1-3650 days or \"forever\"");
  }
  return Math.floor(Date.now() / 1000) + Math.round(days * 86400);
}

async function passwordHashFor(password: unknown): Promise<string | null | undefined> {
  if (password === undefined || password === null) return password;
  if (typeof password !== "string" || password.length < 4) {
    throw new Error("password must be at least 4 characters");
  }
  return await hashPassword(password);
}

/** Which blob hashes referenced by the manifest are absent from R2? */
async function missingBlobs(env: Env, manifest: Manifest): Promise<string[]> {
  const hashes = [...new Set(Object.values(manifest.files).map((f) => f.h))];
  const missing: string[] = [];
  for (let i = 0; i < hashes.length; i += HEAD_CHUNK) {
    const chunk = hashes.slice(i, i + HEAD_CHUNK);
    const heads = await Promise.all(chunk.map((h) => env.CONTENT.head(`blob/${h}`)));
    heads.forEach((head, j) => {
      if (!head) missing.push(chunk[j]);
    });
  }
  return missing;
}

async function handlePrepare(req: Request, env: Env): Promise<Response> {
  const body = await req.json<PrepareRequest>();
  const hash = await manifestHash(body.manifest); // validates too
  return json<PrepareResponse>({ manifestHash: hash, missing: await missingBlobs(env, body.manifest) });
}

async function handleBlobPut(req: Request, env: Env, hash: string): Promise<Response> {
  if (!HEX64.test(hash)) return err("invalid blob hash", 400);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_BLOB_BYTES) return err("blob too large", 413);
  const actual = await sha256hex(bytes);
  if (actual !== hash) return err(`hash mismatch: body is ${actual}`, 400);
  await env.CONTENT.put(`blob/${hash}`, bytes);
  return json({ ok: true, hash });
}

async function handleCommit(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await req.json<CommitRequest>();
  const passwordHash = await passwordHashFor(body.password);
  const bytes = canonicalManifestBytes(body.manifest);
  const hash = await sha256hex(bytes);

  // Guard against crashed uploads: every referenced blob must exist before commit.
  const missing = await missingBlobs(env, body.manifest);
  if (missing.length > 0) {
    return err(`cannot commit: ${missing.length} blobs missing (run prepare again)`, 409);
  }

  let expiresAt: number | null;
  try {
    expiresAt = ttlToExpiry(body.ttl);
  } catch (e) {
    return err((e as Error).message, 400);
  }

  // Resolve target → (address, vaultSlot, alias, isNew)
  const t = body.target as Target;
  let address: number;
  let alias: string | null = null;
  let isNew: boolean;
  if ("address" in t) {
    const existing = await getSiteByAddress(env, t.address);
    const slot = vaultSlotOf(t.address);
    if (!(await getVaultBySlot(env, slot))) return err(`vault slot 0x${slot.toString(16)} not registered`, 404);
    address = t.address;
    alias = existing?.alias ?? null;
    isNew = !existing;
  } else {
    const vault = await getVaultByName(env, t.vault);
    if (!vault) return err(`unknown vault: ${t.vault}`, 404);
    alias = t.alias ?? null;
    if (alias !== null && !isValidName(alias)) return err(`invalid alias: ${alias}`, 400);
    const existing = alias === null ? null : await resolveTarget(env, { vault: t.vault, alias });
    if (existing) {
      address = existing.address;
      isNew = false;
    } else {
      address = await allocateAddress(env, vault.slot);
      isNew = true;
    }
  }

  if (!(await env.CONTENT.head(`manifest/${hash}`))) {
    await env.CONTENT.put(`manifest/${hash}`, bytes);
  }
  const seq = await commitSite(env, {
    address,
    vaultSlot: vaultSlotOf(address),
    alias,
    manifestHash: hash,
    expiresAt,
    passwordHash,
    isNew,
  });

  const addressStr = formatAddress(address);
  await purgeSiteCache(ctx, addressStr);
  return json<CommitResponse>({
    address: addressStr,
    url: siteUrl(env, addressStr),
    alias,
    manifestHash: hash,
    expiresAt,
    seq,
  });
}

/** Resolve a URL path target segment ("2a3f" | "work:demo") to a site row. */
async function resolvePathTarget(env: Env, segment: string): Promise<SiteRow | null> {
  const parsed = parseTarget(decodeURIComponent(segment));
  if (parsed.kind === "address") return await resolveTarget(env, { address: parsed.address });
  if (parsed.kind === "vaultAlias") {
    return await resolveTarget(env, { vault: parsed.vault, alias: parsed.alias });
  }
  return null; // bare alias needs a default vault — the CLI resolves that client-side
}

async function handleStatus(env: Env): Promise<Response> {
  const vaults = await listVaults(env);
  const sites = await listSites(env);
  const soon = Math.floor(Date.now() / 1000) + 48 * 3600;
  return json<StatusResponse>({
    ok: true,
    version: "0.2.0",
    vaults,
    siteCount: sites.length,
    expiringSoon: sites.filter((s) => s.expires_at !== null && s.expires_at < soon).length,
  });
}

/** Load the current source manifest, refusing content that is no longer hosted. */
async function sourceManifest(env: Env, site: SiteRow): Promise<Manifest | Response> {
  const now = Math.floor(Date.now() / 1000);
  if (site.expires_at !== null && site.expires_at < now) return err("site expired", 410);
  const object = await env.CONTENT.get(`manifest/${site.current_manifest}`);
  if (!object) return err("source manifest not found", 404);
  return parseManifest(new Uint8Array(await object.arrayBuffer()));
}

export async function api(
  req: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const method = req.method;

  try {
    // push protocol
    if (parts[1] === "push" && parts[2] === "prepare" && method === "POST") {
      return await handlePrepare(req, env);
    }
    if (parts[1] === "push" && parts[2] === "commit" && method === "POST") {
      return await handleCommit(req, env, ctx);
    }
    if (parts[1] === "blob" && parts.length === 3 && method === "PUT") {
      return await handleBlobPut(req, env, parts[2]);
    }

    // status
    if (parts[1] === "status" && method === "GET") return await handleStatus(env);

    // vaults
    if (parts[1] === "vaults" && parts.length === 2) {
      if (method === "GET") return json(await listVaults(env));
      if (method === "POST") {
        const body = await req.json<{ name: string; slot?: number }>();
        if (!isValidName(body.name)) return err("invalid vault name", 400);
        if (body.slot !== undefined && (body.slot < 0 || body.slot >= VAULT_SLOTS)) {
          return err("slot must be 0-15", 400);
        }
        try {
          const v = await createVault(env, body.name, body.slot);
          return json({ slot: v.slot, name: v.name, createdAt: v.created_at }, 201);
        } catch (e) {
          return err((e as Error).message, 409);
        }
      }
    }

    // sites collection
    if (parts[1] === "sites" && parts.length === 2 && method === "GET") {
      const vaultName = url.searchParams.get("vault");
      let slot: number | undefined;
      if (vaultName) {
        const vault = await getVaultByName(env, vaultName);
        if (!vault) return err(`unknown vault: ${vaultName}`, 404);
        slot = vault.slot;
      }
      const rows = await listSites(env, slot);
      return json(rows.map((r) => siteRowToInfo(env, r, r.vault_name)));
    }

    // sites/{target}[/source[/blob-hash]|revert]
    if (parts[1] === "sites" && parts.length >= 3) {
      const site = await resolvePathTarget(env, parts[2]);
      if (!site) return err("site not found", 404);

      if (parts.length === 4 && parts[3] === "source" && method === "GET") {
        const manifest = await sourceManifest(env, site);
        if (manifest instanceof Response) return manifest;
        return json<SourceResponse>({
          address: formatAddress(site.address),
          manifestHash: site.current_manifest,
          manifest,
        });
      }
      if (parts.length === 5 && parts[3] === "source" && method === "GET") {
        const hash = parts[4];
        if (!HEX64.test(hash)) return err("invalid blob hash", 400);
        const manifest = await sourceManifest(env, site);
        if (manifest instanceof Response) return manifest;
        const entry = Object.values(manifest.files).find((file) => file.h === hash);
        if (!entry) return err("source blob not found", 404);
        const blob = await env.CONTENT.get(`blob/${hash}`);
        if (!blob) return err("source blob not found", 404);
        return new Response(blob.body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(entry.s),
            "cache-control": "no-store",
          },
        });
      }

      if (parts.length === 3 && method === "GET") {
        return json(await siteRowToDetail(env, site));
      }
      if (parts.length === 3 && method === "DELETE") {
        await env.DB.prepare("DELETE FROM sites WHERE address = ?").bind(site.address).run();
        const address = formatAddress(site.address);
        await purgeSiteCache(ctx, address);
        return json({ ok: true, address });
      }
      if (parts.length === 3 && method === "PATCH") {
        const body = await req.json<PatchSiteRequest>();
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = body.ttl === undefined ? undefined : ttlToExpiry(body.ttl);
        const passwordHash = await passwordHashFor(body.password);
        const updates: string[] = [];
        const values: (string | number | null)[] = [];
        if (expiresAt !== undefined) {
          updates.push("expires_at = ?");
          values.push(expiresAt);
        }
        if (passwordHash !== undefined) {
          updates.push("password_hash = ?");
          values.push(passwordHash);
          updates.push("auth_version = auth_version + 1");
        }
        if (updates.length > 0) {
          updates.push("updated_at = ?");
          values.push(now, site.address);
          await env.DB.prepare(`UPDATE sites SET ${updates.join(", ")} WHERE address = ?`)
            .bind(...values).run();
        }
        const updated = await getSiteByAddress(env, site.address);
        await purgeSiteCache(ctx, formatAddress(site.address));
        return json(await siteRowToDetail(env, updated!));
      }
      if (parts.length === 4 && parts[3] === "revert" && method === "POST") {
        return await handleRevert(req, env, site, ctx);
      }
    }

    return err("not found", 404);
  } catch (e) {
    const msg = (e as Error).message ?? "internal error";
    // Validation errors from shared/ read as client mistakes.
    const status = /invalid|unsupported|too many|no files|must be/.test(msg) ? 400 : 500;
    return err(msg, status);
  }
}

async function handleRevert(
  req: Request,
  env: Env,
  site: SiteRow,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await req.json<RevertRequest>().catch(() => ({} as RevertRequest));
  const history = await siteHistory(env, site.address); // newest first

  let target;
  if (body.toSeq !== undefined) {
    target = history.find((h) => h.seq === body.toSeq);
    if (!target) return err(`no push #${body.toSeq} in history`, 404);
  } else {
    // Default: most recent push whose manifest differs from what's live now.
    target = history.find((h) => h.manifestHash !== site.current_manifest);
    if (!target) return err("nothing to revert to", 409);
  }

  const seq = await commitSite(env, {
    address: site.address,
    vaultSlot: site.vault_slot,
    alias: site.alias,
    manifestHash: target.manifestHash,
    expiresAt: site.expires_at,
    isNew: false,
    note: `revert to #${target.seq}`,
  });

  const addressStr = formatAddress(site.address);
  await purgeSiteCache(ctx, addressStr);
  return json({
    address: addressStr,
    url: siteUrl(env, addressStr),
    alias: site.alias,
    manifestHash: target.manifestHash,
    revertedTo: target.seq,
    seq,
  });
}
