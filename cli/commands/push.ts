import { ApiClient, commitTargetFor } from "../lib/api.ts";
import { buildBundle, formatBytes } from "../lib/bundle.ts";
import type { Config } from "../lib/config.ts";
import { lookupBySource, recordPush } from "../lib/paths.ts";
import { amber, bold, cyan, dim, emit, fail, green, parseTtl, ttlLeft } from "../lib/fmt.ts";

const UPLOAD_CONCURRENCY = 6;

export function formatPushPolicy(
  expiresAt: number | null,
  protectedSite: boolean,
): string {
  const expiry = expiresAt === null ? "forever" : `expires in ${ttlLeft(expiresAt)}`;
  const passwordStatus = protectedSite ? "password protected" : "no password";
  return `${expiry}, ${passwordStatus}`;
}

export async function cmdPush(
  config: Config,
  path: string | undefined,
  targetRaw: string | undefined,
  ttlRaw: string | undefined,
  password: string | undefined,
  noPassword: boolean,
  newSite: boolean,
  app?: { contentSecurityPolicy?: string },
): Promise<void> {
  if (!path) {
    fail(
      "usage: nzip site push <dir|file> [target] [--new] [--ttl 14d|forever] [--password PW | --no-password]",
    );
  }
  if (password !== undefined && noPassword) {
    fail("choose either --password or --no-password, not both");
  }
  if (newSite && targetRaw !== undefined) {
    fail("--new cannot be combined with an explicit target");
  }
  const api = new ApiClient(config);

  let effectiveTargetRaw = targetRaw;
  if (effectiveTargetRaw === undefined && !newSite) {
    const matches = await lookupBySource(path);
    if (matches.length === 1) {
      effectiveTargetRaw = matches[0].address;
    } else if (matches.length > 1) {
      fail(
        `multiple existing sites were pushed from this source: ${
          matches.map((entry) => entry.address).join(", ")
        }`,
        "pass the intended target explicitly, or pass --new to create a separate site",
      );
    }
  }

  // Resolve (and vault-guard) the target up front — before any bundling or
  // upload — so a disallowed vault is refused without touching the network.
  const rawAddress = effectiveTargetRaw !== undefined &&
    /^[0-9a-f]{4}$/.test(effectiveTargetRaw);
  const needsStatus = effectiveTargetRaw === undefined ||
    (effectiveTargetRaw !== undefined && !rawAddress && !effectiveTargetRaw.includes(":")) ||
    (rawAddress && config.allowVaults !== undefined);
  const status = needsStatus ? await api.status() : undefined;
  const targetConfig = (() => {
    if (
      effectiveTargetRaw !== undefined &&
      (/^[0-9a-f]{4}$/.test(effectiveTargetRaw) || effectiveTargetRaw.includes(":"))
    ) {
      return config;
    }
    const defaultVault = status?.defaultVaults?.temporary ?? config.defaultVault;
    if (!defaultVault) {
      fail("server has no temporary default vault — specify vault:alias or configure one");
    }
    return { ...config, defaultVault };
  })();
  const target = (() => {
    try {
      return commitTargetFor(effectiveTargetRaw, targetConfig, status?.vaults);
    } catch (e) {
      return fail((e as Error).message);
    }
  })();

  const bundle = await buildBundle(path).catch((e) => fail((e as Error).message));
  const fileCount = Object.keys(bundle.manifest.files).length;
  emit(() => {
    console.log(
      dim(
        `  bundling ${path} … ${fileCount} files, ${formatBytes(bundle.totalBytes)}`,
      ),
    );
    for (const w of bundle.warnings) console.log(`  ${amber("!")} ${w}`);
  }, undefined);

  const prep = await api.prepare(bundle.manifest);
  const dedupCount = bundle.blobs.size - prep.missing.length;
  const missingBytes = prep.missing.reduce(
    (n, h) => n + (bundle.blobs.get(h)?.length ?? 0),
    0,
  );
  emit(() =>
    console.log(
      dim(
        `  manifest ${prep.manifestHash.slice(0, 8)} — ${prep.missing.length} new blobs (${
          formatBytes(missingBytes)
        }), ${dedupCount} deduped`,
      ),
    ), undefined);

  // Upload missing blobs with bounded concurrency.
  let done = 0;
  const queue = [...prep.missing];
  const workers = Array.from(
    { length: Math.min(UPLOAD_CONCURRENCY, queue.length) },
    async () => {
      for (let h = queue.shift(); h !== undefined; h = queue.shift()) {
        const bytes = bundle.blobs.get(h);
        if (!bytes) fail(`internal: missing blob bytes for ${h}`);
        await api.uploadBlob(h, bytes);
        done++;
      }
    },
  );
  await Promise.all(workers);
  if (prep.missing.length > 0) {
    emit(() => console.log(dim(`  uploaded ${done}/${prep.missing.length}`)));
  }

  const ttl = ttlRaw === undefined ? undefined : parseTtl(ttlRaw);
  const passwordPolicy = noPassword ? null : password;
  const res = await api.commit({
    manifest: bundle.manifest,
    target,
    ttl,
    password: passwordPolicy,
    ...(app === undefined ? {} : { app }),
  });

  // Breadcrumb: remember which directory this machine pushed from so
  // `nzip site where` can find it later. Best-effort — never fail a push over it.
  await recordPush({
    address: res.address,
    vault: "vault" in target ? target.vault : undefined,
    alias: res.alias,
    path,
    url: res.url,
    expiresAt: res.expiresAt,
    rebindSource: targetRaw !== undefined,
  }).catch(() => {});

  const label = res.alias ? `${"vault" in target ? target.vault : "?"}:${res.alias}` : res.address;
  const policy = formatPushPolicy(res.expiresAt, res.protected);
  emit(
    () =>
      console.log(
        `${green("✓")} pushed ${bold(label)} → ${cyan(res.url)}  ${
          dim(`(${policy}, push #${res.seq})`)
        }`,
      ),
    {
      ok: true,
      ...res,
      files: fileCount,
      newBlobs: prep.missing.length,
      dedupedBlobs: dedupCount,
      warnings: bundle.warnings,
    },
  );
}
