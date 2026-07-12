// Wire types shared by the CLI and the Worker.
// This package must stay runtime-agnostic: Web APIs only, no Deno.* or Workers globals.

/** A single file entry in a manifest. Keys are kept short because they're hashed verbatim. */
export interface ManifestFile {
  /** sha256 hex of the file bytes */
  h: string;
  /** size in bytes */
  s: number;
  /** content-type, resolved at push time by the CLI */
  ct: string;
}

/** A push's complete file set — the content-addressed description of a site version. */
export interface Manifest {
  /** manifest format version */
  v: 1;
  /** path (relative, forward slashes, no leading ./) → file entry */
  files: Record<string, ManifestFile>;
}

/** A push destination: a raw address, or a vault (optionally with an alias). */
export type Target =
  | {
    /** Numeric site address in the inclusive range `0x0000`–`0xffff`. */
    address: number;
  }
  | {
    /** Registered vault name that owns the destination address. */
    vault: string;
    /** Optional site alias within the vault; `null` requests an unaliased site. */
    alias?: string | null;
  };

/** Body of `POST /api/push/prepare`: the manifest the client wants to push. */
export interface PrepareRequest {
  /** Complete manifest whose referenced blob availability should be checked. */
  manifest: Manifest;
}

/** Reply to `prepare`: the manifest's hash and which blobs the server still needs. */
export interface PrepareResponse {
  /** Lowercase SHA-256 of the canonical manifest bytes. */
  manifestHash: string;
  /** blob hashes the server does not have yet */
  missing: string[];
}

/** Body of `POST /api/push/commit`: atomically publish content and its access policy. */
export interface CommitRequest {
  /** Complete manifest to publish as the site's current version. */
  manifest: Manifest;
  /** Address or vault destination that should receive the new version. */
  target: Target;
  /** days until expiry; "forever" = no expiry; omitted = server default (14) */
  ttl?: number | "forever";
  /** set a password (string), clear it (null), or preserve it on an existing site (undefined) */
  password?: string | null;
}

/** Reply to `commit`: the allocated address and the live URL for the new push. */
export interface CommitResponse {
  /** 4-hex address, e.g. "2a3f" */
  address: string;
  /** Absolute public URL of the committed site. */
  url: string;
  /** Resolved site alias, or `null` for an unaliased address. */
  alias: string | null;
  /** Lowercase SHA-256 of the committed canonical manifest. */
  manifestHash: string;
  /** unix seconds, null = permanent */
  expiresAt: number | null;
  /** push sequence number for this site */
  seq: number;
}

/** Summary of a single site, as returned by list/status endpoints. */
export interface SiteInfo {
  /** Four-character lowercase hexadecimal site address. */
  address: string;
  /** Name of the vault containing the site. */
  vault: string;
  /** Site alias within its vault, or `null` when unaliased. */
  alias: string | null;
  /** Lowercase SHA-256 of the site's current canonical manifest. */
  manifestHash: string;
  /** Unix timestamp, in seconds, when the site was created. */
  createdAt: number;
  /** Unix timestamp, in seconds, of the most recent site update. */
  updatedAt: number;
  /** Unix expiry timestamp in seconds, or `null` for a permanent site. */
  expiresAt: number | null;
  /** Absolute public URL of the site. */
  url: string;
  /** Whether visitors must unlock the site with a password. */
  protected: boolean;
}

/** One entry in a site's push history. */
export interface PushInfo {
  /** Monotonically increasing push sequence number within the site. */
  seq: number;
  /** Lowercase SHA-256 of the manifest published by this push. */
  manifestHash: string;
  /** Unix timestamp, in seconds, when the push was committed. */
  pushedAt: number;
  /** Optional audit note, such as the source sequence of a revert. */
  note: string | null;
}

/** A site plus its retained push history (powers `nzip revert`). */
export interface SiteDetail extends SiteInfo {
  /** Retained push history ordered from newest to oldest. */
  history: PushInfo[];
}

/** Current uploaded bundle for a site, returned only by the authenticated recovery API. */
export interface SourceResponse {
  /** Four-character lowercase hexadecimal address of the recovered site. */
  address: string;
  /** Lowercase SHA-256 of the returned canonical manifest. */
  manifestHash: string;
  /** Current manifest used to reconstruct and verify the hosted bundle. */
  manifest: Manifest;
}

/** A registered vault: its slot, name, and current site count. */
export interface VaultInfo {
  /** Numeric vault slot in the inclusive range `0x0`–`0xf`. */
  slot: number;
  /** Registered lowercase vault name. */
  name: string;
  /** Optional context describing the vault's intended audience or purpose. */
  description: string | null;
  /** Unix timestamp, in seconds, when the vault was registered. */
  createdAt: number;
  /** Number of currently live sites assigned to this vault. */
  siteCount: number;
}

