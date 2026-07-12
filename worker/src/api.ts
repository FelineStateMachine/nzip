import type { Env } from "./env.ts";
import { json } from "./env.ts";
import { ApiError, apiErrorResponse } from "./api/errors.ts";
import { handleBlobPut, handleCommit, handlePrepare } from "./api/push.ts";
import { handleSite, handleSiteList } from "./api/sites.ts";
import { handleStatus } from "./api/status.ts";
import { handleVault, handleVaults } from "./api/vaults.ts";
import { sendAlertTest } from "./security_alerts.ts";

/** Authenticated management API router. Route handlers own validation and storage concerns. */
export async function api(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;

  try {
    if (parts[1] === "push" && parts[2] === "prepare" && method === "POST") {
      return await handlePrepare(request, env);
    }
    if (parts[1] === "push" && parts[2] === "commit" && method === "POST") {
      return await handleCommit(request, env, ctx);
    }
    if (parts[1] === "blob" && parts.length === 3 && method === "PUT") {
      return await handleBlobPut(request, env, parts[2]);
    }
    if (parts[1] === "status" && parts.length === 2 && method === "GET") {
      return await handleStatus(env);
    }
    if (
      parts[1] === "security" && parts[2] === "test-alert" && method === "POST"
    ) {
      await sendAlertTest(env);
      return json({ ok: true });
    }
    if (
      parts[1] === "vaults" && parts.length === 2 &&
      (method === "GET" || method === "POST")
    ) {
      return await handleVaults(request, env);
    }
    if (parts[1] === "vaults" && parts.length === 3 && method === "PATCH") {
      return await handleVault(request, env, parts[2]);
    }
    if (parts[1] === "sites" && parts.length === 2 && method === "GET") {
      return await handleSiteList(url, env);
    }
    if (parts[1] === "sites" && parts.length >= 3) {
      return await handleSite(request, env, parts, ctx);
    }
    throw new ApiError(404, "not found");
  } catch (error) {
    return apiErrorResponse(error, request, url);
  }
}
