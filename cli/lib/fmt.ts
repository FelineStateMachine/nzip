// Small output helpers.

export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

export function ago(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ttlLeft(expiresAt: number | null): string {
  if (expiresAt === null) return "forever";
  const s = expiresAt - Math.floor(Date.now() / 1000);
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.ceil(s / 60)}m`;
  if (s < 86400) return `${Math.ceil(s / 3600)}h`;
  return `${Math.ceil(s / 86400)}d`;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripAnsi(r[i]).length))
  );
  const line = (cells: string[], pad: (s: string, w: number) => string) =>
    cells.map((c, i) => pad(c, widths[i])).join("   ");
  const padAnsi = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stripAnsi(s).length));
  return [
    dim(line(headers, (s, w) => s.padEnd(w))),
    ...rows.map((r) => line(r, padAnsi)),
  ].join("\n");
}

function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

/**
 * Print `data` as one JSON line in --json mode, otherwise run the human printer.
 * With `data` undefined the line is progress-only and suppressed in --json mode.
 */
export function emit(human: () => void, data?: unknown): void {
  if (jsonMode) {
    if (data !== undefined) console.log(JSON.stringify(data));
  } else {
    human();
  }
}

/** Actionable next step for common failures — agents read this from the `hint` field. */
export function hintFor(message: string): string | undefined {
  if (/not authenticated/.test(message)) {
    return "run: nzip auth --server <url> --token <token>";
  }
  if (/401|unauthorized/i.test(message)) {
    return "token rejected — re-run: nzip auth --server <url> --token <token>";
  }
  if (/not allowed by this config/.test(message)) {
    return "this config restricts which vaults it may target — target an allowed vault, or ask to edit allowVaults in ~/.config/nzip/config.json";
  }
  if (/unknown vault/.test(message)) {
    return "list vaults with: nzip vault ls — register one with: nzip vault add <name>";
  }
  if (/site not found/.test(message)) {
    return "list sites with: nzip site ls --json (targets: 2a3f | vault:alias | alias)";
  }
  if (/bare alias.*defaultVault|no defaultVault/.test(message)) {
    return "use vault:alias explicitly, or set a default with: nzip vault default <name>";
  }
  if (/blobs missing/.test(message)) {
    return "an earlier upload was interrupted — re-run the same nzip site push";
  }
  if (/invalid --ttl|ttl must be/.test(message)) {
    return "use --ttl 14d, --ttl 30d, or --ttl forever";
  }
  if (/invalid target/.test(message)) {
    return "targets are 4 hex chars (2a3f), vault:alias (work:demo), or a bare alias";
  }
  if (/error sending request|Connection refused|dns error/i.test(message)) {
    return "server unreachable — check the server URL with: nzip status, or re-run nzip auth";
  }
  if (/vault is full|slots are taken/.test(message)) {
    return "check usage with: nzip vault ls — remove sites with: nzip site rm <target>";
  }
  return undefined;
}

export function fail(message: string, hint = hintFor(message)): never {
  if (jsonMode) {
    console.error(
      JSON.stringify({ ok: false, error: message, ...(hint ? { hint } : {}) }),
    );
  } else {
    console.error(`${red("✗")} ${message}`);
    if (hint) console.error(`  ${dim(`↳ ${hint}`)}`);
  }
  Deno.exit(1);
}

/** Parse "14d" | "30" | "forever" → ttl value for the API. */
export function parseTtl(raw: string): number | "forever" {
  if (raw === "forever" || raw === "0") return "forever";
  const m = raw.match(/^(\d+)d?$/);
  if (!m) throw new Error(`invalid --ttl: ${raw} (use e.g. 14d, 30d, forever)`);
  return parseInt(m[1], 10);
}
