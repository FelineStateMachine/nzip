// site, ls, rm, status, revert — the site-management commands.

import { ApiClient, resolveCliTarget } from "../lib/api.ts";
import type { Config } from "../lib/config.ts";
import { forget, reconcile } from "../lib/paths.ts";
import {
  ago,
  amber,
  bold,
  cyan,
  dim,
  emit,
  fail,
  green,
  parseTtl,
  table,
  ttlLeft,
} from "../lib/fmt.ts";

function targetOrFail(
  raw: string | undefined,
  config: Config,
  usage: string,
): string {
  if (!raw) fail(usage);
  try {
    return resolveCliTarget(raw, config);
  } catch (e) {
    return fail((e as Error).message);
  }
}

export async function cmdSite(
  config: Config,
  raw: string | undefined,
  ttlRaw: string | undefined,
  password: string | undefined,
  noPassword: boolean,
): Promise<void> {
  const target = targetOrFail(
    raw,
    config,
    "usage: nzip site <target> [--ttl 14d|forever] [--password PW | --no-password]",
  );
  if (password !== undefined && noPassword) {
    fail("choose either --password or --no-password, not both");
  }
  const api = new ApiClient(config);
  const patch: { ttl?: number | "forever"; password?: string | null } = {};
  if (ttlRaw !== undefined) patch.ttl = parseTtl(ttlRaw);
  if (noPassword) patch.password = null;
  else if (password !== undefined) patch.password = password;
  const site = Object.keys(patch).length === 0
    ? await api.siteDetail(target)
    : await api.patchSite(target, patch);
  const name = site.alias ? `${site.vault}:${site.alias}` : site.address;
  emit(
    () =>
      console.log(
        `${bold(name)}   ${cyan(site.url)}   ${site.manifestHash.slice(0, 8)}   ${
          site.expiresAt === null ? green("forever") : `expires in ${ttlLeft(site.expiresAt)}`
        }${site.protected ? `   ${amber("🔒")}` : ""}`,
      ),
    { ok: true, ...site },
  );
}

export async function cmdLs(
  config: Config,
  vault: string | undefined,
): Promise<void> {
  const api = new ApiClient(config);
  const sites = await api.listSites(vault);
  // The server is authoritative for what still exists — drop breadcrumbs for
  // sites it no longer lists (expired, deleted here or on another machine).
  await reconcile(new Set(sites.map((s) => s.address)), vault).catch(() => {});
  emit(() => {
    if (sites.length === 0) {
      console.log(dim(vault ? `no sites in ${vault}` : "no sites"));
      return;
    }
    console.log(table(
      ["ADDR", "VAULT", "ALIAS", "PUSHED", "EXPIRES", "MANIFEST"],
      sites.map((s) => [
        cyan(s.address),
        s.vault,
        (s.alias ?? dim("—")) + (s.protected ? " 🔒" : ""),
        ago(s.updatedAt),
        s.expiresAt === null ? green("forever") : ttlLeft(s.expiresAt),
        dim(s.manifestHash.slice(0, 8)),
      ]),
    ));
  }, { ok: true, sites });
}

export async function cmdRm(
  config: Config,
  raw: string | undefined,
  yes: boolean,
): Promise<void> {
  const target = targetOrFail(raw, config, "usage: nzip rm <target> [--yes]");
  const api = new ApiClient(config);
  const site = await api.siteDetail(target);
  const name = site.alias ? `${site.vault}:${site.alias}` : site.address;
  if (!yes) {
    const answer = prompt(`delete ${name} (${site.url})? [y/N]`);
    if (answer?.toLowerCase() !== "y") {
      emit(() => console.log(dim("aborted")), {
        ok: false,
        error: "aborted (pass --yes to skip the prompt)",
      });
      return;
    }
  }
  await api.deleteSite(target);
  await forget({
    address: site.address,
    vault: site.vault,
    alias: site.alias ?? undefined,
  }).catch(
    () => {},
  );
  emit(
    () =>
      console.log(
        `${green("✓")} removed ${bold(name)} — content becomes eligible for GC`,
      ),
    { ok: true, removed: site.address, alias: site.alias, vault: site.vault },
  );
}

export async function cmdStatus(config: Config): Promise<void> {
  const api = new ApiClient(config);
  const status = await api.status();
  emit(() => {
    console.log(`${green("●")} ${config.server}  ${dim(`v${status.version}`)}`);
    console.log(
      `  sites: ${status.siteCount}${
        status.expiringSoon > 0 ? `  ${amber(`(${status.expiringSoon} expiring <48h)`)}` : ""
      }`,
    );
    if (status.vaults.length > 0) {
      console.log(table(
        ["SLOT", "VAULT", "DESCRIPTION", "SITES"],
        status.vaults.map((
          v,
        ) => [
          `0x${v.slot.toString(16)}`,
          v.name,
          v.description ?? "",
          String(v.siteCount),
        ]),
      ));
    }
  }, { ...status, server: config.server });
}

export async function cmdRevert(
  config: Config,
  raw: string | undefined,
  toSeq: number | undefined,
  list: boolean,
): Promise<void> {
  const target = targetOrFail(
    raw,
    config,
    "usage: nzip revert <target> [--to N] [--list]",
  );
  const api = new ApiClient(config);

  if (list) {
    const site = await api.siteDetail(target);
    emit(() =>
      console.log(table(
        ["PUSH", "MANIFEST", "WHEN", "NOTE"],
        site.history.map((h) => [
          h.manifestHash === site.manifestHash ? bold(`#${h.seq} ←`) : `#${h.seq}`,
          dim(h.manifestHash.slice(0, 8)),
          ago(h.pushedAt),
          h.note ?? "",
        ]),
      )), { ok: true, current: site.manifestHash, history: site.history });
    return;
  }

  const res = await api.revert(target, toSeq);
  emit(
    () =>
      console.log(
        `${green("✓")} ${bold(raw!)} reverted to push #${res.revertedTo} (${
          dim(res.manifestHash.slice(0, 8))
        }) — ${cyan(res.url)}`,
      ),
    { ok: true, ...res },
  );
}
