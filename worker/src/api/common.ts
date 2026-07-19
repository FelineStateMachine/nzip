import { GLOBAL_DEFAULT_TTL, parseManifest, parseTarget } from "../../../shared/mod.ts";
import type { Manifest, Ttl, TtlSource } from "../../../shared/mod.ts";
import { resolveTarget, type SiteRow } from "../db.ts";
import type { Env } from "../env.ts";
import { hashPassword } from "../password.ts";
import { ApiError, clientInput } from "./errors.ts";

export const HEX64 = /^[0-9a-f]{64}$/;
export function ttlToExpiry(
  ttl: Ttl,
  now = Math.floor(Date.now() / 1000),
): number | null {
  if (ttl === "forever") return null;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 3650) {
    throw new ApiError(400, 'ttl must be 1-3650 days or "forever"');
  }
  return now + Math.round(ttl * 86400);
}

export function storedDefaultTtl(value: number | null): Ttl | null {
  return value === null ? null : value === 0 ? "forever" : value;
}

export interface ResolvedTtl {
  expiresAt: number | null;
  ttl: Ttl;
  ttlSource: TtlSource;
}

/** Apply explicit → existing-site → vault → global retention precedence. */
export function resolveCommitTtl(
  explicit: Ttl | undefined,
  existingExpiresAt: number | null | undefined,
  vaultDefault: number | null,
  now = Math.floor(Date.now() / 1000),
): ResolvedTtl {
  if (explicit !== undefined) {
    return {
      expiresAt: ttlToExpiry(explicit, now),
      ttl: explicit,
      ttlSource: "explicit",
    };
  }
  if (existingExpiresAt !== undefined) {
    return {
      expiresAt: existingExpiresAt,
      ttl: existingExpiresAt === null
        ? "forever"
        : Math.max(0, Math.ceil((existingExpiresAt - now) / 86400)),
      ttlSource: "existing-site",
    };
  }
  const inherited = storedDefaultTtl(vaultDefault);
  if (inherited !== null) {
    return {
      expiresAt: ttlToExpiry(inherited, now),
      ttl: inherited,
      ttlSource: "vault",
    };
  }
  return {
    expiresAt: ttlToExpiry(GLOBAL_DEFAULT_TTL, now),
    ttl: GLOBAL_DEFAULT_TTL,
    ttlSource: "global",
  };
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
  const parsed = await clientInput(() => parseTarget(decodeURIComponent(segment)));
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
