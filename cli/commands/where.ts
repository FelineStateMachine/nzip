// `nzip site where <target>` — print the local directory this machine pushed a site
// from. Purely local: reads the breadcrumb registry, never touches the server,
// so it stays fast enough for `cd "$(nzip site where personal:plan)"`.

import { resolveCliTarget } from "../lib/api.ts";
import { assertRawAddressAllowed, type Config } from "../lib/config.ts";
import { lookup } from "../lib/paths.ts";
import { amber, dim, emit, fail } from "../lib/fmt.ts";

export async function cmdWhere(
  config: Config,
  raw: string | undefined,
): Promise<void> {
  if (!raw) fail("usage: nzip site where <target>");

  const q = (() => {
    try {
      if (/^[0-9a-f]{4}$/.test(raw)) {
        assertRawAddressAllowed(config);
        return { address: raw };
      }
      const [vault, alias] = resolveCliTarget(raw, config).split(":");
      return { vault, alias };
    } catch (e) {
      return fail((e as Error).message);
    }
  })();

  const entry = await lookup(q);
  if (!entry) {
    fail(
      `no local path tracked for "${raw}" on this machine`,
      "it was pushed elsewhere (or before tracking existed) — push it again from its directory to record the path",
    );
  }

  let exists = false;
  try {
    await Deno.stat(entry.path); // dir, or a file for single-file pushes
    exists = true;
  } catch {
    exists = false;
  }

  emit(
    () => {
      console.log(entry.path); // bare path on stdout for `cd "$(nzip site where …)"`
      if (!exists) {
        console.error(
          dim(`  ${amber("↳")} directory no longer exists (moved or deleted)`),
        );
      }
    },
    {
      ok: true,
      target: raw,
      address: entry.address,
      vault: entry.vault ?? null,
      alias: entry.alias ?? null,
      path: entry.path,
      exists,
      url: entry.url,
      expiresAt: entry.expiresAt,
      pushedAt: entry.pushedAt,
    },
  );
}
