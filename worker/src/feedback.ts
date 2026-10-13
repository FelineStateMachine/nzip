// Visitor feedback: opt-in, password-gated notes that a page saves to its own origin and the
// owner reads through the bearer API. Visitor text is untrusted data end to end.
import {
  FEEDBACK_ITEM_PATTERN,
  type FeedbackItem,
  type FeedbackRequestResponse,
  formatAddress,
  MAX_FEEDBACK_ITEMS,
  MAX_FEEDBACK_TEXT,
  type SiteFeedback,
} from "../../shared/mod.ts";
import { ApiError } from "./api/errors.ts";
import type { SiteRow } from "./db.ts";
import { type Env, json, siteUrl } from "./env.ts";
import { queueNotification, validateNotifyRequest } from "./notify.ts";
import { verifyPassword } from "./password.ts";

const MAX_FEEDBACK_BODY_BYTES = 64 * 1024;
const MAX_ITEMS_PER_SAVE = 100;

/** Feedback is only ever served behind a password gate; reject any policy that would expose it. */
export function enforceFeedbackPolicy(feedback: boolean, passwordHash: string | null): void {
  if (feedback && passwordHash === null) {
    throw new ApiError(
      400,
      "feedback requires password protection; set a password, or disable feedback first",
    );
  }
}

/**
 * Whether a write should forget stored notes: the audience changed (a different password, or
 * protection added or removed) or feedback is being switched back on. Re-sending the same
 * password, as some wrappers do on every push, keeps the notes.
 */
export async function feedbackNeedsReset(
  site: SiteRow,
  password: string | null | undefined,
  feedback: boolean | undefined,
): Promise<boolean> {
  if (feedback === true && site.feedback !== 1) return true;
  if (password === undefined) return false;
  if (password === null || site.password_hash === null) {
    return password !== null || site.password_hash !== null;
  }
  return !(await verifyPassword(password, site.password_hash));
}

function feedbackOpen(site: SiteRow): boolean {
  return site.feedback === 1 && site.password_hash !== null;
}

async function currentSeq(env: Env, address: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS seq FROM pushes WHERE address = ?",
  ).bind(address).first<{ seq: number }>();
  return row?.seq ?? 0;
}

async function listFeedback(env: Env, address: number): Promise<FeedbackItem[]> {
  const rows = await env.DB.prepare(
    `SELECT item, text, seq, updated_at FROM site_feedback
     WHERE address = ? ORDER BY updated_at, item`,
  ).bind(address).all<{ item: string; text: string; seq: number; updated_at: number }>();
  return rows.results.map((row) => ({
    item: row.item,
    text: row.text,
    seq: row.seq,
    updatedAt: row.updated_at,
  }));
}

async function feedbackState(env: Env, site: SiteRow): Promise<SiteFeedback> {
  const address = formatAddress(site.address);
  return {
    address,
    url: siteUrl(env, address),
    enabled: feedbackOpen(site),
    seq: await currentSeq(env, site.address),
    requestedAt: site.feedback_requested_at,
    submittedAt: site.feedback_submitted_at,
    items: await listFeedback(env, site.address),
  };
}

/** `GET /api/sites/{target}/feedback` */
export async function handleFeedbackGet(env: Env, site: SiteRow): Promise<Response> {
  return json(await feedbackState(env, site));
}

