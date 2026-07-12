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
    const response = await SELF.fetch("https://share.example.com/");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await response.text()).toContain("nzip");
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
    expect((await response.json<{ version: string }>()).version).toBe("0.3.1");
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
