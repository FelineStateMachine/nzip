import { api } from "./api.ts";
import { checkBearer } from "./auth.ts";
import type { Env } from "./env.ts";
import { err } from "./env.ts";
import { runGc } from "./gc.ts";
import { serve } from "./serve.ts";

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
