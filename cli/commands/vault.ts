import { ApiClient } from "../lib/api.ts";
import type { Ttl, VaultLifecycle } from "@nzip/shared";
import type { Config } from "../lib/config.ts";
import { assertVaultAllowed, saveConfig } from "../lib/config.ts";
import { bold, dim, emit, fail, green, parseTtl, table } from "../lib/fmt.ts";
import { renameVault } from "../lib/paths.ts";

export interface VaultFlags {
  slot?: number;
  newName?: string;
  description?: string;
  clearDescription?: boolean;
  defaultTtl?: string;
  defaultFor?: string;
  clearDefaultFor?: boolean;
}

function defaultTtlFlag(raw: string | undefined): Ttl | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === "inherit") return null;
  try {
    return parseTtl(raw);
  } catch (cause) {
    return fail((cause as Error).message.replace("--ttl", "--default-ttl"));
  }
}

function lifecycleFlag(flags: VaultFlags): VaultLifecycle | null | undefined {
  if (flags.clearDefaultFor && flags.defaultFor !== undefined) {
    fail("pass either --default-for or --no-default-for, not both");
  }
  if (flags.clearDefaultFor) return null;
  if (flags.defaultFor === undefined) return undefined;
  if (flags.defaultFor !== "temporary" && flags.defaultFor !== "permanent") {
    fail('--default-for must be "temporary" or "permanent"');
  }
  return flags.defaultFor;
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
  rest: string[],
  flags: VaultFlags,
): Promise<void> {
  const [sub, name, third, ...extra] = rest;
  if (extra.length > 0) fail(`too many arguments for nzip vault ${sub ?? ""}`);
  const api = new ApiClient(config);
  const { slot, newName } = flags;

  if (sub === "ls" || sub === undefined) {
    if (name !== undefined) fail("usage: nzip vault ls");
    const status = await api.status();
    const vaults = status.vaults;
    emit(() => {
      if (vaults.length === 0) {
        console.log(dim("no vaults registered — run `nzip vault add <name>`"));
        return;
      }
      console.log(table(
        ["SLOT", "VAULT", "SITES", "DEFAULT TTL", "DEFAULT FOR", "DESCRIPTION"],
        vaults.map((v) => [
          `0x${v.slot.toString(16)}`,
          v.defaultFor.length > 0 ? bold(v.name) : v.name,
          String(v.siteCount),
          String(v.effectiveDefaultTtl),
          v.defaultFor.join(","),
          v.description ?? "",
        ]),
      ));
    }, {
      ok: true,
      defaultVaults: status.defaultVaults,
      globalDefaultTtl: status.globalDefaultTtl,
      vaults,
    });
    return;
  }

  if (sub === "add") {
    if (!name || third !== undefined) {
      fail("usage: nzip vault add <name> [--slot N] [--description TEXT]");
    }
    const description = descriptionFlag(flags) || undefined;
    try {
      assertVaultAllowed(name, config);
    } catch (e) {
      return fail((e as Error).message);
    }
    const v = await api.createVault(
      name,
      slot,
      description,
      defaultTtlFlag(flags.defaultTtl),
      lifecycleFlag(flags),
    );
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
      !name || third !== undefined ||
      (newName === undefined && flags.description === undefined && !flags.clearDescription) &&
        flags.defaultTtl === undefined && flags.defaultFor === undefined &&
        !flags.clearDefaultFor
    ) {
      fail(
        "usage: nzip vault update <name> [--name NEW_NAME] [--description TEXT | --no-description] [--default-ttl 14d|forever|inherit]",
      );
    }
    const description = descriptionFlag(flags);
    try {
      assertVaultAllowed(name, config);
      if (newName !== undefined) assertVaultAllowed(newName, config);
    } catch (e) {
      return fail((e as Error).message);
    }
    const v = await api.updateVault(name, {
      name: newName,
      description,
      defaultTtl: defaultTtlFlag(flags.defaultTtl),
      defaultFor: lifecycleFlag(flags),
    });
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
    if ((name !== "temporary" && name !== "permanent") || !third) {
      fail("usage: nzip vault default <temporary|permanent> <name>");
    }
    try {
      assertVaultAllowed(third, config);
    } catch (e) {
      return fail((e as Error).message);
    }
    const result = await api.setDefaultVault(name, third);
    if (name === "temporary") await saveConfig({ ...config, defaultVault: third });
    emit(
      () => console.log(`${green("✓")} ${name} default vault set to ${bold(third)}`),
      { ok: true, ...result },
    );
    return;
  }

  fail(`unknown vault subcommand: ${sub} (use ls | add | update | default)`);
}
