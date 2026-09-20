import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/password.ts";

const headers = { authorization: "Bearer runtime-test-token", "content-type": "application/json" };
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const manifest = { v: 1, files: { "index.html": { h: emptyHash, s: 0, ct: "text/html" } } };

function api(path: string, body?: unknown, method = "POST") {
  return SELF.fetch(`https://share.demo.dev/api/${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createVault(policy: Record<string, unknown> = {}) {
  const response = await api("vaults", {
    name: "reviews",
    slot: 6,
    description: "Private short-lived personal review artifacts",
    defaultTtl: 7,
    maxTtl: 14,
    requirePassword: true,
    defaultPassword: "review-password",
    ...policy,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  await env.CONTENT.put(`blob/${emptyHash}`, new Uint8Array());
  return response;
}

async function publish(
  target: unknown = { vault: "reviews" },
  policy: Record<string, unknown> = {},
) {
  return await api("push/commit", { manifest, target, ...policy });
}

describe("Vault purpose and enforced policy", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sites WHERE vault_slot = 6"),
      env.DB.prepare("DELETE FROM vaults WHERE slot = 6"),
    ]);
  });
  it("exposes policy metadata but no verifier and inherits TTL/password on creation", async () => {
    const vault = await createVault();
    const metadata = await vault.json<Record<string, unknown>>();
    expect(metadata).toMatchObject({
      description: "Private short-lived personal review artifacts",
      effectiveDefaultTtl: 7,
      maxTtl: 14,
      requirePassword: true,
      hasDefaultPassword: true,
    });
    expect(JSON.stringify(metadata)).not.toContain("review-password");
    expect(JSON.stringify(metadata)).not.toContain("default_password_hash");
    const published = await publish();
    expect(published.status).toBe(200);
    const site = await published.json<
      { address: string; ttl: number; ttlSource: string; protected: boolean }
    >();
    expect(site).toMatchObject({ ttl: 7, ttlSource: "vault", protected: true });
    const stored = await env.DB.prepare("SELECT password_hash FROM sites WHERE address = ?")
      .bind(parseInt(site.address, 16)).first<{ password_hash: string }>();
    expect(await verifyPassword("review-password", stored!.password_hash)).toBe(true);
    expect((await SELF.fetch(`https://${site.address}.demo.dev/`)).status).toBe(401);
    const status = await api("status", undefined, "GET");
    const text = await status.text();
    expect(text).toContain('"hasDefaultPassword":true');
    expect(text).not.toContain(stored!.password_hash);
  });

  it("enforces caps and required protection on create, revision, PATCH and raw DB writes", async () => {
    await createVault();
    for (const policy of [{ ttl: "forever" }, { ttl: 15 }, { password: null }]) {
      expect((await publish(undefined, policy)).status).toBe(400);
    }
    const created = await (await publish()).json<{ address: string; expiresAt: number }>();
    const target = { address: parseInt(created.address, 16) };
    const updated = await (await publish(target)).json<Record<string, unknown>>();
    expect(updated).toMatchObject({
      address: created.address,
      expiresAt: created.expiresAt,
      protected: true,
      ttlSource: "existing-site",
      seq: 2,
    });
    expect((await publish(target, { password: null })).status).toBe(400);
    expect((await publish(target, { ttl: 15 })).status).toBe(400);
    expect((await api(`sites/${created.address}`, { password: null }, "PATCH")).status).toBe(400);
    expect((await api(`sites/${created.address}`, { ttl: "forever" }, "PATCH")).status).toBe(400);
    const reverted = await api(`sites/${created.address}/revert`, { toSeq: 1 });
    expect(reverted.status).toBe(200);
    expect(await reverted.json()).toMatchObject({ protected: true, expiresAt: created.expiresAt });
    await expect(
      env.DB.prepare("UPDATE sites SET password_hash = NULL WHERE address = ?")
        .bind(target.address).run(),
    ).rejects.toThrow("vault requires password protection");
    await expect(
      env.DB.prepare("UPDATE sites SET expires_at = NULL WHERE address = ?")
        .bind(target.address).run(),
    ).rejects.toThrow("site expiry exceeds vault maximum TTL");
  });

  it("does not silently change existing sites when tightening a vault policy", async () => {
    await createVault({ maxTtl: null, requirePassword: false, defaultPassword: null });
    const created = await (await publish(undefined, { ttl: 30 })).json<{ address: string }>();
    const protection = await api("vaults/reviews", { requirePassword: true }, "PATCH");
    expect(protection.status).toBe(409);
    expect(await protection.text()).toContain("protect existing sites");
    const retention = await api("vaults/reviews", { maxTtl: 14 }, "PATCH");
    expect(retention.status).toBe(409);
    expect(await retention.text()).toContain("shorten existing site expiry");
    expect(
      (await api(`sites/${created.address}`, { password: "site-password", ttl: 7 }, "PATCH"))
        .status,
    ).toBe(200);
    const tightened = await api("vaults/reviews", { requirePassword: true, maxTtl: 14 }, "PATCH");
    expect(tightened.status).toBe(200);
    expect(await tightened.json()).toMatchObject({ requirePassword: true, maxTtl: 14 });
  });

  it("rotates defaults only for new sites and refuses unprotected creation without a default", async () => {
    await createVault();
    const first = await (await publish()).json<{ address: string }>();
    const rotated = await api("vaults/reviews", { defaultPassword: "next-password" }, "PATCH");
    expect(rotated.status).toBe(200);
    const second = await (await publish()).json<{ address: string }>();
    const hashFor = (address: string) =>
      env.DB.prepare("SELECT password_hash FROM sites WHERE address = ?")
        .bind(parseInt(address, 16)).first<{ password_hash: string }>();
    expect(await verifyPassword("review-password", (await hashFor(first.address))!.password_hash))
      .toBe(true);
    expect(await verifyPassword("next-password", (await hashFor(second.address))!.password_hash))
      .toBe(true);
    expect((await api("vaults/reviews", { defaultPassword: null }, "PATCH")).status).toBe(200);
    expect((await publish()).status).toBe(400);
    expect((await publish(undefined, { password: "explicit-password" })).status).toBe(200);
    expect((await publish({ address: parseInt(first.address, 16) })).status).toBe(200);
    expect(await verifyPassword("review-password", (await hashFor(first.address))!.password_hash))
      .toBe(true);
  });

  it("rejects contradictory retention defaults and malformed security policy", async () => {
    for (
      const policy of [
        { defaultTtl: "forever", maxTtl: 7 },
        { defaultTtl: 30, maxTtl: 7 },
        { maxTtl: 0 },
        { requirePassword: "yes" },
        { defaultPassword: "x" },
      ]
    ) {
      const response = await api("vaults", { name: "invalid-policy", ...policy });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
  });
});
