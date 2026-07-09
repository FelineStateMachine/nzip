import { api } from "./api.ts";
import { checkBearer } from "./auth.ts";
import type { Env } from "./env.ts";
import { err } from "./env.ts";
import { runGc } from "./gc.ts";
import { serve } from "./serve.ts";

function tooManyRequests(): Response {
  return new Response("rate limited — slow down\n", {
    status: 429,
    headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (!checkBearer(req, env)) return err("unauthorized", 401);
      return await api(req, env, url);
    }

    const isUnlock = req.method === "POST" && /^\/[0-9a-f]{4}\/__unlock$/.test(url.pathname);
    if (req.method !== "GET" && req.method !== "HEAD" && !isUnlock) {
      return err("method not allowed", 405);
    }

    // Guessing defenses. The address space is only 16 bits, so throttle the two
    // enumeration surfaces per client IP. Asset subpaths (/{addr}/...) are left
    // alone — reaching them already requires knowing a live address.
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    if (isUnlock) {
      const address = url.pathname.slice(1, 5);
      const { success } = await env.RL_UNLOCK.limit({ key: `${ip}:${address}` });
      if (!success) return tooManyRequests();
    } else if (/^\/[0-9a-f]{4}\/?$/.test(url.pathname)) {
      const { success } = await env.RL_ENUM.limit({ key: ip });
      if (!success) return tooManyRequests();
    }

    return await serve(req, env, url);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runGc(env).then((r) =>
        console.log(`gc: ${r.expiredSites} expired sites, ${r.deletedObjects} objects deleted`)
      ),
    );
  },
} satisfies ExportedHandler<Env>;
