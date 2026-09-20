import { z } from "zod";
import { isValidName, parseTarget } from "@nzip/shared";

export const vaultName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).refine(isValidName);
export const address = z.string().regex(/^[0-9a-f]{4}$/);
export const target = z.string().max(65).describe(
  "Existing four-hex site ID (preferred) or explicit vault:alias. No bare aliases or URLs.",
).refine((value) => {
  try {
    return parseTarget(value).kind !== "alias";
  } catch {
    return false;
  }
}, "Use a four-hex site ID or vault:alias");
export const ttl = z.union([z.number().positive().max(3650), z.literal("forever")]);
const timestamp = z.number().int().nonnegative();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const success = { ok: z.literal(true) };
export const site = z.object({
  address,
  vault: vaultName,
  alias: z.string().nullable(),
  manifestHash: hash,
  createdAt: timestamp,
  updatedAt: timestamp,
  expiresAt: timestamp.nullable(),
  url: z.string().url(),
  protected: z.boolean(),
});
export const detail = site.extend({
  history: z.array(z.object({
    seq: z.number().int().positive(),
    manifestHash: hash,
    pushedAt: timestamp,
    note: z.string().nullable(),
  })),
});
export const vault = z.object({
  slot: z.number().int().min(0).max(15),
  name: vaultName,
  description: z.string().nullable(),
  createdAt: timestamp,
  siteCount: z.number().int().nonnegative(),
  defaultTtl: ttl.nullable(),
  effectiveDefaultTtl: ttl,
  defaultFor: z.array(z.enum(["temporary", "permanent"])),
  maxTtl: z.number().positive().nullable().optional(),
  requirePassword: z.boolean().optional(),
  hasDefaultPassword: z.boolean().optional(),
});
export const publishOutput = z.object({
  ...success,
  address,
  url: z.string().url(),
  alias: z.string().nullable(),
  manifestHash: hash,
  expiresAt: timestamp.nullable(),
  ttl: z.union([z.number().nonnegative(), z.literal("forever")]),
  ttlSource: z.enum(["explicit", "existing-site", "vault", "global"]),
  protected: z.boolean(),
  seq: z.number().int().positive(),
  files: z.number().int().nonnegative(),
  newBlobs: z.number().int().nonnegative(),
  dedupedBlobs: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
export const publishInput = z.object({
  mode: z.enum(["create", "update"]).describe(
    "create always allocates a new site; update requires an existing target and keeps its URL.",
  ),
  vault: vaultName.optional().describe(
    "Required for create. Choose autonomously from nzip_status by purpose/description, sensitivity and retention; obey its password requirement and maxTtl.",
  ),
  target: target.optional().describe("Required for update. Use the address returned by publish."),
  html: z.string().min(1).max(1_000_000).optional().describe(
    "Complete inline HTML to publish as index.html. Supply exactly one of html or path.",
  ),
  path: z.string().min(1).optional().describe(
    "Absolute local file/directory under a server --root. Supply exactly one of path or html.",
  ),
  ttl: ttl.optional().describe(
    "Explicit override in days or forever. Omit to inherit vault TTL on create or preserve expiry on update.",
  ),
  password: z.string().min(4).max(256).nullable().optional().describe(
    "Omit to preserve protection; a string sets it; null explicitly removes it. Never put in notifications.",
  ),
}).strict();
