import { ApiClient } from "../lib/api.ts";
import type { Config } from "../lib/config.ts";
import { assertVaultAllowed, saveConfig } from "../lib/config.ts";
import { bold, dim, emit, fail, green, table } from "../lib/fmt.ts";

export async function cmdVault(
  config: Config,
  sub: string | undefined,
  name: string | undefined,
  slot: number | undefined,
): Promise<void> {
  const api = new ApiClient(config);

  if (sub === "ls" || sub === undefined) {
    const vaults = await api.listVaults();
    emit(() => {
      if (vaults.length === 0) {
        console.log(dim("no vaults registered — run `nzip vault add <name>`"));
        return;
      }
      console.log(table(
        ["SLOT", "VAULT", "SITES"],
        vaults.map((v) => [
          `0x${v.slot.toString(16)}`,
          v.name === config.defaultVault ? bold(`${v.name} *`) : v.name,
          String(v.siteCount),
        ]),
      ));
    }, { ok: true, defaultVault: config.defaultVault ?? null, vaults });
    return;
  }

  if (sub === "add") {
    if (!name) fail("usage: nzip vault add <name> [--slot N]");
    try {
      assertVaultAllowed(name, config);
    } catch (e) {
      return fail((e as Error).message);
    }
    const v = await api.createVault(name, slot);
    const madeDefault = !config.defaultVault;
    if (madeDefault) await saveConfig({ ...config, defaultVault: v.name });
    emit(() => {
      console.log(
        `${green("✓")} vault ${bold(v.name)} registered at slot 0x${v.slot.toString(16)}`,
      );
      if (madeDefault) console.log(dim(`  set as default vault`));
    }, {
      ok: true,
      ...v,
      default: madeDefault || config.defaultVault === v.name,
    });
    return;
  }

  if (sub === "default") {
    if (!name) fail("usage: nzip vault default <name>");
    try {
      assertVaultAllowed(name, config);
    } catch (e) {
      return fail((e as Error).message);
    }
    const vaults = await api.listVaults();
    if (!vaults.some((v) => v.name === name)) fail(`unknown vault: ${name}`);
    await saveConfig({ ...config, defaultVault: name });
    emit(
      () => console.log(`${green("✓")} default vault set to ${bold(name)}`),
      { ok: true, defaultVault: name },
    );
    return;
  }

  fail(`unknown vault subcommand: ${sub} (use ls | add | default)`);
}
