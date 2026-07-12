import {
  activateEnrollment,
  attachSubscription,
  authorizeNotificationClaim,
  createEnrollment,
  detachSubscription,
  getCurrentEnrollment,
  type NotifyEnv,
  notifyErrorResponse,
  readNotifyJsonObject,
  renewEnrollment,
} from "./notify_enrollment.ts";
import { json } from "./env.ts";
import { validateClickTarget } from "./notify.ts";
import { notifyAssetResponse } from "./notify_ui.ts";

/**
 * Claim-cookie authenticated notification router. This must be called before
 * the ordinary public GET/HEAD gate, and must never sit under `/api/*`.
 */
export async function handleNotifyPublic(
  request: Request,
  env: NotifyEnv,
  url = new URL(request.url),
): Promise<Response> {
  try {
    const method = request.method;
    const path = url.pathname;

    if (method === "GET" || method === "HEAD") {
      const asset = notifyAssetResponse(request, env, url);
      if (asset) return asset;
    }
    if (path === "/_notify/enrollments" && method === "POST") {
      return await createEnrollment(request, env);
    }
    if (path === "/_notify/enrollments/current" && method === "GET") {
      return await getCurrentEnrollment(request, env);
    }
    if (path === "/_notify/enrollments/activate" && method === "POST") {
      return await activateEnrollment(request, env);
    }
    if (path === "/_notify/enrollments/renew" && method === "POST") {
      return await renewEnrollment(request, env);
    }
    if (path === "/_notify/subscriptions" && method === "POST") {
      return await attachSubscription(request, env);
    }
    if (path === "/_notify/subscriptions/current" && method === "DELETE") {
      return await detachSubscription(request, env);
    }
    if (path === "/_notify/click-target" && method === "POST") {
      if (!await authorizeNotificationClaim(request, env)) {
        return json({ error: "pairing unavailable" }, 404, {
          "cache-control": "no-store",
        });
      }
      const body = await readNotifyJsonObject(request);
      if (
        typeof body.eventId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(body.eventId)
      ) {
        return json({ error: "invalid event" }, 400, {
          "cache-control": "no-store",
        });
      }
      const target = await validateClickTarget(env, body.eventId);
      return json(target ? { path: target } : { expired: true }, 200, {
        "cache-control": "no-store",
        "vary": "Cookie",
      });
    }
    return json({ error: "not found" }, 404, { "cache-control": "no-store" });
  } catch (error) {
    return notifyErrorResponse(error);
  }
}
