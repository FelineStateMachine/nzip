import { isValidName } from "../../../shared/mod.ts";
import type { AppInitRequest, AppReservationInfo } from "../../../shared/mod.ts";
import {
  appReservationToInfo,
  getAppReservationByAlias,
  getVaultByName,
  reserveAppOrigin,
} from "../db.ts";
import { type Env, json } from "../env.ts";
import { ApiError, readJson } from "./errors.ts";

/** Reserve an app hostname permanently before its first build exists. */
export async function handleAppInit(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJson<AppInitRequest>(request);
  const target = body.target;
  if (!target || !isValidName(target.vault) || !isValidName(target.alias)) {
    throw new ApiError(400, "app target must be vault:alias using valid names");
  }
  const vault = await getVaultByName(env, target.vault);
  if (!vault) throw new ApiError(404, `unknown vault: ${target.vault}`);

  const existed = await getAppReservationByAlias(env, vault.slot, target.alias);
  const reservation = existed ?? await reserveAppOrigin(env, vault, target.alias);
  const info = await appReservationToInfo(env, reservation, vault.name);
  return json<AppReservationInfo>(info, existed ? 200 : 201);
}
