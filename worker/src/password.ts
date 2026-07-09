// Password hashing + unlock-cookie signing for protected shares.

import type { Env } from "./env.ts";

const PBKDF2_ITERATIONS = 100_000;
const COOKIE_TTL_S = 7 * 24 * 3600;

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes as ArrayBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return hex(bits);
}

/** → "pbkdf2$<iterations>$<saltHex>$<hashHex>" */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hex(salt)}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltHex, hashHex] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const actual = await pbkdf2(password, hexToBytes(saltHex), parseInt(iterStr, 10));
  // Both sides are fixed-length hex of a fresh derivation; timing is not a concern here,
  // but compare in constant time anyway.
  if (actual.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`nzip-unlock:${env.NZIP_TOKEN}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function cookieName(address: string): string {
  return `nzip_a${address}`;
}

/** Set-Cookie value granting access to one site for COOKIE_TTL_S. */
export async function makeUnlockCookie(env: Env, address: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_TTL_S;
  const sig = hex(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(env),
      new TextEncoder().encode(`${address}.${exp}`),
    ),
  );
  // Path without trailing slash so the cookie also matches the bare /{address} URL.
  return `${cookieName(address)}=${exp}.${sig}; Max-Age=${COOKIE_TTL_S}; Path=/${address}; HttpOnly; Secure; SameSite=Lax`;
}

export async function hasValidUnlockCookie(
  req: Request,
  env: Env,
  address: string,
): Promise<boolean> {
  const cookies = req.headers.get("cookie") ?? "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${cookieName(address)}=([^;]+)`));
  if (!match) return false;
  const [expStr, sig] = match[1].split(".");
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await hmacKey(env),
      hexToBytes(sig) as BufferSource,
      new TextEncoder().encode(`${address}.${exp}`),
    );
  } catch {
    return false;
  }
}
