// 4-hex site addresses and vault:alias target parsing.
// address (int 0..65535) = vaultSlot << 12 | siteId

/** Number of named vault slots — the high nibble of an address (0x0–0xf). */
export const VAULT_SLOTS = 16;
/** Sites addressable within a single vault — the low three nibbles (0x000–0xfff). */
export const SITES_PER_VAULT = 0x1000;

const ADDR_RE = /^[0-9a-f]{4}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** True if `s` is a well-formed 4-hex address like `"2a3f"`. */
export function isAddressString(s: string): boolean {
  return ADDR_RE.test(s);
}

/** "2a3f" → 0x2a3f. Throws on malformed input. */
export function parseAddress(s: string): number {
  if (!ADDR_RE.test(s)) throw new Error(`invalid address: ${JSON.stringify(s)}`);
  return parseInt(s, 16);
}

/** 0x2a3f → "2a3f" */
export function formatAddress(addr: number): string {
  if (!Number.isInteger(addr) || addr < 0 || addr >= VAULT_SLOTS * SITES_PER_VAULT) {
    throw new Error(`address out of range: ${addr}`);
  }
  return addr.toString(16).padStart(4, "0");
}

/** Extract the vault slot (0–15) from an address integer. */
export function vaultSlotOf(addr: number): number {
  return addr >> 12;
}

/** Valid vault or alias name: lowercase alnum + hyphen, 1-32 chars, must not look like an address. */
export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !ADDR_RE.test(name);
}

/** A parsed target: a raw address, a `vault:alias` pair, or a bare alias in the default vault. */
export type ParsedTarget =
  | { kind: "address"; address: number }
  | { kind: "vaultAlias"; vault: string; alias: string }
  | { kind: "alias"; alias: string };

/** Parse a CLI/API target: "2a3f" | "work:demo" | "demo". */
export function parseTarget(s: string): ParsedTarget {
  if (ADDR_RE.test(s)) return { kind: "address", address: parseInt(s, 16) };
  const colon = s.indexOf(":");
  if (colon !== -1) {
    const vault = s.slice(0, colon);
    const alias = s.slice(colon + 1);
    if (!isValidName(vault) || !isValidName(alias)) {
      throw new Error(`invalid target: ${JSON.stringify(s)}`);
    }
    return { kind: "vaultAlias", vault, alias };
  }
  if (!isValidName(s)) throw new Error(`invalid target: ${JSON.stringify(s)}`);
  return { kind: "alias", alias: s };
}
