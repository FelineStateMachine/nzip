import type { NotifyEnv } from "./notify_enrollment.ts";

const APP_MANIFEST = JSON.stringify({
  id: "/",
  name: "nzip",
  short_name: "nzip",
  description: "Personal nzip notifications",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#1e1810",
  theme_color: "#1e1810",
  icons: [{
    src: "/_notify/icon.svg",
    sizes: "any",
    type: "image/svg+xml",
    purpose: "any",
  }],
});

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="96" fill="#1e1810"/>
<text x="256" y="310" text-anchor="middle" font-family="ui-monospace,monospace" font-size="190" font-weight="700" fill="#f2e8d4">n<tspan fill="#ff6b4a">z</tspan>ip</text>
</svg>`;

const SERVICE_WORKER = String.raw`self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) {}
  const title = typeof payload.title === "string" ? payload.title : "nzip";
  const body = typeof payload.body === "string" ? payload.body : "Notification received";
  const options = {
    body,
    tag: typeof payload.tag === "string" ? payload.tag : undefined,
    icon: "/_notify/icon.svg",
    badge: "/_notify/icon.svg",
    data: {
      eventId: typeof payload.eventId === "string" ? payload.eventId : null,
      hasPath: typeof payload.path === "string"
    }
  };
  const visible = self.registration.showNotification(title, options);
  const renew = fetch("/_notify/enrollments/renew", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}"
  }).catch(() => undefined);
  event.waitUntil(Promise.all([visible, renew]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    let path = "/";
    const data = event.notification.data || {};
    if (data.hasPath && data.eventId) {
      try {
        const response = await fetch("/_notify/click-target", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ eventId: data.eventId })
        });
        if (response.ok) {
          const result = await response.json();
          if (typeof result.path === "string" && result.path.startsWith("/")) path = result.path;
          else path = "/?notify=link-expired";
        } else path = "/?notify=link-expired";
      } catch (_) { path = "/?notify=link-expired"; }
    }
    const absolute = new URL(path, self.location.origin).href;
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url === absolute && "focus" in client) return client.focus();
    }
    return clients.openWindow(path);
  })());
});`;

const APP_SCRIPT = String.raw`(() => {
  const footer = document.querySelector("footer");
  const status = document.getElementById("notify-status");
  const pair = document.getElementById("pair");
  const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let state = "unpaired";
  let polling = 0;
  let operation = false;

  const api = async (path, options = {}) => {
    const response = await fetch(path, { credentials: "same-origin", ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "request failed");
    return data;
  };
  const post = (path, body = {}) => api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const setStatus = (text) => { status.textContent = text || ""; };
  const button = (id, text) => {
    const value = document.createElement("button");
    value.id = id;
    value.type = "button";
    value.textContent = text;
    return value;
  };
  const render = (next) => {
    state = next.status || state;
    footer.replaceChildren();
    const args = document.createElement("a");
    args.href = "https://args.io/cat/nzip";
    args.textContent = "args";
    footer.append(args);
    if (state === "unpaired" || state === "pending") {
      footer.append(" · ", button("pair", "pair"));
      document.getElementById("pair").addEventListener("click", beginPairing);
      return;
    }
    if (state === "approved" || state === "active") {
      const paired = document.createElement("span");
      paired.textContent = "paired";
      footer.append(" · ", paired);
      if (isStandalone) {
        const on = state === "active" || next.notifications === "on";
        const toggle = button("notify-toggle", on ? "notifications on" : "notifications off");
        toggle.addEventListener("click", () => toggleNotifications(on));
        footer.append(" · ", toggle);
      }
    }
  };
  const installAssets = async () => {
    if (!document.querySelector('link[rel="manifest"]')) {
      const manifest = document.createElement("link");
      manifest.rel = "manifest";
      manifest.href = "/_notify/app.webmanifest";
      document.head.append(manifest);
    }
    if ("serviceWorker" in navigator) await navigator.serviceWorker.register("/_notify/sw.js", { scope: "/" });
  };
  const platformInstruction = () => {
    if (isStandalone) return setStatus("");
    if (/iPhone|iPad|iPod/.test(navigator.userAgent)) setStatus("share → add to home screen");
    else setStatus("install from your browser menu");
  };
  async function beginPairing() {
    if (operation) return;
    operation = true;
    try {
      const result = await post("/_notify/enrollments");
      sessionStorage.setItem("nzip-pairing-code", result.code);
      setStatus(result.code + "\nwaiting");
      render({ status: "pending" });
      startPolling();
    } catch (error) { setStatus(error.message); }
    finally { operation = false; }
  }
  function startPolling() {
    if (polling) return;
    const started = Date.now();
    const poll = async () => {
      try {
        const current = await api("/_notify/enrollments/current");
        if (current.status === "approved") {
          const active = await post("/_notify/enrollments/activate");
          sessionStorage.removeItem("nzip-pairing-code");
          await installAssets();
          render(active);
          platformInstruction();
          polling = 0;
          return;
        }
        if (current.status === "expired" || current.status === "unpaired") {
          sessionStorage.removeItem("nzip-pairing-code");
          setStatus(current.status === "expired" ? "pairing expired" : "");
          render({ status: "unpaired" });
          polling = 0;
          return;
        }
      } catch (_) { setStatus("waiting · retrying"); }
      const elapsed = Date.now() - started;
      const base = elapsed < 60000 ? 3000 : 10000;
      polling = setTimeout(poll, base + Math.floor(Math.random() * 1000));
    };
    polling = setTimeout(poll, 3000);
  }
  const vapidKey = (value) => {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const raw = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  };
  const sameKey = (left, right) => {
    if (!left) return false;
    const bytes = new Uint8Array(left);
    return bytes.length === right.length && bytes.every((value, index) => value === right[index]);
  };
  const reconcileSubscription = async (current) => {
    const registration = await navigator.serviceWorker.ready;
    const key = await api("/_notify/vapid-public-key");
    const applicationServerKey = vapidKey(key.publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription.options.applicationServerKey, applicationServerKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription && current.status === "active" && Notification.permission === "granted") {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
    }
    if (subscription) return post("/_notify/subscriptions", subscription.toJSON());
    if (current.status === "active") {
      return api("/_notify/subscriptions/current", { method: "DELETE" });
    }
    return current;
  };
  async function toggleNotifications(on) {
    if (operation) return;
    operation = true;
    const prior = on ? "notifications on" : "notifications off";
    const control = document.getElementById("notify-toggle");
    if (control) { control.disabled = true; control.textContent = "notifications …"; }
    try {
      const registration = await navigator.serviceWorker.ready;
      if (on) {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();
        const next = await api("/_notify/subscriptions/current", { method: "DELETE" });
        render(next);
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          render({ status: "approved", notifications: "off" });
          const blocked = document.getElementById("notify-toggle");
          if (blocked) { blocked.textContent = "notifications blocked"; blocked.disabled = true; }
          return;
        }
        const key = await api("/_notify/vapid-public-key");
        const existing = await registration.pushManager.getSubscription();
        const subscription = existing || await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey(key.publicKey)
        });
        const next = await post("/_notify/subscriptions", subscription.toJSON());
        render(next);
      }
    } catch (error) {
      setStatus(error.message);
      const restored = document.getElementById("notify-toggle");
      if (restored) { restored.disabled = false; restored.textContent = prior; }
    } finally { operation = false; }
  }
  (async () => {
    if (new URL(location.href).searchParams.get("notify") === "link-expired") setStatus("link expired");
    try {
      const current = await api("/_notify/enrollments/current");
      if (current.status === "approved" || current.status === "active") {
        await installAssets();
        if (isStandalone) {
          const reconciled = await reconcileSubscription(current);
          render(reconciled);
          post("/_notify/enrollments/renew").catch(() => undefined);
        } else {
          render(current);
          platformInstruction();
        }
      } else if (current.status === "pending") {
        render(current);
        const code = sessionStorage.getItem("nzip-pairing-code");
        setStatus((code ? code + "\n" : "") + "waiting");
        startPolling();
      } else render({ status: "unpaired" });
    } catch (_) { render({ status: "unpaired" }); setStatus("offline"); }
  })();
})();`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]!);
}

/** Claim-independent shell. Safe to cache publicly; all state is fetched client-side. */
export function notifyLandingPage(env: NotifyEnv): string {
  const host = escapeHtml(new URL(env.PUBLIC_BASE).host);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"><meta name="theme-color" content="#1e1810"><title>${host}</title>
<style>*{box-sizing:border-box}body{background:#1e1810;color:#e7dbc5;font-family:ui-monospace,monospace;margin:0;min-height:100dvh;display:flex;flex-direction:column}main{flex:1;display:grid;place-items:center;padding:24px;text-align:center}.landing{display:grid;gap:24px;justify-items:center}.wordmark{color:#f2e8d4;font-size:clamp(40px,10vw,72px);font-weight:700;letter-spacing:-.18em;line-height:.8}.wordmark .z{color:#ff6b4a}#notify-status{color:#8a8172;font-size:12px;line-height:1.6;white-space:pre-line;min-height:3.2em;letter-spacing:.02em}footer{text-align:center;padding:14px 16px calc(14px + env(safe-area-inset-bottom));color:#6b6355;font-size:12px}a,button{color:#6b6355;font:inherit;text-decoration:underline}button{appearance:none;background:none;border:0;padding:0;cursor:pointer}a:hover,button:hover{color:#d99a5b}button:focus-visible,a:focus-visible{outline:2px solid #ffb347;outline-offset:4px}button:disabled{cursor:default;text-decoration:none}</style></head>
<body><main><div class="landing"><div class="wordmark" aria-label="nzip">n<span class="z">z</span>ip</div><div id="notify-status" aria-live="polite"></div></div></main><footer><a href="https://args.io/cat/nzip">args</a> · <button id="pair" type="button">pair</button></footer><script>${APP_SCRIPT}</script></body></html>`;
}

function assetResponse(
  request: Request,
  body: string,
  contentType: string,
  headers: HeadersInit = {},
): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

export function notifyAssetResponse(
  request: Request,
  env: NotifyEnv,
  url: URL,
): Response | null {
  if (url.pathname === "/_notify/vapid-public-key") {
    if (!env.VAPID_PUBLIC_KEY) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    }
    return new Response(
      request.method === "HEAD"
        ? null
        : JSON.stringify({ publicKey: env.VAPID_PUBLIC_KEY }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
  if (url.pathname === "/_notify/app.webmanifest") {
    return assetResponse(
      request,
      APP_MANIFEST,
      "application/manifest+json; charset=utf-8",
    );
  }
  if (url.pathname === "/_notify/sw.js") {
    return assetResponse(
      request,
      SERVICE_WORKER,
      "text/javascript; charset=utf-8",
      {
        "cache-control": "no-cache",
        "service-worker-allowed": "/",
      },
    );
  }
  if (url.pathname === "/_notify/icon.svg") {
    return assetResponse(request, ICON, "image/svg+xml; charset=utf-8", {
      "cache-control": "public, max-age=86400",
    });
  }
  return null;
}
