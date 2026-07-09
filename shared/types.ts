// Wire types shared by the CLI and the Worker.
// This package must stay runtime-agnostic: Web APIs only, no Deno.* or Workers globals.

export interface ManifestFile {
  /** sha256 hex of the file bytes */
  h: string;
  /** size in bytes */
  s: number;
  /** content-type, resolved at push time by the CLI */
  ct: string;
}

export interface Manifest {
  v: 1;
  /** path (relative, forward slashes, no leading ./) → file entry */
  files: Record<string, ManifestFile>;
}

/** "2a3f" | "work:demo" | "demo" (alias in default vault, resolved client-side to vault:alias) */
export type Target =
  | { address: number }
  | { vault: string; alias?: string | null };

export interface PrepareRequest {
  manifest: Manifest;
}

export interface PrepareResponse {
  manifestHash: string;
  /** blob hashes the server does not have yet */
  missing: string[];
}

export interface CommitRequest {
  manifest: Manifest;
  target: Target;
  /** days until expiry; "forever" = no expiry; omitted = server default (14) */
  ttl?: number | "forever";
}

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

export interface PushInfo {
  seq: number;
  manifestHash: string;
  pushedAt: number;
  note: string | null;
}

export interface SiteDetail extends SiteInfo {
  history: PushInfo[];
}

export interface VaultInfo {
  slot: number;
  name: string;
  createdAt: number;
  siteCount: number;
}

export interface StatusResponse {
  ok: true;
  version: string;
  vaults: VaultInfo[];
  siteCount: number;
  /** sites expiring within 48h */
  expiringSoon: number;
}

export interface RevertRequest {
  toSeq?: number;
}

export interface PatchSiteRequest {
  ttl?: number | "forever";
  /** set a password (string), clear it (null), or leave unchanged (undefined) */
  password?: string | null;
}

export interface ApiError {
  error: string;
}
