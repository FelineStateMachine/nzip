import { isAbsolute, relative, resolve } from "@std/path";
import { isValidName } from "@nzip/shared";
import { ApiClient } from "../lib/api.ts";
import type { Config } from "../lib/config.ts";
import { assertVaultAllowed } from "../lib/config.ts";
import { bold, cyan, dim, emit, fail, green } from "../lib/fmt.ts";
import { cmdPush } from "./push.ts";

const APP_CONFIG_FILE = "nzip.app.json";

export interface NzipAppConfig {
  v: 1;
  framework: "lofi";
  target: string;
  address: string;
  origin: string;
  build: { task: string; output: string };
}

interface AppFlags {
  framework?: string;
  output?: string;
  buildTask?: string;
}

async function readAppConfig(optional = false): Promise<NzipAppConfig | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(APP_CONFIG_FILE);
  } catch (cause) {
    if (optional && cause instanceof Deno.errors.NotFound) return null;
    return fail(`no ${APP_CONFIG_FILE} found — run \`nzip app init <alias>\` first`);
  }
  try {
    const value = JSON.parse(text) as Partial<NzipAppConfig>;
    if (
      value.v !== 1 || value.framework !== "lofi" ||
      typeof value.target !== "string" || typeof value.address !== "string" ||
      typeof value.origin !== "string" || typeof value.build?.task !== "string" ||
      typeof value.build.output !== "string"
    ) {
      throw new Error("unsupported shape");
    }
    return value as NzipAppConfig;
  } catch (cause) {
    return fail(`invalid ${APP_CONFIG_FILE}: ${(cause as Error).message}`);
  }
}

function splitAppTarget(raw: string, defaultVault: string | null): [string, string] {
  const separator = raw.indexOf(":");
  const vault = separator === -1 ? defaultVault : raw.slice(0, separator);
  const alias = separator === -1 ? raw : raw.slice(separator + 1);
  if (!vault) fail("server has no permanent default vault — use vault:alias");
  if (!isValidName(vault) || !isValidName(alias)) {
    fail("app target must be an alias or vault:alias using lowercase names");
  }
  return [vault, alias];
}

function containsStringLiteral(source: string, value: string): boolean {
  return source.includes(JSON.stringify(value)) ||
    source.includes(`'${value.replaceAll("'", "\\'")}'`);
}

async function cmdAppInit(
  config: Config,
  rawTarget: string | undefined,
  flags: AppFlags,
): Promise<void> {
  const existing = await readAppConfig(true);
  if (existing && rawTarget === undefined) rawTarget = existing.target;
  if (!rawTarget) fail("usage: nzip app init <alias|vault:alias> [--framework lofi]");
  if (flags.framework !== undefined && flags.framework !== "lofi") {
    fail("the first-class app host currently supports --framework lofi");
  }

  const api = new ApiClient(config);
  const status = await api.status();
  const [vault, alias] = splitAppTarget(rawTarget, status.defaultVaults?.permanent ?? null);
  assertVaultAllowed(vault, config);
  const target = `${vault}:${alias}`;
  if (existing && existing.target !== target) {
    fail(`${APP_CONFIG_FILE} already reserves ${existing.target}; refusing to replace its origin`);
  }

  const reservation = await api.initApp(vault, alias);
  const origin = new URL(reservation.url).origin;
  if (existing && (existing.address !== reservation.address || existing.origin !== origin)) {
    fail(`server reservation for ${target} does not match ${APP_CONFIG_FILE}`);
  }
  const appConfig: NzipAppConfig = existing ?? {
    v: 1,
    framework: "lofi",
    target,
    address: reservation.address,
    origin,
    build: {
      task: flags.buildTask ?? "build",
      output: flags.output ?? "dist",
    },
  };
  await Deno.writeTextFile(APP_CONFIG_FILE, `${JSON.stringify(appConfig, null, 2)}\n`);

  emit(
    () => {
      console.log(`${green("✓")} reserved ${bold(target)} → ${cyan(reservation.url)}`);
      console.log(dim(`  wrote ${APP_CONFIG_FILE} (safe to commit; contains no token)`));
      console.log(
        dim(`  add ${JSON.stringify(origin)} to lofi credentialOrigins, then run nzip app deploy`),
      );
    },
    { ok: true, ...reservation, framework: appConfig.framework, config: APP_CONFIG_FILE },
  );
}

