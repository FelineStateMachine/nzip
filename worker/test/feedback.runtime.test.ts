import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSiteByAddress } from "../src/db.ts";
import { handleFeedbackRequest } from "../src/feedback.ts";

const headers = { authorization: "Bearer runtime-test-token", "content-type": "application/json" };
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const manifest = { v: 1, files: { "index.html": { h: emptyHash, s: 0, ct: "text/html" } } };
const PASSWORD = "review-password";

function api(path: string, body?: unknown, method = "POST") {
  return SELF.fetch(`https://share.demo.dev/api/${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function publish(policy: Record<string, unknown> = {}, target: unknown = { vault: "fb" }) {
  return await api("push/commit", { manifest, target, ...policy });
}

async function protectedSite(): Promise<string> {
  const response = await publish({ password: PASSWORD, feedback: true });
  expect(response.status, await response.clone().text()).toBe(200);
  const site = await response.json<{ address: string; feedback: boolean; protected: boolean }>();
  expect(site).toMatchObject({ feedback: true, protected: true });
  return site.address;
}

async function unlock(address: string): Promise<string> {
  const body = new URLSearchParams({ password: PASSWORD, return_to: "/" }).toString();
  const response = await SELF.fetch(`https://${address}.demo.dev/__unlock`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(body.length),
    },
    body,
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie, `unlock status ${response.status}`).toMatch(/^__Host-nzip-unlock=/);
  return cookie!;
}

function visitor(address: string, cookie: string, init: RequestInit = {}) {
  return SELF.fetch(`https://${address}.demo.dev/__feedback`, {
    ...init,
    headers: { cookie, ...(init.headers ?? {}) },
  });
}

