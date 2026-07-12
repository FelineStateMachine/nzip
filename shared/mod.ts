/**
 * Shared contract between the nzip CLI and Worker: manifest canonicalization,
 * content hashing, address/target parsing, media-type resolution, and the wire
 * types exchanged over the API.
 *
 * This module is deliberately runtime-agnostic — it uses only Web-standard APIs
 * (no `Deno.*` or Workers globals), so the exact same code runs under Deno and
 * workerd and both sides always agree on a manifest hash.
 *
 * ```ts
 * import { manifestHash, parseTarget } from "@nzip/shared";
 *
 * const t = parseTarget("work:demo"); // { kind: "vaultAlias", vault: "work", alias: "demo" }
 * const hash = await manifestHash({
 *   v: 1,
 *   files: { "index.html": { h: "…", s: 12, ct: "text/html" } },
 * });
 * ```
 *
 * @module
 */

export * from "./types.ts";
export * from "./hash.ts";
export * from "./manifest.ts";
export * from "./address.ts";
export * from "./mediatypes.ts";
export * from "./version.ts";
export * from "./limits.ts";
