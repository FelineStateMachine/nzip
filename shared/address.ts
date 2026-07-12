// 4-hex site addresses and vault:alias target parsing.
// address (int 0..65535) = vaultSlot << 12 | siteId

/** Number of named vault slots — the high nibble of an address (0x0–0xf). */
export const VAULT_SLOTS = 16;
/** Sites addressable within a single vault — the low three nibbles (0x000–0xfff). */
export const SITES_PER_VAULT = 0x1000;

const ADDR_RE = /^[0-9a-f]{4}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Tests whether a string is a canonical four-character site address.
 *
 * @param s Candidate address such as `"2a3f"`.
 * @returns `true` only for four lowercase hexadecimal characters.
 */
export function isAddressString(s: string): boolean {
  return ADDR_RE.test(s);
}

/**
 * Converts a canonical address string to its numeric representation.
 *
 * @param s Four-character lowercase hexadecimal address.
 * @returns Integer in the inclusive range `0x0000`–`0xffff`.
 * @throws {Error} If `s` is not a canonical address.
 */
export function parseAddress(s: string): number {
  if (!ADDR_RE.test(s)) {
    throw new Error(`invalid address: ${JSON.stringify(s)}`);
  }
  return parseInt(s, 16);
}

/**
 * Formats a numeric site address as four lowercase hexadecimal characters.
 *
 * @param addr Integer site address.
 * @returns Canonical address string such as `"2a3f"`.
 * @throws {Error} If `addr` is not an integer from `0x0000` through `0xffff`.
 */
export function formatAddress(addr: number): string {
  if (
    !Number.isInteger(addr) || addr < 0 || addr >= VAULT_SLOTS * SITES_PER_VAULT
  ) {
    throw new Error(`address out of range: ${addr}`);
  }
  return addr.toString(16).padStart(4, "0");
}

/**
 * Extracts the high-nibble vault slot from a numeric site address.
 *
 * @param addr Numeric site address.
 * @returns Vault slot from `0` through `15`.
 */
export function vaultSlotOf(addr: number): number {
  return addr >> 12;
}

/**
 * Tests whether a string is a valid vault or alias name.
 *
 * Names contain 1–32 lowercase alphanumeric or hyphen characters, start with
 * an alphanumeric character, and cannot look like a four-hex address.
 *
 * @param name Candidate vault or alias name.
 * @returns Whether the candidate satisfies the shared naming contract.
 */
export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !ADDR_RE.test(name);
}

/** A parsed target: a raw address, a `vault:alias` pair, or a bare alias in the default vault. */
export type ParsedTarget =
  | {
    /** Discriminator for a direct four-hex address. */
    kind: "address";
    /** Parsed numeric site address. */
    address: number;
  }
  | {
    /** Discriminator for an explicitly named vault and alias. */
    kind: "vaultAlias";
    /** Valid registered-vault name from the input. */
    vault: string;
    /** Valid site alias from the input. */
    alias: string;
  }
  | {
    /** Discriminator for an alias that requires the caller's default vault. */
    kind: "alias";
    /** Valid site alias from the input. */
    alias: string;
  };

/**
 * Parses a CLI or API target into a discriminated union.
 *
 * @param s Direct address (`"2a3f"`), vault alias (`"work:demo"`), or bare
 * alias (`"demo"`).
 * @returns Structured target for address or vault resolution.
 * @throws {Error} If the target or either name component is malformed.
 */
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
