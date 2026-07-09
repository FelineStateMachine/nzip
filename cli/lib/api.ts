// Typed fetch client for the Worker API.

import type {
  ApiError,
  CommitRequest,
  CommitResponse,
  Manifest,
  PrepareResponse,
  SiteDetail,
  SiteInfo,
  StatusResponse,
  Target,
  VaultInfo,
} from "@nzip/shared";
import { assertVaultAllowed, type Config } from "./config.ts";

export class ApiClient {
  constructor(private config: Config) {}

  private async request<T>(method: string, path: string, body?: BodyInit): Promise<T> {
    const res = await fetch(`${this.config.server}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as ApiError).error;
      } catch { /* not json */ }
      throw new Error(`${res.status}: ${message}`);
    }
    return JSON.parse(text) as T;
  }

  status(): Promise<StatusResponse> {
    return this.request("GET", "/api/status");
  }

  prepare(manifest: Manifest): Promise<PrepareResponse> {
    return this.request("POST", "/api/push/prepare", JSON.stringify({ manifest }));
  }

  uploadBlob(hash: string, bytes: Uint8Array): Promise<{ ok: true }> {
    return this.request("PUT", `/api/blob/${hash}`, bytes as unknown as BodyInit);
  }

  commit(req: CommitRequest): Promise<CommitResponse> {
    return this.request("POST", "/api/push/commit", JSON.stringify(req));
  }

  listSites(vault?: string): Promise<SiteInfo[]> {
    const q = vault ? `?vault=${encodeURIComponent(vault)}` : "";
    return this.request("GET", `/api/sites${q}`);
  }

  siteDetail(target: string): Promise<SiteDetail> {
    return this.request("GET", `/api/sites/${encodeURIComponent(target)}`);
  }

  patchSite(
    target: string,
    patch: { ttl?: number | "forever"; password?: string | null },
  ): Promise<SiteDetail> {
    return this.request("PATCH", `/api/sites/${encodeURIComponent(target)}`, JSON.stringify(patch));
  }

  deleteSite(target: string): Promise<{ ok: true; address: string }> {
    return this.request("DELETE", `/api/sites/${encodeURIComponent(target)}`);
  }

  revert(target: string, toSeq?: number): Promise<CommitResponse & { revertedTo: number }> {
    return this.request(
      "POST",
      `/api/sites/${encodeURIComponent(target)}/revert`,
      JSON.stringify(toSeq === undefined ? {} : { toSeq }),
    );
  }

  listVaults(): Promise<VaultInfo[]> {
    return this.request("GET", "/api/vaults");
  }

  createVault(name: string, slot?: number): Promise<VaultInfo> {
    return this.request("POST", "/api/vaults", JSON.stringify({ name, slot }));
  }
}

/**
 * Resolve a CLI target string to (API path target, commit body target).
 * A bare alias picks up the default vault from config.
 */
export function resolveCliTarget(raw: string, config: Config): string {
  if (/^[0-9a-f]{4}$/.test(raw)) return raw; // raw address names no vault
  if (raw.includes(":")) {
    const [vault] = raw.split(":");
    assertVaultAllowed(vault, config);
    return raw;
  }
  const vault = config.defaultVault;
  if (!vault) {
    throw new Error(
      `"${raw}" is a bare alias but no defaultVault is set — use vault:alias or set defaultVault in config`,
    );
  }
  assertVaultAllowed(vault, config);
  return `${vault}:${raw}`;
}

export function commitTargetFor(raw: string | undefined, config: Config): Target {
  if (raw === undefined) {
    const vault = config.defaultVault;
    if (!vault) throw new Error("no target given and no defaultVault set");
    assertVaultAllowed(vault, config);
    return { vault };
  }
  if (/^[0-9a-f]{4}$/.test(raw)) return { address: parseInt(raw, 16) };
  const resolved = resolveCliTarget(raw, config);
  const [vault, alias] = resolved.split(":");
  return { vault, alias };
}
