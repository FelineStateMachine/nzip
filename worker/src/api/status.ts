import { VERSION } from "../../../shared/mod.ts";
import type { StatusResponse } from "../../../shared/mod.ts";
import { listSites, listVaults } from "../db.ts";
import { type Env, json } from "../env.ts";

export async function handleStatus(env: Env): Promise<Response> {
  const vaults = await listVaults(env);
  const sites = await listSites(env);
  const soon = Math.floor(Date.now() / 1000) + 48 * 3600;
  return json<StatusResponse>({
    ok: true,
    version: VERSION,
    vaults,
    siteCount: sites.length,
    expiringSoon: sites.filter((site) =>
      site.expires_at !== null && site.expires_at < soon
    ).length,
  });
}
