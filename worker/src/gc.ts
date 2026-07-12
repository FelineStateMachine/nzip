import { parseManifest } from "../../shared/mod.ts";
import type { Env } from "./env.ts";

// An R2 object is live iff it is referenced by the current manifest or any
// retained history entry of any non-deleted site. The 24h age guard means an
// in-flight push (blobs uploaded, commit pending) can never lose objects to a
// concurrent sweep.
const MIN_AGE_MS = 24 * 3600 * 1000;

export async function runGc(
  env: Env,
): Promise<{ expiredSites: number; deletedObjects: number }> {
  const now = Math.floor(Date.now() / 1000);

  // 1. Sweep expired sites (cascades to pushes history).
  const expired = await env.DB.prepare(
    "DELETE FROM sites WHERE expires_at IS NOT NULL AND expires_at < ? RETURNING address",
  ).bind(now).all<{ address: number }>();

  // 2. Mark: every manifest referenced by any remaining site or history row.
  const liveManifests = new Set<string>();
  const current = await env.DB.prepare("SELECT current_manifest FROM sites")
    .all<{ current_manifest: string }>();
  for (const r of current.results) liveManifests.add(r.current_manifest);
  const historic = await env.DB.prepare(
    "SELECT DISTINCT manifest_hash FROM pushes",
  )
    .all<{ manifest_hash: string }>();
  for (const r of historic.results) liveManifests.add(r.manifest_hash);

  // Live blobs = union of files across live manifests.
  const liveBlobs = new Set<string>();
  for (const hash of liveManifests) {
    const obj = await env.CONTENT.get(`manifest/${hash}`);
    if (!obj) continue;
    const manifest = parseManifest(new Uint8Array(await obj.arrayBuffer()));
    for (const f of Object.values(manifest.files)) liveBlobs.add(f.h);
  }

  // 3. Sweep R2: delete unreferenced objects older than the age guard.
  let deleted = 0;
  const cutoff = Date.now() - MIN_AGE_MS;
  for (const prefix of ["manifest/", "blob/"] as const) {
    let cursor: string | undefined;
    do {
      const page: R2Objects = await env.CONTENT.list({
        prefix,
        cursor,
        limit: 1000,
      });
      const doomed = page.objects.filter((o) => {
        if (o.uploaded.getTime() > cutoff) return false;
        const hash = o.key.slice(prefix.length);
        return prefix === "manifest/"
          ? !liveManifests.has(hash)
          : !liveBlobs.has(hash);
      }).map((o) => o.key);
      if (doomed.length > 0) {
        await env.CONTENT.delete(doomed);
        deleted += doomed.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  return { expiredSites: expired.results.length, deletedObjects: deleted };
}
