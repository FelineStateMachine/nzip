import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { hashPassword, verifyPassword } from "../src/password.ts";

describe("Worker runtime", () => {
  it("serves the landing page with public cache headers", async () => {
    const response = await SELF.fetch("https://share.example.com/");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await response.text()).toContain("nzip");
  });

  it("keeps the root shell claim-independent until pairing is requested", async () => {
    const response = await SELF.fetch("https://share.example.com/");
    const html = await response.text();

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(html).toContain('id="pair"');
    expect(html).toContain("maximum-scale=1, user-scalable=no");
    expect(html).not.toContain('<link rel="manifest"');
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM notification_devices",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("enrolls, previews, approves, and activates while delivery is disabled", async () => {
    const browserHeaders = {
      origin: "https://share.example.com",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "user-agent": "runtime mobile browser",
    };
    const enrolled = await SELF.fetch(
      "https://share.example.com/_notify/enrollments",
      { method: "POST", headers: browserHeaders, body: "{}" },
    );
    expect(enrolled.status).toBe(201);
    expect(enrolled.headers.get("cache-control")).toBe("no-store");
    expect(enrolled.headers.get("vary")).toBe("Cookie");
    const cookie = enrolled.headers.get("set-cookie")?.split(";", 1)[0];
    const enrollment = await enrolled.json<{ code: string }>();
    expect(cookie).toMatch(/^__Host-nzip-notify=/);
    expect(enrollment.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);

    const ownerHeaders = {
      authorization: "Bearer runtime-test-token",
      "content-type": "application/json",
    };
    const preview = await SELF.fetch(
      `https://share.example.com/api/notify/approvals/${enrollment.code}`,
      { headers: ownerHeaders },
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      userAgentSummary: "runtime mobile browser",
      deviceClass: "mobile",
    });

    const approved = await SELF.fetch(
      "https://share.example.com/api/notify/approvals",
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
      "https://share.example.com/_notify/enrollments/activate",
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
      "https://share.example.com/api/notify",
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
      "https://share.example.com/_notify/app.webmanifest",
    );
    const serviceWorker = await SELF.fetch(
      "https://share.example.com/_notify/sw.js",
    );
    const icon = await SELF.fetch("https://share.example.com/_notify/icon.svg");

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
    const response = await SELF.fetch("https://share.example.com/api/status");

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
    const response = await SELF.fetch("https://share.example.com/api/status", {
      headers: { authorization: "Bearer runtime-test-token" },
    });

    expect(response.status).toBe(200);
    expect((await response.json<{ version: string }>()).version).toBe("0.5.0");
  });

  it("creates, lists, renames, and redescribes vaults", async () => {
    const headers = {
      authorization: "Bearer runtime-test-token",
      "content-type": "application/json",
    };
    const created = await SELF.fetch("https://share.example.com/api/vaults", {
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
      "https://share.example.com/api/vaults/agent-work",
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

    const listed = await SELF.fetch("https://share.example.com/api/vaults", { headers });
    expect(await listed.json()).toContainEqual(expect.objectContaining({
      name: "reviews",
      description: "Human review links; safe to share with collaborators",
    }));

    const cleared = await SELF.fetch("https://share.example.com/api/vaults/reviews", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ description: "" }),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ name: "reviews", description: null });

    const clearedWithNull = await SELF.fetch("https://share.example.com/api/vaults/reviews", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ description: null }),
    });
    expect(clearedWithNull.status).toBe(200);
    expect(await clearedWithNull.json()).toMatchObject({ name: "reviews", description: null });

    const multiline = await SELF.fetch("https://share.example.com/api/vaults/reviews", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ description: "line1\nline2" }),
    });
    expect(multiline.status).toBe(400);

    const badEncoding = await SELF.fetch("https://share.example.com/api/vaults/%zz", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ description: "x" }),
    });
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
