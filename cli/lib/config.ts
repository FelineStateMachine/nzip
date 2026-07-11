import { join } from "@std/path";
import { fail } from "./fmt.ts";

export interface Config {
  server: string;
  token: string;
  defaultVault?: string;
  /**
   * Optional allow-list of vault names this config may target by name. When
   * present, any push/site/rm/revert/default that names a vault outside the
   * list is refused — so a restricted agent can't drop content into a vault
   * that sits adjacent to things you share professionally. Absent = no limit;
   * empty array = no named vault is permitted.
   */
  allowVaults?: string[];
}

/** Throw if `config.allowVaults` is set and does not include `vault`. */
export function assertVaultAllowed(vault: string, config: Config): void {
  if (!config.allowVaults) return; // unset → unrestricted
  if (!config.allowVaults.includes(vault)) {
    const allowed = config.allowVaults.length ? config.allowVaults.join(", ") : "none";
    throw new Error(`vault "${vault}" is not allowed by this config (allowed: ${allowed})`);
  }
}

export function configDir(): string {
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  const home = Deno.env.get("HOME") ?? ".";
  return join(xdg ?? join(home, ".config"), "nzip");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export async function loadConfig(): Promise<Config | null> {
  try {
    return JSON.parse(await Deno.readTextFile(configPath())) as Config;
  } catch {
    return null;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await Deno.mkdir(configDir(), { recursive: true });
  const path = configPath();
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + "\n");
  await Deno.chmod(path, 0o600);
}

export async function requireConfig(): Promise<Config> {
  const config = await loadConfig();
  if (!config) fail("not authenticated");
  return config;
}
