import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import webPush from "web-push";
import { validateNotifyRequest } from "../src/notify.ts";
import { buildWebPushRequest, validatePushEndpoint } from "../src/web_push.ts";

const env = {
  PUBLIC_BASE: "https://share.example.com",
  WEB_PUSH_ORIGINS:
    "https://fcm.googleapis.com,https://web.push.apple.com,https://updates.push.services.mozilla.com",
};

describe("notification validation", () => {
  it("accepts bounded Unicode notification content", () => {
    assert.deepEqual(
      validateNotifyRequest({
        title: "Build ✓",
        body: "Ready 🚀",
        path: "/12af",
        tag: "build-main",
      }),
      {
        title: "Build ✓",
        body: "Ready 🚀",
        path: "/12af",
        tag: "build-main",
      },
    );
  });

  it("rejects cross-origin, encoded, and unknown notification fields", () => {
    for (
      const value of [
        { body: "x", path: "https://example.com/" },
        { body: "x", path: "//example.com" },
        { body: "x", path: "/%31%32af" },
        { body: "x", extra: true },
      ]
    ) {
      assert.throws(() => validateNotifyRequest(value));
    }
  });

  it("counts Unicode scalars instead of UTF-16 code units", () => {
    assert.equal(
      validateNotifyRequest({ body: "🚀".repeat(240) }).body.length,
      480,
    );
    assert.throws(() => validateNotifyRequest({ body: "🚀".repeat(241) }));
  });
});

describe("push endpoint policy", () => {
  it("accepts only configured HTTPS provider origins", () => {
    assert.equal(
      validatePushEndpoint(env, "https://fcm.googleapis.com/fcm/send/abc")
        .hostname,
      "fcm.googleapis.com",
    );
    assert.throws(() => validatePushEndpoint(env, "https://example.com/push"));
    assert.throws(() =>
      validatePushEndpoint(env, "http://fcm.googleapis.com/push")
    );
  });

  it("builds an RFC 8291 aes128gcm request", () => {
    const vapid = webPush.generateVAPIDKeys();
    const client = createECDH("prime256v1");
    client.generateKeys();
    const request = buildWebPushRequest({
      ...env,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "https://share.example.com",
    }, {
      endpoint: "https://fcm.googleapis.com/fcm/send/test",
      keys: {
        p256dh: client.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    }, {
      eventId: "00000000-0000-4000-8000-000000000000",
      title: "nzip",
      body: "transport fixture ✓",
    });

    assert.equal(request.headers["Content-Encoding"], "aes128gcm");
    assert.match(request.headers.Authorization, /^vapid /);
    assert.ok(request.body.byteLength > 0);
  });

  it("rejects own-zone, credentialed, IP-literal, and alternate-port endpoints", () => {
    for (
      const endpoint of [
        "https://share.example.com/_notify/reenter",
        "https://user:pass@fcm.googleapis.com/push",
        "https://127.0.0.1/push",
        "https://2130706433/push",
        "https://fcm.googleapis.com:8443/push",
      ]
    ) {
      assert.throws(() => validatePushEndpoint(env, endpoint));
    }
  });
});
