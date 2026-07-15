import { api } from "./api.ts";
import { checkBearer } from "./auth.ts";
import type { Env } from "./env.ts";
import { err, isControlOrigin, siteAddressFromUrl } from "./env.ts";
import { runGc } from "./gc.ts";
import { logSecurityRequest, recordEnumerationProbe } from "./observability.ts";
import {
  evaluateEnumerationWindow,
  pruneSecurityTelemetry,
  sendDailySecurityDigest,
} from "./security_alerts.ts";
import { serve } from "./serve.ts";
import { handleNotifyPublic } from "./notify_public.ts";
import { drainNotifications, pruneNotifications } from "./notify.ts";

function tooManyRequests(): Response {
  return new Response("rate limited — slow down\n", {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "60",
    },
  });
}

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    const controlOrigin = isControlOrigin(env, url);
    const siteAddress = controlOrigin ? null : siteAddressFromUrl(env, url);
    const finish = (response: Response): Response => {
      ctx.waitUntil(logSecurityRequest(req, env, url, response, siteAddress));
      ctx.waitUntil(
        recordEnumerationProbe(req, env, url, response, siteAddress),
      );
      return response;
    };

    // The wildcard route must never widen the management surface. Only the
    // configured control origin may dispatch API or notification requests.
    if (!controlOrigin && siteAddress === null) {
      return finish(err("not found", 404));
    }

    if (
      controlOrigin &&
      (url.pathname === "/api" || url.pathname.startsWith("/api/"))
    ) {
      if (!checkBearer(req, env)) return finish(err("unauthorized", 401));
      return finish(await api(req, env, url, ctx));
    }

    if (
      controlOrigin &&
      (url.pathname === "/_notify" || url.pathname.startsWith("/_notify/"))
    ) {
      return finish(await handleNotifyPublic(req, env, url));
    }

    const legacyUnlock = controlOrigin && req.method === "POST" &&
      /^\/[0-9a-f]{4}\/__unlock$/.test(url.pathname);
    const siteUnlock = siteAddress !== null && req.method === "POST" &&
      url.pathname === "/__unlock";
    const isUnlock = legacyUnlock || siteUnlock;
    if (req.method !== "GET" && req.method !== "HEAD" && !isUnlock) {
      return finish(err("method not allowed", 405));
    }

    // Guessing defenses. The address space is only 16 bits, so throttle the two
    // enumeration surfaces per client IP. Asset subpaths (/{addr}/...) are left
    // alone — reaching them already requires knowing a live address.
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    if (isUnlock) {
      const address = siteAddress ?? url.pathname.slice(1, 5);
      const { success } = await env.RL_UNLOCK.limit({
        key: `${ip}:${address}`,
      });
      if (!success) return finish(tooManyRequests());
    } else if (
      (controlOrigin && /^\/[0-9a-f]{4}\/?$/.test(url.pathname)) ||
      (siteAddress !== null && url.pathname === "/")
    ) {
      const { success } = await env.RL_ENUM.limit({ key: ip });
      if (!success) return finish(tooManyRequests());
    }

    return finish(await serve(req, env, url, siteAddress ?? undefined));
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (controller.cron === "*/5 * * * *") {
      ctx.waitUntil(evaluateEnumerationWindow(env));
      ctx.waitUntil(drainNotifications(env));
      return;
    }
    ctx.waitUntil(
      Promise.all([
        runGc(env),
        pruneSecurityTelemetry(env),
        pruneNotifications(env),
        sendDailySecurityDigest(env),
      ]).then(([r]) =>
        console.log(
          `gc: ${r.expiredSites} expired sites, ${r.deletedObjects} objects deleted`,
        )
      ),
    );
  },
} satisfies ExportedHandler<Env>;
