import {
  createExecutionContext,
  env,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { hashPassword, verifyPassword } from "../src/password.ts";

describe("Worker runtime", () => {
  it("serves the landing page with public cache headers", async () => {
    const response = await SELF.fetch("https://share.demo.dev/");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "no-store",
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(await response.text()).toContain("nzip");
  });

  it("rejects unknown wildcard hosts without exposing the control plane", async () => {
    const invalid = await SELF.fetch("https://attacker.demo.dev/api/status", {
      headers: { authorization: "Bearer runtime-test-token" },
    });
    const validArtifactHost = await SELF.fetch(
      "https://0123.demo.dev/api/status",
      { headers: { authorization: "Bearer runtime-test-token" } },
    );

    expect(invalid.status).toBe(404);
    expect(validArtifactHost.status).toBe(404);
    expect(await invalid.json()).toEqual({ error: "not found" });
  });

  it("keeps the root shell claim-independent and hides pairing by default", async () => {
    const response = await SELF.fetch("https://share.demo.dev/");
    const html = await response.text();

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(html).not.toContain('id="pair"');
    expect(html).toContain("maximum-scale=1, user-scalable=no");
    expect(html).not.toContain('<link rel="manifest"');
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM notification_devices",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("rejects enrollment until the owner opens a pairing window", async () => {
    const browserHeaders = {
      origin: "https://share.demo.dev",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    const status = await SELF.fetch("https://share.demo.dev/_notify/pairing", {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ enabled: false, expiresAt: null });

    const enrolled = await SELF.fetch(
      "https://share.demo.dev/_notify/enrollments",
      { method: "POST", headers: browserHeaders, body: "{}" },
    );
    expect(enrolled.status).toBe(404);
    expect(await enrolled.json()).toEqual({ error: "pairing unavailable" });

    const crossOrigin = await SELF.fetch(
      "https://share.demo.dev/_notify/pairing",
      {
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      },
    );
    expect(crossOrigin.status).toBe(403);

    await SELF.fetch("https://share.demo.dev/api/notify/pairing", {
      method: "POST",
      headers: {
        authorization: "Bearer runtime-test-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    await env.DB.prepare(
      "UPDATE notification_pairing_window SET enabled_until = 0 WHERE id = 1",
    ).run();
    const expired = await SELF.fetch(
      "https://share.demo.dev/_notify/enrollments",
      { method: "POST", headers: browserHeaders, body: "{}" },
    );
    expect(expired.status).toBe(404);
  });

  it("enrolls, previews, approves, and activates while delivery is disabled", async () => {
    const browserHeaders = {
      origin: "https://share.demo.dev",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "user-agent": "runtime mobile browser",
    };
    const ownerHeaders = {
      authorization: "Bearer runtime-test-token",
      "content-type": "application/json",
    };
    const opened = await SELF.fetch(
      "https://share.demo.dev/api/notify/pairing",
      { method: "POST", headers: ownerHeaders, body: "{}" },
    );
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ enabled: true });
    const pairing = await SELF.fetch("https://share.demo.dev/_notify/pairing", {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(await pairing.json()).toMatchObject({ enabled: true });

    const enrolled = await SELF.fetch(
      "https://share.demo.dev/_notify/enrollments",
      { method: "POST", headers: browserHeaders, body: "{}" },
    );
    expect(enrolled.status).toBe(201);
    expect(enrolled.headers.get("cache-control")).toBe("no-store");
    expect(enrolled.headers.get("vary")).toBe("Cookie");
    const cookie = enrolled.headers.get("set-cookie")?.split(";", 1)[0];
    const enrollment = await enrolled.json<{ code: string }>();
    expect(cookie).toMatch(/^__Host-nzip-notify=/);
    expect(enrollment.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);

    const preview = await SELF.fetch(
      `https://share.demo.dev/api/notify/approvals/${enrollment.code}`,
      { headers: ownerHeaders },
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      userAgentSummary: "runtime mobile browser",
      deviceClass: "mobile",
    });

    const approved = await SELF.fetch(
      "https://share.demo.dev/api/notify/approvals",
      {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ code: enrollment.code, name: "runtime device" }),
      },
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      name: "runtime device",
      status: "approved",
    });

    const activated = await SELF.fetch(
      "https://share.demo.dev/_notify/enrollments/activate",
      {
        method: "POST",
        headers: { ...browserHeaders, cookie: cookie! },
        body: "{}",
      },
    );
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      paired: true,
      notifications: "off",
    });

    const disabledSend = await SELF.fetch(
      "https://share.demo.dev/api/notify",
      {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ body: "runtime test" }),
      },
    );
    expect(disabledSend.status).toBe(503);
  });

  it("serves install assets with explicit content and cache policies", async () => {
    const manifest = await SELF.fetch(
      "https://share.demo.dev/_notify/app.webmanifest",
    );
    const serviceWorker = await SELF.fetch(
      "https://share.demo.dev/_notify/sw.js",
    );
    const icon = await SELF.fetch("https://share.demo.dev/_notify/icon.svg");

    expect(manifest.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    expect(serviceWorker.headers.get("content-type")).toContain(
      "text/javascript",
    );
    expect(serviceWorker.headers.get("cache-control")).toBe("no-cache");
    expect(serviceWorker.headers.get("service-worker-allowed")).toBe("/");
    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("rejects unauthenticated API requests before touching storage", async () => {
    const response = await SELF.fetch("https://share.demo.dev/api/status");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("applies the complete D1 migration set", async () => {
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'security_incidents'",
    ).first<{ name: string }>();

    expect(table?.name).toBe("security_incidents");
  });

  it("routes authenticated status requests with the shared release version", async () => {
    const response = await SELF.fetch("https://share.demo.dev/api/status", {
      headers: { authorization: "Bearer runtime-test-token" },
    });

    expect(response.status).toBe(200);
    expect((await response.json<{ version: string }>()).version).toBe("0.8.0");
  });

  it("preserves TTL and password settings when repushing without policy flags", async () => {
    const address = 0xeffe;
    const expiresAt = Math.floor(Date.now() / 1000) + 90 * 86_400;
    const emptyHash =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const oldManifest = "a".repeat(64);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO vaults (slot, name, created_at) VALUES (?, ?, ?)",
      ).bind(14, "repush-policy", Math.floor(Date.now() / 1000)),
      env.DB.prepare(
        `INSERT INTO sites
         (address, vault_slot, alias, current_manifest, created_at, updated_at, expires_at, password_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        address,
        14,
        "keep-settings",
        oldManifest,
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
        expiresAt,
        "existing-password-hash",
      ),
    ]);
    await env.CONTENT.put(`blob/${emptyHash}`, new Uint8Array());

    const response = await SELF.fetch(
      "https://share.demo.dev/api/push/commit",
      {
        method: "POST",
        headers: {
          authorization: "Bearer runtime-test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          manifest: {
            v: 1,
            files: {
              "index.html": {
                h: emptyHash,
                s: 0,
                ct: "text/html; charset=utf-8",
              },
            },
          },
          target: { address },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      address: "effe",
      url: "https://effe.demo.dev/",
      expiresAt,
      protected: true,
    });

    const legacy = await SELF.fetch("https://share.demo.dev/effe/index.html", {
      redirect: "manual",
    });
    expect(legacy.status).toBe(308);
    expect(legacy.headers.get("location")).toBe(
      "https://effe.demo.dev/index.html",
    );

    const isolated = await SELF.fetch("https://effe.demo.dev/", {
      headers: { cookie: "nzip_aeffe=not-a-valid-unlock" },
    });
    expect(isolated.status).toBe(401);
    expect(isolated.headers.get("cloudflare-cdn-cache-control")).toBe(
      "no-store",
    );
    expect(isolated.headers.get("permissions-policy")).toBeNull();
    expect(isolated.headers.get("origin-agent-cluster")).toBe("?1");
    const stored = await env.DB.prepare(
      "SELECT expires_at, password_hash FROM sites WHERE address = ?",
    ).bind(address).first<
      { expires_at: number | null; password_hash: string | null }
    >();
    expect(stored).toEqual({
      expires_at: expiresAt,
      password_hash: "existing-password-hash",
    });
  });

  it("creates, lists, renames, and redescribes vaults", async () => {
    const headers = {
      authorization: "Bearer runtime-test-token",
      "content-type": "application/json",
    };
    const created = await SELF.fetch("https://share.demo.dev/api/vaults", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "agent-work",
        description: "Scratch space for agent-generated review artifacts",
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: "agent-work",
      description: "Scratch space for agent-generated review artifacts",
      siteCount: 0,
    });

    const updated = await SELF.fetch(
      "https://share.demo.dev/api/vaults/agent-work",
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          name: "reviews",
          description: "Human review links; safe to share with collaborators",
        }),
      },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      name: "reviews",
      description: "Human review links; safe to share with collaborators",
    });

    const listed = await SELF.fetch("https://share.demo.dev/api/vaults", {
      headers,
    });
    expect(await listed.json()).toContainEqual(expect.objectContaining({
      name: "reviews",
      description: "Human review links; safe to share with collaborators",
    }));

    const cleared = await SELF.fetch(
      "https://share.demo.dev/api/vaults/reviews",
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ description: "" }),
      },
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      name: "reviews",
      description: null,
    });

    const clearedWithNull = await SELF.fetch(
      "https://share.demo.dev/api/vaults/reviews",
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ description: null }),
      },
    );
    expect(clearedWithNull.status).toBe(200);
    expect(await clearedWithNull.json()).toMatchObject({
      name: "reviews",
      description: null,
    });

    const multiline = await SELF.fetch(
      "https://share.demo.dev/api/vaults/reviews",
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ description: "line1\nline2" }),
      },
    );
    expect(multiline.status).toBe(400);

    const badEncoding = await SELF.fetch(
      "https://share.demo.dev/api/vaults/%zz",
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ description: "x" }),
      },
    );
    expect(badEncoding.status).toBe(400);
  });

  it("evaluates a real D1 probe window through the scheduled handler", async () => {
    const now = Math.floor(Date.now() / 300_000) * 300;
    const bucket = now - 300;
    await env.DB.batch(
      Array.from({ length: 20 }, (_, address) =>
        env.DB.prepare(
          `INSERT INTO security_probes
           (bucket, scanner_id, address, vault_slot, is_live, country, asn)
           VALUES (?, 'runtime-scanner', ?, 0, 0, 'US', 64500)`,
        ).bind(bucket, address)),
    );
    const ctx = createExecutionContext();

    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const incident = await env.DB.prepare(
      "SELECT status, severity FROM security_incidents WHERE name = 'enumeration'",
    ).first<{ status: string; severity: number }>();
    const notification = await env.DB.prepare(
      "SELECT attempts, sent_at FROM security_notifications WHERE action = 'open'",
    ).first<{ attempts: number; sent_at: number | null }>();
    expect(incident).toMatchObject({ status: "open", severity: 1 });
    expect(notification?.attempts).toBe(1);
    expect(notification?.sent_at).not.toBeNull();
  });

  it("runs password hashing and verification inside workerd", async () => {
    const started = performance.now();
    const encoded = await hashPassword("runtime-password");
    const elapsedMs = performance.now() - started;

    expect(await verifyPassword("runtime-password", encoded)).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
    console.log({ event: "test.pbkdf2_runtime", elapsedMs });
  });
});
