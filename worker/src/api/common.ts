import { parseManifest, parseTarget } from "../../../shared/mod.ts";
import type { Manifest } from "../../../shared/mod.ts";
import { resolveTarget, type SiteRow } from "../db.ts";
import type { Env } from "../env.ts";
import { hashPassword } from "../password.ts";
import { ApiError, clientInput } from "./errors.ts";

export const HEX64 = /^[0-9a-f]{64}$/;

export function ttlToExpiry(
  ttl: number | "forever" | undefined,
): number | null {
  if (ttl === "forever") return null;
  const days = ttl ?? 14;
  if (!Number.isFinite(days) || days <= 0 || days > 3650) {
    throw new ApiError(400, 'ttl must be 1-3650 days or "forever"');
  }
  return Math.floor(Date.now() / 1000) + Math.round(days * 86400);
}

export async function passwordHashFor(
  password: unknown,
): Promise<string | null | undefined> {
  if (password === undefined || password === null) return password;
  if (
    typeof password !== "string" || password.length < 4 || password.length > 256
  ) {
    throw new ApiError(400, "password must be 4-256 characters");
  }
  return await hashPassword(password);
}

export async function resolvePathTarget(
  env: Env,
  segment: string,
): Promise<SiteRow | null> {
  const parsed = await clientInput(() =>
    parseTarget(decodeURIComponent(segment))
  );
  if (parsed.kind === "address") {
    return await resolveTarget(env, { address: parsed.address });
  }
  if (parsed.kind === "vaultAlias") {
    return await resolveTarget(env, {
      vault: parsed.vault,
      alias: parsed.alias,
    });
  }
  return null;
}

export async function sourceManifest(
  env: Env,
  site: SiteRow,
): Promise<Manifest> {
  if (
    site.expires_at !== null && site.expires_at < Math.floor(Date.now() / 1000)
  ) {
    throw new ApiError(410, "site expired");
  }
  const object = await env.CONTENT.get(`manifest/${site.current_manifest}`);
  if (!object) throw new ApiError(404, "source manifest not found");
  return parseManifest(new Uint8Array(await object.arrayBuffer()));
}
