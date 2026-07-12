import { ApiClient } from "../lib/api.ts";
import type { Config } from "../lib/config.ts";
import { assertVaultAllowed, saveConfig } from "../lib/config.ts";
import { bold, dim, emit, fail, green, table } from "../lib/fmt.ts";
import { renameVault } from "../lib/paths.ts";

export interface VaultFlags {
  slot?: number;
  newName?: string;
  description?: string;
  clearDescription?: boolean;
}

/**
 * A bare `--description` (value swallowed by the shell) parses to "", which
 * would otherwise silently clear the stored text — require `--no-description`
 * for that instead.
 */
function descriptionFlag(flags: VaultFlags): string | undefined {
  if (flags.clearDescription) {
    if (flags.description !== undefined) {
      fail("pass either --description TEXT or --no-description, not both");
    }
    return "";
  }
  if (flags.description !== undefined && flags.description.trim() === "") {
    fail("--description requires text; use --no-description to clear it");
  }
  return flags.description;
}

export async function cmdVault(
  config: Config,
  sub: string | undefined,
  name: string | undefined,
  flags: VaultFlags,
): Promise<void> {
  const api = new ApiClient(config);
  const { slot, newName } = flags;

  if (sub === "ls" || sub === undefined) {
    const vaults = await api.listVaults();
    emit(() => {
      if (vaults.length === 0) {
        console.log(dim("no vaults registered — run `nzip vault add <name>`"));
        return;
      }
      console.log(table(
        ["SLOT", "VAULT", "SITES", "DESCRIPTION"],
        vaults.map((v) => [
          `0x${v.slot.toString(16)}`,
          v.name === config.defaultVault ? bold(`${v.name} *`) : v.name,
          String(v.siteCount),
          v.description ?? "",
        ]),
      ));
    }, { ok: true, defaultVault: config.defaultVault ?? null, vaults });
    return;
  }

  if (sub === "add") {
    if (!name) fail("usage: nzip vault add <name> [--slot N] [--description TEXT]");
    const description = descriptionFlag(flags) || undefined;
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
    if (
      !name || (newName === undefined && flags.description === undefined && !flags.clearDescription)
    ) {
      fail(
        "usage: nzip vault update <name> [--name NEW_NAME] [--description TEXT | --no-description]",
      );
    }
    const description = descriptionFlag(flags);
    try {
      assertVaultAllowed(name, config);
      if (newName !== undefined) assertVaultAllowed(newName, config);
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
      await renameVault(name, newName);
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