async function requireFile(path: string): Promise<void> {
  try {
    if (!(await Deno.stat(path)).isFile) throw new Error("not a file");
  } catch {
    fail(`lofi build output is missing ${path}`);
  }
}

async function cmdAppDeploy(config: Config): Promise<void> {
  const app = await readAppConfig();
  if (!app) return;
  const root = Deno.cwd();
  const output = resolve(root, app.build.output);
  const outputRelative = relative(root, output);
  if (
    isAbsolute(app.build.output) || outputRelative === ".." || outputRelative.startsWith(`..${"/"}`)
  ) {
    fail(`${APP_CONFIG_FILE} build.output must stay inside the app directory`);
  }

  let appSource: string;
  try {
    appSource = await Deno.readTextFile(resolve(root, "src/app.ts"));
  } catch {
    return fail("lofi app source src/app.ts is missing");
  }
  if (!containsStringLiteral(appSource, app.origin)) {
    fail(
      `src/app.ts must include ${
        JSON.stringify(app.origin)
      } in credentialOrigins before deployment`,
    );
  }
  const hostname = new URL(app.origin).hostname;
  if (/\bpasskey\s*:/.test(appSource) && !containsStringLiteral(appSource, hostname)) {
    fail(`src/app.ts passkey.rpId must be pinned to ${JSON.stringify(hostname)}`);
  }

  emit(() => console.log(dim(`  running deno task ${app.build.task} with LOFI_BASE_PATH=/`)));
  const built = await new Deno.Command("deno", {
    args: ["task", app.build.task],
    cwd: root,
    env: { LOFI_BASE_PATH: "/" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!built.success) fail(`lofi build failed with exit code ${built.code}`);

  await Promise.all([
    requireFile(resolve(output, "index.html")),
    requireFile(resolve(output, "manifest.webmanifest")),
    requireFile(resolve(output, "sw.js")),
    requireFile(resolve(output, "lofi-precache.json")),
    requireFile(resolve(output, "lofi-schema.json")),
    requireFile(resolve(output, "lofi-build.json")),
  ]);
  let buildInfo: { lofiVersion?: unknown; sourceHash?: unknown; basePath?: unknown; csp?: unknown };
  try {
    buildInfo = JSON.parse(await Deno.readTextFile(resolve(output, "lofi-build.json")));
  } catch {
    return fail("dist/lofi-build.json is not valid JSON");
  }
  if (
    typeof buildInfo.lofiVersion !== "string" || typeof buildInfo.sourceHash !== "string" ||
    buildInfo.basePath !== "/" ||
    (buildInfo.csp !== undefined && typeof buildInfo.csp !== "string")
  ) {
    fail("lofi build identity is invalid or was not built for the origin root");
  }

  await cmdPush(
    config,
    output,
    app.target,
    undefined,
    undefined,
    false,
    typeof buildInfo.csp === "string" ? { contentSecurityPolicy: buildInfo.csp } : {},
  );
}

export async function cmdApp(
  config: Config,
  rest: string[],
  flags: AppFlags,
): Promise<void> {
  const [sub, target, ...extra] = rest;
  if (extra.length > 0) fail(`too many arguments for nzip app ${sub ?? ""}`);
  if (sub === "init") return await cmdAppInit(config, target, flags);
  if (sub === "deploy") {
    if (target !== undefined) fail("usage: nzip app deploy");
    return await cmdAppDeploy(config);
  }
  fail("usage: nzip app <init|deploy> ...");
}
