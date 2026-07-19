import {
  canonicalManifestBytes,
  formatAddress,
  isValidName,
  manifestHash,
  MAX_BLOB_BYTES,
  sha256hex,
  vaultSlotOf,
} from "../../../shared/mod.ts";
import type {
  CommitRequest,
  CommitResponse,
  Manifest,
  PrepareRequest,
  PrepareResponse,
  Target,
} from "../../../shared/mod.ts";
import { purgeSiteCache } from "../cache.ts";
import {
  allocateAddress,
  commitSite,
  getAppReservationByAddress,
  getAppReservationByAlias,
  getSiteByAddress,
  getVaultByName,
  getVaultBySlot,
  resolveTarget,
} from "../db.ts";
import { type Env, json, siteUrl } from "../env.ts";
import { ApiError, clientInput, readJson } from "./errors.ts";
import { HEX64, passwordHashFor, resolveCommitTtl } from "./common.ts";

const HEAD_BATCH_SIZE = 6;

async function missingBlobs(env: Env, manifest: Manifest): Promise<string[]> {
  const hashes = [
    ...new Set(Object.values(manifest.files).map((file) => file.h)),
  ];
  const missing: string[] = [];
  for (let i = 0; i < hashes.length; i += HEAD_BATCH_SIZE) {
    const batch = hashes.slice(i, i + HEAD_BATCH_SIZE);
    const heads = await Promise.all(
      batch.map((hash) => env.CONTENT.head(`blob/${hash}`)),
    );
    heads.forEach((head, index) => {
      if (!head) missing.push(batch[index]);
    });
  }
  return missing;
}

export async function handlePrepare(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJson<PrepareRequest>(request);
  const hash = await clientInput(() => manifestHash(body.manifest));
  return json<PrepareResponse>({
    manifestHash: hash,
    missing: await missingBlobs(env, body.manifest),
  });
}

export async function handleBlobPut(
  request: Request,
  env: Env,
  hash: string,
): Promise<Response> {
  if (!HEX64.test(hash)) throw new ApiError(400, "invalid blob hash");
  const contentLength = request.headers.get("content-length");
  if (contentLength === null) {
    throw new ApiError(411, "content-length required");
  }
  const declaredBytes = Number(contentLength);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
    throw new ApiError(400, "invalid content-length");
  }
  if (declaredBytes > MAX_BLOB_BYTES) throw new ApiError(413, "blob too large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BLOB_BYTES) throw new ApiError(413, "blob too large");
  if (bytes.length !== declaredBytes) {
    throw new ApiError(400, "content-length mismatch");
  }
  const actual = await sha256hex(bytes);
  if (actual !== hash) {
    throw new ApiError(400, `hash mismatch: body is ${actual}`);
  }
  await env.CONTENT.put(`blob/${hash}`, bytes);
  return json({ ok: true, hash });
}

export async function handleCommit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readJson<CommitRequest>(request);
  const passwordHash = await passwordHashFor(body.password);
  const bytes = await clientInput(() => canonicalManifestBytes(body.manifest));
  const hash = await sha256hex(bytes);
  const missing = await missingBlobs(env, body.manifest);
  if (missing.length > 0) {
    throw new ApiError(
      409,
      `cannot commit: ${missing.length} blobs missing (run prepare again)`,
    );
  }

  const target = body.target as Target;
  let address: number;
  let alias: string | null = null;
  let isNew: boolean;
  let existingSite: Awaited<ReturnType<typeof getSiteByAddress>> = null;
  let reservation: Awaited<ReturnType<typeof getAppReservationByAddress>> = null;
  let vault: Awaited<ReturnType<typeof getVaultBySlot>>;
  if ("address" in target) {
    existingSite = await getSiteByAddress(env, target.address);
    const slot = vaultSlotOf(target.address);
    vault = await getVaultBySlot(env, slot);
    if (!vault) {
      throw new ApiError(
        404,
        `vault slot 0x${slot.toString(16)} not registered`,
      );
    }
    reservation = await getAppReservationByAddress(env, target.address);
    address = target.address;
    alias = existingSite?.alias ?? reservation?.alias ?? null;
    isNew = !existingSite;
  } else {
    vault = await getVaultByName(env, target.vault);
    if (!vault) throw new ApiError(404, `unknown vault: ${target.vault}`);
    alias = target.alias ?? null;
    if (alias !== null && !isValidName(alias)) {
      throw new ApiError(400, `invalid alias: ${alias}`);
    }
    existingSite = alias === null ? null : await resolveTarget(env, { vault: target.vault, alias });
    if (existingSite) {
      address = existingSite.address;
      isNew = false;
    } else {
      reservation = alias === null ? null : await getAppReservationByAlias(env, vault.slot, alias);
      address = reservation?.address ?? await allocateAddress(env, vault.slot);
      isNew = true;
    }
    reservation ??= await getAppReservationByAddress(env, address);
  }

  if (body.app !== undefined && reservation === null) {
    throw new ApiError(409, "app deployments require an initialized app reservation");
  }
  if (reservation !== null && body.app === undefined) {
    throw new ApiError(409, "reserved app origins must be deployed with nzip app deploy");
  }
  const contentSecurityPolicy = body.app === undefined
    ? undefined
    : body.app.contentSecurityPolicy ?? null;
  if (
    typeof contentSecurityPolicy === "string" &&
    (contentSecurityPolicy.length > 8192 || /[\r\n\0]/.test(contentSecurityPolicy))
  ) {
    throw new ApiError(400, "content security policy must be one line and at most 8192 characters");
  }

  const resolvedTtl = resolveCommitTtl(
    body.ttl,
    existingSite?.expires_at,
    vault.default_ttl,
  );
  const protectedSite = passwordHash === undefined && existingSite
    ? existingSite.password_hash !== null
    : passwordHash !== null && passwordHash !== undefined;

  if (!(await env.CONTENT.head(`manifest/${hash}`))) {
    await env.CONTENT.put(`manifest/${hash}`, bytes);
  }
  const seq = await commitSite(env, {
    address,
    vaultSlot: vaultSlotOf(address),
    alias,
    manifestHash: hash,
    expiresAt: resolvedTtl.expiresAt,
    passwordHash,
    contentSecurityPolicy,
    isNew,
  });
  const addressString = formatAddress(address);
  await purgeSiteCache(ctx, addressString);
  return json<CommitResponse>({
    address: addressString,
    url: siteUrl(env, addressString),
    alias,
    manifestHash: hash,
    expiresAt: resolvedTtl.expiresAt,
    ttl: resolvedTtl.ttl,
    ttlSource: resolvedTtl.ttlSource,
    protected: protectedSite,
    seq,
  });
}