/** Reply to `GET /api/status`: server version and a snapshot of vaults and sites. */
export interface StatusResponse {
  /** Literal success marker for a healthy authenticated status response. */
  ok: true;
  /** Semantic version reported by the running nzip Worker. */
  version: string;
  /** All registered vaults and their current site counts. */
  vaults: VaultInfo[];
  /** Total number of currently registered sites across every vault. */
  siteCount: number;
  /** sites expiring within 48h */
  expiringSoon: number;
}

/** Body of a revert request: the push sequence number to repoint to (defaults to previous). */
export interface RevertRequest {
  /** Push sequence to restore; omission selects the newest differing version. */
  toSeq?: number;
}

/** Body of a site PATCH: change TTL and/or password. Omitted fields are left unchanged. */
export interface PatchSiteRequest {
  /** New lifetime in days, or `"forever"`; omission preserves the current expiry. */
  ttl?: number | "forever";
  /** set a password (string), clear it (null), or leave unchanged (undefined) */
  password?: string | null;
}

/** Standard error envelope returned by the API on failure. */
export interface ApiError {
  /** Human-readable error message safe to show to the authenticated client. */
  error: string;
}

/** Body of `POST /api/notify`: a small, user-visible Web Push event. */
export interface NotifyRequest {
  /** Notification title. The Worker defaults this to `nzip` when omitted. */
  title?: string;
  /** Required notification body. */
  body: string;
  /** Optional normalized, same-origin path opened when the notification is tapped. */
  path?: string;
  /** Optional provider-independent replacement/deduplication tag. */
  tag?: string;
}

/** Reply from `POST /api/notify`; acceptance does not imply delivery. */
export interface NotifyResponse {
  /** Stable identifier for the persisted notification event. */
  eventId: string;
  /** Number of active device deliveries placed in the outbox. */
  queuedDevices: number;
  /** Number of approved but inactive devices excluded from delivery. */
  inactiveDevices: number;
}

/** Server-side lifecycle state for an owner-approved notification device. */
export type NotifyDeviceStatus =
  | "pending"
  | "approved"
  | "active"
  | "disabled"
  | "revoked"
  | "expired";

/** Owner-visible notification device metadata. Subscription secrets are never returned. */
export interface NotifyDeviceInfo {
  /** Opaque stable identifier used for revocation. */
  id: string;
  /** Owner-assigned display name, or `null` while pairing is pending. */
  name: string | null;
  /** Current enrollment and subscription lifecycle state. */
  status: NotifyDeviceStatus;
  /** Bounded browser and operating-system summary captured at enrollment. */
  userAgentSummary: string | null;
  /** Coarse device class such as phone, tablet, or desktop. */
  deviceClass: string | null;
  /** Two-letter country code reported by the edge, when available. */
  country: string | null;
  /** Bounded region code reported by the edge, when available. */
  region: string | null;
  /** Network autonomous-system number reported by the edge, when available. */
  asn: number | null;
  /** Unix timestamp, in seconds, when enrollment began. */
  createdAt: number;
  /** Unix expiry for an unapproved pairing code, or `null` once inapplicable. */
  pairingExpiresAt: number | null;
  /** Unix expiry for the approved claim, or `null` when unavailable. */
  claimExpiresAt: number | null;
  /** Unix timestamp of owner approval, or `null` before approval. */
  approvedAt: number | null;
  /** Unix timestamp of first active subscription attachment, or `null`. */
  activeAt: number | null;
  /** Unix timestamp of the most recent subscription attachment, or `null`. */
  lastAttachedAt: number | null;
  /** Unix timestamp of the most recent validated device request, or `null`. */
  lastSeenAt: number | null;
  /** Unix timestamp of the most recent successful Web Push delivery, or `null`. */
  lastSuccessAt: number | null;
  /** Bounded error class only; provider responses and subscription material are excluded. */
  lastError: string | null;
}

/** Bounded context shown before the owner approves a pairing code. */
export interface NotifyApprovalPreview {
  /** Unix timestamp, in seconds, when enrollment began. */
  createdAt: number;
  /** Bounded browser and operating-system summary captured at enrollment. */
  userAgentSummary: string | null;
  /** Coarse device class such as phone, tablet, or desktop. */
  deviceClass: string | null;
  /** Two-letter country code reported by the edge, when available. */
  country: string | null;
  /** Bounded region code reported by the edge, when available. */
  region: string | null;
  /** Network autonomous-system number reported by the edge, when available. */
  asn: number | null;
}

/** Body of `POST /api/notify/approvals`. */
export interface NotifyApprovalRequest {
  /** Display-safe pairing code shown on the enrolling device. */
  code: string;
  /** Owner-assigned device name. */
  name: string;
}