/** `POST /api/sites/{target}/feedback/request`: open a review round and notify the owner. */
export async function handleFeedbackRequest(
  request: Request,
  env: Env,
  site: SiteRow,
  ctx: ExecutionContext,
): Promise<Response> {
  const text = await request.text();
  let body: Record<string, unknown> = {};
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(400, "invalid JSON body");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "request body must be an object");
    }
    if (Object.keys(body).some((key) => key !== "message")) {
      throw new ApiError(400, "request contains unknown fields");
    }
  }
  if (!feedbackOpen(site)) {
    throw new ApiError(
      409,
      "feedback is not enabled for this site; publish or update it with feedback enabled",
    );
  }
  const address = formatAddress(site.address);
  // Validate the notification before changing state so a bad message leaves the round untouched.
  const notification = validateNotifyRequest({
    title: "Feedback requested",
    body: body.message ?? "A page is ready for your review",
    path: `/${address}`,
    tag: `feedback-${address}`,
  });
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE sites SET feedback_requested_at = ?, feedback_submitted_at = NULL
     WHERE address = ?`,
  ).bind(now, site.address).run();
  const queued = env.NOTIFY_ENABLED === "true"
    ? await queueNotification(env, ctx, notification)
    : null;
  const state = await feedbackState(env, {
    ...site,
    feedback_requested_at: now,
    feedback_submitted_at: null,
  });
  return json<FeedbackRequestResponse>({ ...state, notification: queued });
}

function visitorJson(body: unknown, status = 200): Response {
  return json(body, status, {
    "cache-control": "no-store",
    "origin-agent-cluster": "?1",
    "x-content-type-options": "nosniff",
  });
}

async function visitorState(env: Env, site: SiteRow) {
  const state = await feedbackState(env, site);
  return {
    ok: true,
    seq: state.seq,
    requestedAt: state.requestedAt,
    submittedAt: state.submittedAt,
    items: Object.fromEntries(
      state.items.map((item) => [item.item, {
        text: item.text,
        seq: item.seq,
        updatedAt: item.updatedAt,
      }]),
    ),
  };
}

/** Reject cross-site writes even if a browser ever attached the Lax unlock cookie. */
function sameOriginWrite(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== url.origin) return false;
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return false;
  return req.headers.get("content-type")?.split(";", 1)[0].trim() === "application/json";
}

function parseSave(raw: unknown): { items: Map<string, string>; submit: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "request body must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "items" && key !== "submit")) {
    throw new ApiError(400, "request contains unknown fields");
  }
  if (record.submit !== undefined && typeof record.submit !== "boolean") {
    throw new ApiError(400, "submit must be a boolean");
  }
  const items = new Map<string, string>();
  if (record.items !== undefined) {
    if (!record.items || typeof record.items !== "object" || Array.isArray(record.items)) {
      throw new ApiError(400, "items must map item keys to text");
    }
    const entries = Object.entries(record.items as Record<string, unknown>);
    if (entries.length > MAX_ITEMS_PER_SAVE) {
      throw new ApiError(400, `at most ${MAX_ITEMS_PER_SAVE} items per save`);
    }
    for (const [item, text] of entries) {
      if (!FEEDBACK_ITEM_PATTERN.test(item)) throw new ApiError(400, `invalid item key: ${item}`);
      if (typeof text !== "string") throw new ApiError(400, `item ${item} must be text`);
      if ([...text].length > MAX_FEEDBACK_TEXT) {
        throw new ApiError(400, `item ${item} exceeds ${MAX_FEEDBACK_TEXT} characters`);
      }
      items.set(item, text);
    }
  }
  return { items, submit: record.submit === true };
}

async function saveFeedback(
  req: Request,
  env: Env,
  site: SiteRow,
): Promise<void> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FEEDBACK_BODY_BYTES) {
    throw new ApiError(413, "request too large");
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_FEEDBACK_BODY_BYTES) {
    throw new ApiError(413, "request too large");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid JSON body");
  }
  const { items, submit } = parseSave(raw);

  const existing = await env.DB.prepare("SELECT item FROM site_feedback WHERE address = ?")
    .bind(site.address).all<{ item: string }>();
  const kept = new Set(existing.results.map((row) => row.item));
  for (const [item, value] of items) {
    if (value.trim() === "") kept.delete(item);
    else kept.add(item);
  }
  if (kept.size > MAX_FEEDBACK_ITEMS) {
    throw new ApiError(400, `a site keeps at most ${MAX_FEEDBACK_ITEMS} feedback items`);
  }

  const now = Math.floor(Date.now() / 1000);
  const seq = await currentSeq(env, site.address);
  // Deletes first, so clearing a note frees room for a new one in the same save.
  const ordered = [...items].sort(([, a], [, b]) =>
    Number(a.trim() !== "") - Number(b.trim() !== "")
  );
  const statements = ordered.map(([item, value]) =>
    value.trim() === ""
      ? env.DB.prepare("DELETE FROM site_feedback WHERE address = ? AND item = ?")
        .bind(site.address, item)
      : env.DB.prepare(
        `INSERT INTO site_feedback (address, item, text, seq, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(address, item) DO UPDATE SET
           text = excluded.text, seq = excluded.seq, updated_at = excluded.updated_at`,
      ).bind(site.address, item, value, seq, now)
  );
  if (submit) {
    statements.push(
      env.DB.prepare("UPDATE sites SET feedback_submitted_at = ? WHERE address = ?")
        .bind(now, site.address),
    );
  }
  if (statements.length === 0) return;
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // The cap trigger catches saves that raced past the check above.
    if (String(error).includes("feedback item limit reached")) {
      throw new ApiError(400, `a site keeps at most ${MAX_FEEDBACK_ITEMS} feedback items`);
    }
    throw error;
  }
}

/**
 * Serve the reserved `/__feedback` routes on an unlocked site origin, or return null for any
 * other path. The caller has already applied the password gate.
 */
export async function serveSiteFeedback(
  req: Request,
  env: Env,
  url: URL,
  site: SiteRow,
): Promise<Response | null> {
  if (url.pathname === "/__feedback.js") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return visitorJson({ error: "method not allowed" }, 405);
    }
    return new Response(req.method === "HEAD" ? null : FEEDBACK_SCRIPT, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": site.password_hash ? "private, no-store" : "public, max-age=300",
        "origin-agent-cluster": "?1",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (url.pathname !== "/__feedback") return null;
  if (!feedbackOpen(site)) {
    return visitorJson({ error: "feedback is not enabled for this site" }, 404);
  }
  try {
    if (req.method === "GET" || req.method === "HEAD") {
      return visitorJson(await visitorState(env, site));
    }
    if (req.method !== "POST") return visitorJson({ error: "method not allowed" }, 405);
    if (!sameOriginWrite(req, url)) {
      return visitorJson({ error: "feedback must be sent as same-origin JSON" }, 403);
    }
    await saveFeedback(req, env, site);
    const fresh = await env.DB.prepare("SELECT * FROM sites WHERE address = ?")
      .bind(site.address).first<SiteRow>();
    return visitorJson(await visitorState(env, fresh ?? site));
  } catch (error) {
    if (error instanceof ApiError) return visitorJson({ error: error.message }, error.status);
    throw error;
  }
}

/**
 * Page helper served at `/__feedback.js`. Pages mark fields with `data-nzip-feedback="<item>"`,
 * an optional `data-nzip-feedback-submit` button, and an optional `data-nzip-feedback-status`
 * element. Notes autosave, restore on reload, and notes from an earlier review round appear as
 * placeholders. Custom UIs can use `window.nzipFeedback` and the `nzip-feedback` event.
 * Kept free of backticks and dollar-brace sequences so it can live in this template literal.
 */
export const FEEDBACK_SCRIPT = `(() => {
  "use strict";
  var ENDPOINT = "/__feedback";
  var DELAY = 1200;
  var KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
  var MAX_TEXT = 4000;
  var pending = {};
  var timer = 0;
  var state = null;
  var off = false;
  var has = Object.prototype.hasOwnProperty;

  function all(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }
  function fields() { return all("[data-nzip-feedback]"); }
  function keyOf(el) { return el.getAttribute("data-nzip-feedback"); }
  function status(text, kind) {
    all("[data-nzip-feedback-status]").forEach(function (el) {
      el.textContent = text;
      el.setAttribute("data-state", kind || "");
    });
  }
  function emit() {
    document.dispatchEvent(new CustomEvent("nzip-feedback", { detail: state }));
  }
  function note(key) {
    return state && state.items && has.call(state.items, key) ? state.items[key] : null;
  }
  function valueOf(key) {
    var group = fields().filter(function (el) { return keyOf(el) === key; });
    for (var i = 0; i < group.length; i++) {
      var el = group[i];
      if (el.type === "radio") { if (el.checked) return el.value; continue; }
      if (el.type === "checkbox") return el.checked ? (el.value || "yes") : "";
      return "value" in el ? el.value : el.textContent;
    }
    return "";
  }
  function current(item) {
    return item && (!state.requestedAt || item.updatedAt >= state.requestedAt);
  }
  function fill() {
    fields().forEach(function (el) {
      var key = keyOf(el);
      if (has.call(pending, key)) return; // keep what the reviewer typed while loading
      var item = note(key);
      var text = current(item) ? item.text : "";
      if (el.type === "radio") el.checked = text !== "" && el.value === text;
      else if (el.type === "checkbox") el.checked = text !== "";
      else if ("value" in el) {
        el.value = text;
        if (item && !current(item) && "placeholder" in el) el.placeholder = "Earlier note: " + item.text;
      }
    });
  }
  function call(body, keepalive) {
    var init = { credentials: "same-origin", cache: "no-store" };
    if (body) {
      init.method = "POST";
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
      init.keepalive = !!keepalive;
    }
    return fetch(ENDPOINT, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 404) { off = true; throw new Error("Feedback is off for this page"); }
        if (!res.ok) {
          var error = new Error(data.error || "Could not save feedback");
          error.retry = res.status === 429 || res.status >= 500;
          throw error;
        }
        state = data;
        emit();
        return data;
      });
    }, function (error) {
      error.retry = true; // network failure
      throw error;
    });
  }
  function flush(submit, keepalive) {
    clearTimeout(timer);
    var items = pending;
    pending = {};
    if (!submit && !Object.keys(items).length) return Promise.resolve(state);
    status(submit ? "Sending..." : "Saving...", "busy");
    return call({ items: items, submit: !!submit }, keepalive).then(function (data) {
      status(submit ? "Feedback sent" : "Saved", submit ? "sent" : "saved");
      return data;
    }, function (error) {
      // Only transient failures are retried; a rejected save must not block later ones.
      if (error.retry) {
        Object.keys(items).forEach(function (key) { if (!has.call(pending, key)) pending[key] = items[key]; });
      }
      status(error.message, "error");
      throw error;
    });
  }
  function save(key, text) {
    if (off) return false;
    if (!KEY.test(key || "")) {
      console.warn("nzip feedback: skipping invalid item key", key);
      return false;
    }
    if (Array.from(text).length > MAX_TEXT) {
      status("Notes are limited to " + MAX_TEXT + " characters", "error");
      return false;
    }
    pending[key] = text;
    status("Unsaved changes", "dirty");
    clearTimeout(timer);
    timer = setTimeout(function () { flush(false).catch(function () {}); }, DELAY);
    return true;
  }
  function onInput(event) {
    var el = event.target && event.target.closest && event.target.closest("[data-nzip-feedback]");
    if (el) save(keyOf(el), valueOf(keyOf(el)));
  }
  function submit() {
    if (off) return Promise.reject(new Error("Feedback is off for this page"));
    return flush(true); // pending edits plus the submit mark; saved notes stay as they are
  }

  var ready = call(null).then(function (data) {
    fill();
    // A feedback request clears submittedAt, so any value here belongs to the current round.
    status(data.submittedAt ? "Feedback sent" : "", data.submittedAt ? "sent" : "");
    return data;
  }, function (error) {
    off = true;
    var local = location.protocol === "file:" || error.retry;
    status(local ? "Feedback saves once this page is published on nzip" : error.message, "off");
    all("[data-nzip-feedback-submit]").forEach(function (el) { el.disabled = true; });
    return null;
  });

  document.addEventListener("input", onInput);
  document.addEventListener("change", onInput);
  document.addEventListener("click", function (event) {
    var button = event.target && event.target.closest && event.target.closest("[data-nzip-feedback-submit]");
    if (!button) return;
    event.preventDefault();
    submit().catch(function () {});
  });
  addEventListener("pagehide", function () {
    if (!off && Object.keys(pending).length) flush(false, true).catch(function () {});
  });

  window.nzipFeedback = {
    ready: ready,
    save: function (key, text) { return save(key, text) ? flush(false) : Promise.reject(new Error("Not saved")); },
    submit: submit,
    get state() { return state; },
  };
})();
`;
