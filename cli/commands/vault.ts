import { ApiClient } from "../lib/api.ts";
import type { Config } from "../lib/config.ts";
import { assertVaultAllowed, saveConfig } from "../lib/config.ts";
import { bold, dim, emit, fail, green, table } from "../lib/fmt.ts";

export async function cmdVault(
  config: Config,
  sub: string | undefined,
  name: string | undefined,
  slot: number | undefined,
  newName: string | undefined,
  description: string | undefined,
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
        ["SLOT", "VAULT", "DESCRIPTION", "SITES"],
        vaults.map((v) => [
          `0x${v.slot.toString(16)}`,
          v.name === config.defaultVault ? bold(`${v.name} *`) : v.name,
          v.description ?? "",
          String(v.siteCount),
        ]),
      ));
    }, { ok: true, defaultVault: config.defaultVault ?? null, vaults });
    return;
  }

  if (sub === "add") {
    if (!name) fail("usage: nzip vault add <name> [--slot N] [--description TEXT]");
    try {
      assertVaultAllowed(name, config);
    } catch (e) {
      return fail((e as Error).message);
    }
    const v = await api.createVault(name, slot, description);
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

  if (sub === "update") {
    if (!name || (newName === undefined && description === undefined)) {
      fail("usage: nzip vault update <name> [--name NEW_NAME] [--description TEXT]");
    }
    try {
      assertVaultAllowed(name, config);
    } catch (e) {
      return fail((e as Error).message);
    }
    const v = await api.updateVault(name, { name: newName, description });
    if (newName !== undefined && newName !== name) {
      await saveConfig({
        ...config,
        ...(config.defaultVault === name ? { defaultVault: newName } : {}),
        ...(config.allowVaults
          ? { allowVaults: config.allowVaults.map((vault) => vault === name ? newName : vault) }
          : {}),
      });
    }
    emit(
      () =>
        console.log(
          `${green("✓")} vault ${bold(name)} updated${newName ? ` as ${bold(newName)}` : ""}`,
        ),
      { ok: true, ...v },
    );
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

  fail(`unknown vault subcommand: ${sub} (use ls | add | update | default)`);
}