function save(address: string, cookie: string, body: unknown, extra: Record<string, string> = {}) {
  return visitor(address, cookie, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `https://${address}.demo.dev`,
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

describe("Site feedback", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sites WHERE vault_slot = 7"),
      env.DB.prepare("DELETE FROM vaults WHERE slot = 7"),
    ]);
    const vault = await api("vaults", { name: "fb", slot: 7 });
    expect(vault.status, await vault.clone().text()).toBe(201);
    await env.CONTENT.put(`blob/${emptyHash}`, new Uint8Array());
  });

  it("only enables feedback behind a password", async () => {
    expect((await publish({ feedback: true })).status).toBe(400);
    expect((await publish({ feedback: "yes", password: PASSWORD })).status).toBe(400);

    const open = await (await publish()).json<{ address: string; feedback: boolean }>();
    expect(open.feedback).toBe(false);
    expect((await api(`sites/${open.address}`, { feedback: true }, "PATCH")).status).toBe(400);

    const address = await protectedSite();
    expect((await api(`sites/${address}`, { password: null }, "PATCH")).status).toBe(400);
    expect((await publish({ password: null }, { address: parseInt(address, 16) })).status)
      .toBe(400);
    // A revision without feedback flags keeps the setting.
    const revised = await publish({}, { address: parseInt(address, 16) });
    expect(await revised.json()).toMatchObject({ feedback: true, protected: true });
    const disabled = await api(`sites/${address}`, { feedback: false }, "PATCH");
    expect(await disabled.json()).toMatchObject({ feedback: false });
    expect((await api(`sites/${address}`, { password: null }, "PATCH")).status).toBe(200);
  });

  it("keeps the visitor endpoint behind the unlock gate and off unless enabled", async () => {
    const address = await protectedSite();
    expect((await SELF.fetch(`https://${address}.demo.dev/__feedback`)).status).toBe(401);
    const cookie = await unlock(address);
    expect((await visitor(address, cookie)).status).toBe(200);

    const script = await SELF.fetch(`https://${address}.demo.dev/__feedback.js`, {
      headers: { cookie },
    });
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(script.headers.get("cache-control")).toBe("private, no-store");
    expect(await script.text()).toContain("data-nzip-feedback");

    await api(`sites/${address}`, { feedback: false }, "PATCH");
    expect((await visitor(address, cookie)).status).toBe(404);
    expect((await save(address, cookie, { items: { a: "x" } })).status).toBe(404);
  });

  it("saves, restores, deletes, and submits notes from same-origin JSON only", async () => {
    const address = await protectedSite();
    const cookie = await unlock(address);

    expect(
      (await save(address, cookie, { items: { a: "x" } }, {
        origin: "https://evil.example",
      })).status,
    ).toBe(403);
    expect(
      (await save(address, cookie, { items: { a: "x" } }, {
        "sec-fetch-site": "cross-site",
      })).status,
    ).toBe(403);
    const form = await visitor(address, cookie, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: `https://${address}.demo.dev` },
      body: JSON.stringify({ items: { a: "x" } }),
    });
    expect(form.status).toBe(403);
    expect((await save(address, cookie, { items: { "../bad": "x" } })).status).toBe(400);
    expect((await save(address, cookie, { items: { a: 1 } })).status).toBe(400);
    expect((await save(address, cookie, { items: { a: "x".repeat(4001) } })).status).toBe(400);
    expect((await save(address, cookie, { extra: true })).status).toBe(400);

    const saved = await save(address, cookie, {
      items: { intro: "Tighten the opening", "option-2": "Prefer this one" },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const state = await saved.json<{ items: Record<string, { text: string; seq: number }> }>();
    expect(state.items.intro).toMatchObject({ text: "Tighten the opening", seq: 1 });

    await save(address, cookie, { items: { intro: "  " } });
    const restored = await (await visitor(address, cookie)).json<
      { items: Record<string, unknown>; submittedAt: number | null }
    >();
    expect(Object.keys(restored.items)).toEqual(["option-2"]);
    expect(restored.submittedAt).toBeNull();

    const submitted = await save(address, cookie, { items: { outro: "Ship it" }, submit: true });
    expect(await submitted.json()).toMatchObject({ submittedAt: expect.any(Number) });

    const owner = await (await api(`sites/${address}/feedback`, undefined, "GET")).json<
      { enabled: boolean; submittedAt: number; items: { item: string; text: string }[] }
    >();
    expect(owner.enabled).toBe(true);
    expect(owner.submittedAt).toEqual(expect.any(Number));
    expect(owner.items.map((item) => item.item).sort()).toEqual(["option-2", "outro"]);
  });

  it("caps stored items per site", async () => {
    const address = await protectedSite();
    const cookie = await unlock(address);
    for (let batch = 0; batch < 2; batch++) {
      const items = Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`item-${batch}-${i}`, "note"]),
      );
      expect((await save(address, cookie, { items })).status).toBe(200);
    }
    expect((await save(address, cookie, { items: { overflow: "note" } })).status).toBe(400);
    // Clearing one item makes room again.
    expect((await save(address, cookie, { items: { "item-0-0": "", overflow: "note" } })).status)
      .toBe(200);
  });

  it("opens a review round and queues a feedback-request notification", async () => {
    const open = await (await publish({ password: PASSWORD })).json<{ address: string }>();
    expect((await api(`sites/${open.address}/feedback/request`, {})).status).toBe(409);

    const address = await protectedSite();
    const cookie = await unlock(address);
    await save(address, cookie, { items: { intro: "first round" }, submit: true });

    // Notifications are disabled in the test config: the round still opens.
    const response = await api(`sites/${address}/feedback/request`, {});
    expect(response.status, await response.clone().text()).toBe(200);
    const round = await response.json<
      { requestedAt: number; submittedAt: number | null; notification: unknown }
    >();
    expect(round).toMatchObject({ submittedAt: null, notification: null });
    expect(round.requestedAt).toEqual(expect.any(Number));
    expect((await api(`sites/${address}/feedback/request`, { message: "" })).status).toBe(400);
    expect((await api(`sites/${address}/feedback/request`, { other: 1 })).status).toBe(400);

    // With notifications enabled, the request queues a lock-screen-safe event for the site.
    const site = await getSiteByAddress(env, parseInt(address, 16));
    const ctx = createExecutionContext();
    const enabled = await handleFeedbackRequest(
      new Request("https://share.demo.dev/", {
        method: "POST",
        body: JSON.stringify({ message: "Plan v2 is ready" }),
      }),
      { ...env, NOTIFY_ENABLED: "true" },
      site!,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = await enabled.json<{ notification: { eventId: string } }>();
    const event = await env.DB.prepare(
      "SELECT title, body, path, tag FROM notification_events WHERE id = ?",
    ).bind(body.notification.eventId).first();
    expect(event).toEqual({
      title: "Feedback requested",
      body: "Plan v2 is ready",
      path: `/${address}`,
      tag: `feedback-${address}`,
    });
  });

  it("forgets notes when the audience changes but not on a same-password re-push", async () => {
    const address = await protectedSite();
    const target = { address: parseInt(address, 16) };
    const notes =
      async () => (await (await api(`sites/${address}/feedback`, undefined, "GET")).json<
        { items: unknown[]; requestedAt: number | null }
      >());
    let cookie = await unlock(address);
    await save(address, cookie, { items: { intro: "keep me" } });
    await api(`sites/${address}/feedback/request`, {});

    // Wrappers that resend the same password on every push keep the round.
    expect((await publish({ password: PASSWORD }, target)).status).toBe(200);
    expect((await api(`sites/${address}`, { password: PASSWORD }, "PATCH")).status).toBe(200);
    expect((await notes()).items).toHaveLength(1);

    // A different password is a different audience.
    expect((await api(`sites/${address}`, { password: "another-password" }, "PATCH")).status)
      .toBe(200);
    expect(await notes()).toMatchObject({ items: [], requestedAt: null });

    // Turning feedback back on also starts clean.
    await api(`sites/${address}`, { password: PASSWORD }, "PATCH");
    cookie = await unlock(address);
    await save(address, cookie, { items: { intro: "second" } });
    await api(`sites/${address}`, { feedback: false }, "PATCH");
    expect((await publish({ feedback: true }, target)).status).toBe(200);
    expect((await notes()).items).toHaveLength(0);
  });

  it("enforces the password rule and item cap in the database too", async () => {
    const open = await (await publish()).json<{ address: string }>();
    await expect(
      env.DB.prepare("UPDATE sites SET feedback = 1 WHERE address = ?")
        .bind(parseInt(open.address, 16)).run(),
    ).rejects.toThrow(/feedback requires password protection/);

    const address = parseInt(await protectedSite(), 16);
    await env.DB.batch(
      Array.from({ length: 200 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO site_feedback (address, item, text, seq, updated_at) VALUES (?, ?, 'n', 1, 1)",
        ).bind(address, `item-${i}`)),
    );
    await expect(
      env.DB.prepare(
        "INSERT INTO site_feedback (address, item, text, seq, updated_at) VALUES (?, 'x', 'n', 1, 1)",
      ).bind(address).run(),
    ).rejects.toThrow(/feedback item limit reached/);
    // Updating an existing note at the cap still works.
    await env.DB.prepare(
      `INSERT INTO site_feedback (address, item, text, seq, updated_at) VALUES (?, 'item-1', 'u', 1, 2)
       ON CONFLICT(address, item) DO UPDATE SET text = excluded.text`,
    ).bind(address).run();
  });

  it("deletes notes with their site so a reused address starts clean", async () => {
    const address = await protectedSite();
    const cookie = await unlock(address);
    await save(address, cookie, { items: { intro: "note" } });
    expect((await api(`sites/${address}`, undefined, "DELETE")).status).toBe(200);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM site_feedback WHERE address = ?")
      .bind(parseInt(address, 16)).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
