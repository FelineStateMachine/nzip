// Wire types shared by the CLI and the Worker.
// This package must stay runtime-agnostic: Web APIs only, no Deno.* or Workers globals.

/**
 * Canonical metadata for one file in a manifest.
 *
 * The short property names are part of the version 1 wire format and are
 * hashed verbatim when deriving the manifest identity.
 */
export interface ManifestFile {
  /** Lowercase, 64-character SHA-256 digest of the exact file bytes. */
  h: string;
  /** Non-negative file size in bytes. */
  s: number;
  /** Media type stored and served for the file, resolved by the CLI at push time. */
  ct: string;
}

/** Complete, versioned file map whose canonical bytes identify one site revision. */
export interface Manifest {
  /** Manifest schema version. Version `1` is the only supported value. */
  v: 1;
  /**
   * Map from validated relative paths to file metadata.
   *
   * Paths use forward slashes and omit a leading slash or `./`.
   */
  files: Record<string, ManifestFile>;
}

/**
 * Destination for a push, expressed as either an exact numeric address or a
 * registered vault with an optional alias.
 */
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

/** Reply from `POST /api/push/prepare` describing the content still required. */
export interface PrepareResponse {
  /** Lowercase SHA-256 of the canonical manifest bytes. */
  manifestHash: string;
  /** Lowercase SHA-256 blob digests that must be uploaded before committing. */
  missing: string[];
}

/** Body of `POST /api/push/commit`: atomically publish content and its access policy. */
export interface CommitRequest {
  /** Complete manifest to publish as the site's current version. */
  manifest: Manifest;
  /** Address or vault destination that should receive the new version. */
  target: Target;
  /** Lifetime in days, `"forever"` for no expiry, or omitted to preserve an existing value (14 days for a new site). */
  ttl?: number | "forever";
  /** Password to set, `null` to clear it, or omitted to preserve an existing value. */
  password?: string | null;
}

/** Reply from `POST /api/push/commit` identifying the published site revision. */
export interface CommitResponse {
  /** Four-character lowercase hexadecimal address, such as `"2a3f"`. */
  address: string;
  /** Absolute public URL on the site's isolated hostname. */
  url: string;
  /** Resolved site alias, or `null` for an unaliased address. */
  alias: string | null;
  /** Lowercase SHA-256 of the committed canonical manifest. */
  manifestHash: string;
  /** Unix expiry timestamp in seconds, or `null` for a permanent site. */
  expiresAt: number | null;
  /** Whether visitors must unlock the committed site with a password. */
  protected: boolean;
  /** Monotonically increasing push sequence number within this site. */
  seq: number;
}

/** Owner-visible summary of one site, as returned by list and status endpoints. */
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

/** A site plus its retained push history (powers `nzip site revert`). */
export interface SiteDetail extends SiteInfo {
  /** Retained push history ordered from newest to oldest. */
  history: PushInfo[];
}

/**
 * Current manifest for a site, returned only by the authenticated recovery
 * API and used to locate and verify the bundle's blobs.
 */
export interface SourceResponse {
  /** Four-character lowercase hexadecimal address of the recovered site. */
  address: string;
  /** Lowercase SHA-256 of the returned canonical manifest. */
  manifestHash: string;
  /** Current manifest used to reconstruct and verify the hosted bundle. */
  manifest: Manifest;
}

/** Owner-visible metadata and live site count for a registered vault. */
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
  /** Number of sites whose expiry falls within the next 48 hours. */
  expiringSoon: number;
}

/** Body of a revert request: the push sequence number to repoint to (defaults to previous). */
export interface RevertRequest {
  /** Push sequence to restore; omission selects the newest differing version. */
  toSeq?: number;
}

/** Body of a site PATCH. Omitted access-policy fields remain unchanged. */
export interface PatchSiteRequest {
  /** New lifetime in days, or `"forever"`; omission preserves the current expiry. */
  ttl?: number | "forever";
  /** Password to set, `null` to clear it, or omitted to leave it unchanged. */
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
  /**
   * Optional normalized, same-origin site path opened when the notification is
   * tapped. A site target is pinned to its current manifest when accepted and
   * will not open if that site changes before the tap.
   */
  path?: string;
  /** Optional provider-independent tag used to replace a related notification. */
  tag?: string;
}

/**
 * Reply from `POST /api/notify` after durable outbox acceptance.
 *
 * Acceptance confirms that eligible deliveries were queued; it does not imply
 * that a push provider or device displayed the notification.
 */
export interface NotifyResponse {
  /** Stable identifier for the persisted notification event. */
  eventId: string;
  /** Number of active device deliveries placed in the outbox. */
  queuedDevices: number;
  /** Number of approved but inactive devices excluded from delivery. */
  inactiveDevices: number;
}

/**
 * Current owner-controlled window during which new notification devices may
 * request enrollment. An opened window closes automatically after ten minutes.
 */
export interface NotifyPairingWindow {
  /** Whether the Worker currently accepts new enrollment requests. */
  enabled: boolean;
  /** Unix timestamp, in seconds, when pairing closes, or `null` while closed. */
  expiresAt: number | null;
}

/**
 * Server-side lifecycle state for a notification device.
 *
 * Devices progress from `pending` enrollment to `approved`, then `active` once
 * a subscription is attached. `disabled`, `revoked`, and `expired` are
 * non-deliverable states.
 */
export type NotifyDeviceStatus =
  | "pending"
  | "approved"
  | "active"
  | "disabled"
  | "revoked"
  | "expired";

/** Owner-visible notification device metadata. Subscription secrets are never returned. */
export interface NotifyDeviceInfo {
  /** Opaque, stable identifier used for owner actions such as revocation. */
  id: string;
  /** Owner-assigned display name, or `null` while pairing is pending. */
  name: string | null;
  /** Current enrollment and subscription lifecycle state. */
  status: NotifyDeviceStatus;
  /** Bounded browser and operating-system summary captured at enrollment. */
  userAgentSummary: string | null;
  /** Coarse device class such as phone, tablet, or desktop. */
  deviceClass: string | null;
  /** Two-letter ISO 3166-1 country code reported by the edge, when available. */
  country: string | null;
  /** Bounded region code reported by the edge, when available. */
  region: string | null;
  /** Network autonomous-system number reported by the edge, when available. */
  asn: number | null;
  /** Unix timestamp, in seconds, when enrollment began. */
  createdAt: number;
  /** Unix expiry timestamp for an unapproved pairing code, or `null` once inapplicable. */
  pairingExpiresAt: number | null;
  /** Unix expiry timestamp for an approved claim, or `null` when inapplicable. */
  claimExpiresAt: number | null;
  /** Unix timestamp, in seconds, of owner approval, or `null` before approval. */
  approvedAt: number | null;
  /** Unix timestamp, in seconds, of first subscription attachment, or `null` before it. */
  activeAt: number | null;
  /** Unix timestamp, in seconds, of the latest attachment, or `null` if never attached. */
  lastAttachedAt: number | null;
  /** Unix timestamp, in seconds, of the latest validated request, or `null` if unseen. */
  lastSeenAt: number | null;
  /** Unix timestamp, in seconds, of the latest successful delivery, or `null` if none. */
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
  /** Two-letter ISO 3166-1 country code reported by the edge, when available. */
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
