import { isValidName, VAULT_SLOTS } from "../../../shared/mod.ts";
import { createVault, listVaults } from "../db.ts";
import { type Env, json } from "../env.ts";
import { ApiError, readJson } from "./errors.ts";

export async function handleVaults(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "GET") return json(await listVaults(env));
  const body = await readJson<{ name: string; slot?: number }>(request);
  if (!isValidName(body.name)) throw new ApiError(400, "invalid vault name");
  if (body.slot !== undefined && (body.slot < 0 || body.slot >= VAULT_SLOTS)) {
    throw new ApiError(400, "slot must be 0-15");
  }
  try {
    const vault = await createVault(env, body.name, body.slot);
    return json({
      slot: vault.slot,
      name: vault.name,
      createdAt: vault.created_at,
    }, 201);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "vault conflict";
    throw new ApiError(409, message, { cause });
  }
}
