/**
 * Computes the SHA-256 digest of bytes using the Web Crypto API.
 *
 * @param bytes Bytes to hash.
 * @returns The 32-byte digest encoded as 64 lowercase hexadecimal characters.
 */
export async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
