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
  | { address: number }
  | { vault: string; alias?: string | null };

/** Body of `POST /api/push/prepare`: the manifest the client wants to push. */
export interface PrepareRequest {
  manifest: Manifest;
}

/** Reply to `prepare`: the manifest's hash and which blobs the server still needs. */
export interface PrepareResponse {
  manifestHash: string;
  /** blob hashes the server does not have yet */
  missing: string[];
}

/** Body of `POST /api/push/commit`: finalize a push at `target` with an optional TTL. */
export interface CommitRequest {
  manifest: Manifest;
  target: Target;
  /** days until expiry; "forever" = no expiry; omitted = server default (14) */
  ttl?: number | "forever";
}

/** Reply to `commit`: the allocated address and the live URL for the new push. */
export interface CommitResponse {
  /** 4-hex address, e.g. "2a3f" */
  address: string;
  url: string;
  alias: string | null;
  manifestHash: string;
  /** unix seconds, null = permanent */
  expiresAt: number | null;
  /** push sequence number for this site */
  seq: number;
}

/** Summary of a single site, as returned by list/status endpoints. */
export interface SiteInfo {
  address: string;
  vault: string;
  alias: string | null;
  manifestHash: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  url: string;
  protected: boolean;
}

/** One entry in a site's push history. */
export interface PushInfo {
  seq: number;
  manifestHash: string;
  pushedAt: number;
  note: string | null;
}

/** A site plus its retained push history (powers `nzip revert`). */
export interface SiteDetail extends SiteInfo {
  history: PushInfo[];
}

/** Current uploaded bundle for a site, returned only by the authenticated recovery API. */
export interface SourceResponse {
  address: string;
  manifestHash: string;
  manifest: Manifest;
}

/** A registered vault: its slot, name, and current site count. */
export interface VaultInfo {
  slot: number;
  name: string;
  createdAt: number;
  siteCount: number;
}

/** Reply to `GET /api/status`: server version and a snapshot of vaults and sites. */
export interface StatusResponse {
  ok: true;
  version: string;
  vaults: VaultInfo[];
  siteCount: number;
  /** sites expiring within 48h */
  expiringSoon: number;
}

/** Body of a revert request: the push sequence number to repoint to (defaults to previous). */
export interface RevertRequest {
  toSeq?: number;
}

/** Body of a site PATCH: change TTL and/or password. Omitted fields are left unchanged. */
export interface PatchSiteRequest {
  ttl?: number | "forever";
  /** set a password (string), clear it (null), or leave unchanged (undefined) */
  password?: string | null;
}

/** Standard error envelope returned by the API on failure. */
export interface ApiError {
  error: string;
}
