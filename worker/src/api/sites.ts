import { formatAddress } from "../../../shared/mod.ts";
import type {
  PatchSiteRequest,
  RevertRequest,
  SourceResponse,
} from "../../../shared/mod.ts";
import { purgeSiteCache } from "../cache.ts";
import {
  commitSite,
  getSiteByAddress,
  getVaultByName,
  listSites,
  siteHistory,
  type SiteRow,
  siteRowToDetail,
  siteRowToInfo,
} from "../db.ts";
import { type Env, json, siteUrl } from "../env.ts";
import {
  HEX64,
  passwordHashFor,
  resolvePathTarget,
  sourceManifest,
  ttlToExpiry,
} from "./common.ts";
import { ApiError, readJson } from "./errors.ts";

export async function handleSiteList(url: URL, env: Env): Promise<Response> {
  const vaultName = url.searchParams.get("vault");
  let slot: number | undefined;
  if (vaultName) {
    const vault = await getVaultByName(env, vaultName);
    if (!vault) throw new ApiError(404, `unknown vault: ${vaultName}`);
    slot = vault.slot;
  }
  const rows = await listSites(env, slot);
  return json(rows.map((row) => siteRowToInfo(env, row, row.vault_name)));
}

export async function handleSite(
  request: Request,
  env: Env,
  parts: string[],
  ctx: ExecutionContext,
): Promise<Response> {
  const site = await resolvePathTarget(env, parts[2]);
  if (!site) throw new ApiError(404, "site not found");

  if (parts.length === 4 && parts[3] === "source" && request.method === "GET") {
    const manifest = await sourceManifest(env, site);
    return json<SourceResponse>({
      address: formatAddress(site.address),
      manifestHash: site.current_manifest,
      manifest,
    });
  }
  if (parts.length === 5 && parts[3] === "source" && request.method === "GET") {
    return await handleSourceBlob(env, site, parts[4]);
  }
  if (parts.length === 3 && request.method === "GET") {
    return json(await siteRowToDetail(env, site));
  }
  if (parts.length === 3 && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM sites WHERE address = ?").bind(
      site.address,
    ).run();
    const address = formatAddress(site.address);
    await purgeSiteCache(ctx, address);
    return json({ ok: true, address });
  }
  if (parts.length === 3 && request.method === "PATCH") {
    return await handlePatch(request, env, site, ctx);
  }
  if (
    parts.length === 4 && parts[3] === "revert" && request.method === "POST"
  ) {
    return await handleRevert(request, env, site, ctx);
  }
  throw new ApiError(404, "not found");
}

async function handleSourceBlob(
  env: Env,
  site: SiteRow,
  hash: string,
): Promise<Response> {
  if (!HEX64.test(hash)) throw new ApiError(400, "invalid blob hash");
  const manifest = await sourceManifest(env, site);
  const entry = Object.values(manifest.files).find((file) => file.h === hash);
  if (!entry) throw new ApiError(404, "source blob not found");
  const blob = await env.CONTENT.get(`blob/${hash}`);
  if (!blob) throw new ApiError(404, "source blob not found");
  return new Response(blob.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(entry.s),
      "cache-control": "no-store",
    },
  });
}

async function handlePatch(
  request: Request,
  env: Env,
  site: SiteRow,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readJson<PatchSiteRequest>(request);
  const expiresAt = body.ttl === undefined ? undefined : ttlToExpiry(body.ttl);
  const passwordHash = await passwordHashFor(body.password);
  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  if (expiresAt !== undefined) {
    updates.push("expires_at = ?");
    values.push(expiresAt);
  }
  if (passwordHash !== undefined) {
    updates.push("password_hash = ?", "auth_version = auth_version + 1");
    values.push(passwordHash);
  }
  if (updates.length > 0) {
    updates.push("updated_at = ?");
    values.push(Math.floor(Date.now() / 1000), site.address);
    await env.DB.prepare(
      `UPDATE sites SET ${updates.join(", ")} WHERE address = ?`,
    )
      .bind(...values).run();
  }
  const updated = await getSiteByAddress(env, site.address);
  if (!updated) throw new ApiError(404, "site not found");
  await purgeSiteCache(ctx, formatAddress(site.address));
  return json(await siteRowToDetail(env, updated));
}

async function handleRevert(
  request: Request,
  env: Env,
  site: SiteRow,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readJson<RevertRequest>(request).catch((error) => {
    if ((request.headers.get("content-length") ?? "0") === "0") {
      return {} as RevertRequest;
    }
    throw error;
  });
  const history = await siteHistory(env, site.address);
  const target = body.toSeq !== undefined
    ? history.find((entry) => entry.seq === body.toSeq)
    : history.find((entry) => entry.manifestHash !== site.current_manifest);
  if (!target) {
    if (body.toSeq !== undefined) {
      throw new ApiError(404, `no push #${body.toSeq} in history`);
    }
    throw new ApiError(409, "nothing to revert to");
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
  const address = formatAddress(site.address);
  await purgeSiteCache(ctx, address);
  return json({
    address,
    url: siteUrl(env, address),
    alias: site.alias,
    manifestHash: target.manifestHash,
    expiresAt: site.expires_at,
    protected: site.password_hash !== null,
    revertedTo: target.seq,
    seq,
  });
}
