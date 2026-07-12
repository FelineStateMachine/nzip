import { isValidName, VAULT_SLOTS } from "../../../shared/mod.ts";
import { createVault, listVaults, updateVault } from "../db.ts";
import { type Env, json } from "../env.ts";
import { ApiError, readJson } from "./errors.ts";

const DESCRIPTION_MAX_LENGTH = 500;

function descriptionValue(value: unknown): string | null {
  if (typeof value !== "string") {
    throw new ApiError(400, "description must be a string");
  }
  const description = value.trim();
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new ApiError(400, `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`);
  }
  return description || null;
}

export async function handleVaults(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "GET") return json(await listVaults(env));
  const body = await readJson<{ name: string; slot?: number; description?: unknown }>(request);
  if (!isValidName(body.name)) throw new ApiError(400, "invalid vault name");
  if (body.slot !== undefined && (body.slot < 0 || body.slot >= VAULT_SLOTS)) {
    throw new ApiError(400, "slot must be 0-15");
  }
  const description = body.description === undefined ? null : descriptionValue(body.description);
  try {
    const vault = await createVault(env, body.name, body.slot, description);
    return json({
      slot: vault.slot,
      name: vault.name,
      description: vault.description,
      createdAt: vault.created_at,
      siteCount: 0,
    }, 201);
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
  const currentName = decodeURIComponent(encodedName);
  const body = await readJson<{ name?: unknown; description?: unknown }>(request);
  if (body.name === undefined && body.description === undefined) {
    throw new ApiError(400, "provide name and/or description");
  }
  if (body.name !== undefined && (typeof body.name !== "string" || !isValidName(body.name))) {
    throw new ApiError(400, "invalid vault name");
  }
  const patch = {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: descriptionValue(body.description) } : {}),
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
