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
  getSiteByAddress,
  getVaultByName,
  getVaultBySlot,
  resolveTarget,
} from "../db.ts";
import { type Env, json, siteUrl } from "../env.ts";
import { ApiError, clientInput, readJson } from "./errors.ts";
import { HEX64, passwordHashFor, ttlToExpiry } from "./common.ts";

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

  const expiresAt = ttlToExpiry(body.ttl);
  const target = body.target as Target;
  let address: number;
  let alias: string | null = null;
  let isNew: boolean;
  if ("address" in target) {
    const existing = await getSiteByAddress(env, target.address);
    const slot = vaultSlotOf(target.address);
    if (!(await getVaultBySlot(env, slot))) {
      throw new ApiError(
        404,
        `vault slot 0x${slot.toString(16)} not registered`,
      );
    }
    address = target.address;
    alias = existing?.alias ?? null;
    isNew = !existing;
  } else {
    const vault = await getVaultByName(env, target.vault);
    if (!vault) throw new ApiError(404, `unknown vault: ${target.vault}`);
    alias = target.alias ?? null;
    if (alias !== null && !isValidName(alias)) {
      throw new ApiError(400, `invalid alias: ${alias}`);
    }
    const existing = alias === null
      ? null
      : await resolveTarget(env, { vault: target.vault, alias });
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
  const addressString = formatAddress(address);
  await purgeSiteCache(ctx, addressString);
  return json<CommitResponse>({
    address: addressString,
    url: siteUrl(env, addressString),
    alias,
    manifestHash: hash,
    expiresAt,
    seq,
  });
}
