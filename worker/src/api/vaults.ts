import { isValidName, VAULT_SLOTS } from "../../../shared/mod.ts";
import type { Ttl, VaultLifecycle } from "../../../shared/mod.ts";
import {
  createVault,
  defaultVaults,
  listVaults,
  setDefaultVault,
  updateVault,
  vaultRowToInfo,
} from "../db.ts";
import { type Env, json } from "../env.ts";
import { ApiError, readJson } from "./errors.ts";

const DESCRIPTION_MAX_LENGTH = 500;

function descriptionValue(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "description must be a string or null");
  }
  const description = value.trim();
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new ApiError(
      400,
      `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  // Descriptions are rendered raw into CLI tables; keep them single-line.
  if (/[\x00-\x1f\x7f-\x9f]/.test(description)) {
    throw new ApiError(400, "description must not contain control characters");
  }
  return description || null;
}

function defaultTtlValue(value: unknown): Ttl | null {
  if (value === null || value === "forever") return value;
  if (
    typeof value !== "number" || !Number.isFinite(value) || value <= 0 ||
    value > 3650
  ) {
    throw new ApiError(
      400,
      'defaultTtl must be null, 1-3650 days, or "forever"',
    );
  }
  return value;
}

function lifecycleValue(value: unknown): VaultLifecycle | null {
  if (value === null || value === "temporary" || value === "permanent") {
    return value;
  }
  throw new ApiError(
    400,
    'defaultFor must be null, "temporary", or "permanent"',
  );
}

export async function handleVaults(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "GET") return json(await listVaults(env));
  const body = await readJson<{
    name: string;
    slot?: number;
    description?: unknown;
    defaultTtl?: unknown;
    defaultFor?: unknown;
  }>(request);
  if (!isValidName(body.name)) throw new ApiError(400, "invalid vault name");
  if (body.slot !== undefined && (body.slot < 0 || body.slot >= VAULT_SLOTS)) {
    throw new ApiError(400, "slot must be 0-15");
  }
  const description = body.description === undefined
    ? null
    : descriptionValue(body.description);
  const defaultTtl = body.defaultTtl === undefined
    ? null
    : defaultTtlValue(body.defaultTtl);
  const defaultFor = body.defaultFor === undefined
    ? null
    : lifecycleValue(body.defaultFor);
  try {
    const vault = await createVault(
      env,
      body.name,
      body.slot,
      description,
      defaultTtl,
      defaultFor,
    );
    return json(
      vaultRowToInfo(vault, 0, defaultFor === null ? [] : [defaultFor]),
      201,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "vault conflict";
    throw new ApiError(409, message, { cause });
  }
}

export async function handleVault(
  request: Request,
  env: Env,
  encodedName: string,
): Promise<Response> {
  if (request.method !== "PATCH") throw new ApiError(405, "method not allowed");
  let currentName: string;
  try {
    currentName = decodeURIComponent(encodedName);
  } catch {
    throw new ApiError(400, "invalid vault name");
  }
  const body = await readJson<{
    name?: unknown;
    description?: unknown;
    defaultTtl?: unknown;
    defaultFor?: unknown;
  }>(request);
  if (
    body.name === undefined && body.description === undefined &&
    body.defaultTtl === undefined && body.defaultFor === undefined
  ) {
    throw new ApiError(
      400,
      "provide name, description, defaultTtl, and/or defaultFor",
    );
  }
  if (
    body.name !== undefined &&
    (typeof body.name !== "string" || !isValidName(body.name))
  ) {
    throw new ApiError(400, "invalid vault name");
  }
  const patch = {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(body.description !== undefined
      ? { description: descriptionValue(body.description) }
      : {}),
    ...(body.defaultTtl !== undefined
      ? { defaultTtl: defaultTtlValue(body.defaultTtl) }
      : {}),
    ...(body.defaultFor !== undefined
      ? { defaultFor: lifecycleValue(body.defaultFor) }
      : {}),
  };
  try {
    const vault = await updateVault(env, currentName, patch);
    if (!vault) throw new ApiError(404, `unknown vault: ${currentName}`);
    return json(vault);
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    const message = cause instanceof Error ? cause.message : "vault conflict";
    throw new ApiError(409, message, { cause });
  }
}

export async function handleDefaultVault(
  request: Request,
  env: Env,
  lifecycleSegment: string,
): Promise<Response> {
  const lifecycle = lifecycleValue(lifecycleSegment);
  if (lifecycle === null) throw new ApiError(400, "lifecycle is required");
  const body = await readJson<{ name?: unknown }>(request);
  if (typeof body.name !== "string" || !isValidName(body.name)) {
    throw new ApiError(400, "valid vault name required");
  }
  const vault = await setDefaultVault(env, lifecycle, body.name);
  if (!vault) throw new ApiError(404, `unknown vault: ${body.name}`);
  return json({ defaultVaults: await defaultVaults(env), vault });
}
