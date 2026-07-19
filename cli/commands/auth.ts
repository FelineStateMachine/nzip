import { ApiClient } from "../lib/api.ts";
import { configPath, loadConfig, saveConfig } from "../lib/config.ts";
import { emit, fail, green } from "../lib/fmt.ts";

function prompt2(question: string, fallback?: string): string {
  const answer = prompt(
    fallback ? `${question} [${fallback}]:` : `${question}:`,
  );
  const value = (answer ?? "").trim() || fallback || "";
  if (!value) fail(`${question} is required`);
  return value;
}

function envDefaultServer(): string | undefined {
  try {
    const server = Deno.env.get("NZIP_SERVER")?.trim();
    if (server) return server;
    const domain = Deno.env.get("NZIP_DOMAIN")?.trim().replace(
      /^https?:\/\//,
      "",
    ).replace(
      /\/$/,
      "",
    );
    return domain ? `https://${domain}` : undefined;
  } catch {
    return undefined;
  }
}

export async function cmdAuth(
  serverFlag?: string,
  tokenFlag?: string,
): Promise<void> {
  const existing = await loadConfig();
  const server = (serverFlag ?? prompt2("server", existing?.server ?? envDefaultServer()))
    .replace(/\/$/, "");
  const token = tokenFlag ?? prompt2("token", existing?.token);
  const config = { server, token, defaultVault: existing?.defaultVault };

  const api = new ApiClient(config);
  let status;
  try {
    status = await api.status();
  } catch (e) {
    fail(
      `could not verify token against ${server}/api/status — ${(e as Error).message}`,
    );
  }

  if (!config.defaultVault && status.vaults.length > 0) {
    config.defaultVault = status.defaultVaults?.temporary ?? status.vaults[0].name;
  }
  await saveConfig(config);
  emit(() => {
    console.log(
      `${green("✓")} authenticated against ${server} — saved to ${configPath()}`,
    );
    if (config.defaultVault) {
      console.log(`  temporary default vault: ${config.defaultVault}`);
    }
  }, {
    ok: true,
    server,
    configPath: configPath(),
    defaultVault: config.defaultVault ?? null,
    vaults: status.vaults,
  });
}
