# One-time Cloudflare setup

Everything here happens once. Day-to-day content pushes never touch wrangler.

The default architecture targets the Workers Free plan. It requires no paid
Email Sending subscription: alerts use Email Routing to one verified
destination. Free-tier limits are account-wide, so review the
[budget notes](../ARCHITECTURE.md#free-tier-design-target) before exposing a
busy or multi-tenant deployment.

```sh
cd worker

# 1. auth
npx wrangler login

# 2. private Wrangler config
cp wrangler.jsonc wrangler.local.jsonc
# Edit wrangler.local.jsonc now:
# - routes[0].pattern: your control hostname, such as share.demo.dev
# - routes[1]: wildcard route for *.demo.dev/* with zone_name demo.dev
# - vars.PUBLIC_BASE: https://<control hostname>
# - vars.SITE_DOMAIN: the parent used by <address>.<site domain>, such as demo.dev
# - d1_databases[0].database_id: filled in after D1 creation

# 3. storage
npx wrangler r2 bucket create nzip-content
npx wrangler d1 create nzip
#    -> paste the printed database_id into wrangler.local.jsonc

# 4. schema
npx wrangler d1 execute nzip --remote --file schema.sql

# 5. owner token
openssl rand -hex 32                       # keep this — it's your CLI token
npx wrangler secret put NZIP_TOKEN --config wrangler.local.jsonc

# 6. alert destination (click the verification link before deploying)
npx wrangler email routing enable example.com
npx wrangler email routing addresses create operator@example.com
# Edit send_email and ALERT_EMAIL_* in wrangler.local.jsonc as shown below.

# 7. wildcard DNS (Cloudflare DNS dashboard)
#    Create a proxied `*` CNAME pointing to the control hostname.

# 8. first deploy
npx wrangler deploy --config wrangler.local.jsonc
```

## Hostname model

nzip uses two public surfaces:

- `PUBLIC_BASE`, such as `https://share.demo.dev`, is the exact control origin
  for owner APIs, notification enrollment, and legacy `/<address>` links.
- `SITE_DOMAIN`, such as `demo.dev`, produces isolated artifact origins such as
  `https://2a3f.demo.dev/`.

The control path permanently redirects to the artifact hostname; it never serves
artifact bytes. This separation gives every hosted site its own browser storage,
service workers, host-only nzip unlock cookie, and default passkey relying-party
ID. Artifact responses also send `Origin-Agent-Cluster: ?1` so browsers keep
each site in an origin-keyed agent cluster. Do not replace it with the obsolete
`Permissions-Policy: document-domain=()` directive.

New site builds should use `/` as their deployment base; the address is no
longer part of the asset path and no reservation/rebuild/repush cycle is needed.
The Worker includes a compatibility fallback for existing artifacts built with
`/<address>/`: when a prefixed file does not actually exist, it serves the
corresponding root-relative file on the same isolated hostname.

For a Free-plan deployment, use a dedicated Cloudflare zone and keep artifact
hosts one label below the zone apex. Universal SSL covers the apex and
first-level wildcard. The required wildcard Worker route catches every
otherwise-unmatched subdomain in that zone, so do not point it at a zone whose
other subdomains must be served elsewhere unless you also add more-specific
routes.

The relevant config shape is:

```jsonc
"routes": [
  { "pattern": "share.demo.dev", "custom_domain": true },
  { "pattern": "*.demo.dev/*", "zone_name": "demo.dev" }
],
"vars": {
  "PUBLIC_BASE": "https://share.demo.dev",
  "SITE_DOMAIN": "demo.dev"
}
```

Custom Domains do not accept wildcard hostnames. Create a proxied wildcard DNS
record separately, then use a wildcard Worker route. In Cloudflare DNS, add `*`
as a proxied CNAME to the control hostname (or another proxied target in the
zone). Wait for Universal SSL to report an active certificate covering
`*.demo.dev` before treating the deployment as ready.

### Free-plan security rule

The Worker validates hostnames before dispatching any API or artifact request.
As defense in depth, a single Free-plan WAF custom rule can reject malformed
wildcard hosts before they consume a Worker request. For `n.zip`, create a
custom rule named `nzip: reject invalid site hosts`, choose `Block`, and use
this expression:

```text
ends_with(lower(http.host), ".n.zip") and (
  len(http.host) ne 10 or
  not (substring(lower(http.host), 0, 1) in {"0" "1" "2" "3" "4" "5" "6" "7" "8" "9" "a" "b" "c" "d" "e" "f"}) or
  not (substring(lower(http.host), 1, 2) in {"0" "1" "2" "3" "4" "5" "6" "7" "8" "9" "a" "b" "c" "d" "e" "f"}) or
  not (substring(lower(http.host), 2, 3) in {"0" "1" "2" "3" "4" "5" "6" "7" "8" "9" "a" "b" "c" "d" "e" "f"}) or
  not (substring(lower(http.host), 3, 4) in {"0" "1" "2" "3" "4" "5" "6" "7" "8" "9" "a" "b" "c" "d" "e" "f"})
)
```

This avoids the paid `matches` regular-expression operator. Adapt both the
suffix and expected hostname length for other zones. Keep control-plane security
rules explicitly scoped to `http.host eq "n.zip"`; rules intended for all public
traffic should include both the apex and valid site hostnames. The Worker's own
rate-limit bindings remain authoritative for address enumeration and
`POST /__unlock`, so the optional edge rule does not consume the Free plan's
single rate-limit rule.

### Free-plan RUM exclusion

Cloudflare can automatically inject its Real User Monitoring beacon into HTML
on Free-plan zones. Hosted artifacts should remain byte-for-byte static and
should not produce `/cdn-cgi/rum` requests during PWA reloads. Add a
Configuration Rule named `nzip: disable RUM on artifact hosts` with this
expression:

```text
ends_with(lower(http.host), ".n.zip")
```

Set its action to **Disable Real User Monitoring (RUM)**. Adapt the suffix for
other zones. This keeps RUM available on the control origin while disabling it
for every isolated artifact hostname. Use a Configuration Rule for this on the
Free plan; per-host Web Analytics rules are not included there.

Enable `Always Use HTTPS` for the entire zone. Once every wildcard hostname has
a valid certificate, enable HSTS with a real duration; begin without `preload`,
verify the deployment, and only then consider a one-year duration plus preload.
`includeSubDomains` now intentionally covers all isolated site origins.

For passkey applications, use the exact artifact hostname as the RP ID—normally
`location.hostname`. Subdomains can deliberately select their registrable
parent as a WebAuthn RP ID or set cookies for that parent domain, so per-site
origins alone do not isolate those two credential mechanisms. Applications
should use `__Host-` or otherwise host-only cookies and exact-host RP IDs. Before
hosting mutually untrusted applications, register `SITE_DOMAIN` in the
[Public Suffix List](https://publicsuffix.org/submit/) and wait for the change to
reach the browsers in scope. Until then, do not use the parent `SITE_DOMAIN` for
application cookies or passkeys.

## Free security alert email

Enumeration alerts use the Email Routing Worker binding, not the paid Email
Sending product. Email Routing can send to a verified destination on the free
plan. Enable it for the Worker domain, add and verify the operator address, then
set these values in `wrangler.local.jsonc`:

```sh
npx wrangler email routing enable example.com
npx wrangler email routing addresses create operator@example.com
```

Click the verification link Cloudflare sends, then configure:

```jsonc
"send_email": [{ "name": "EMAIL", "destination_address": "operator@example.com" }],
"vars": {
  "ALERT_EMAIL_TO": "operator@example.com",
  "ALERT_EMAIL_FROM": "alerts@share.demo.dev"
}
```

Apply `migrations/0002_security_alerts.sql`,
`migrations/0003_security_notification_outbox.sql`,
`migrations/0004_vault_descriptions.sql`, and
`migrations/0005_notifications.sql` before deploying an upgraded Worker. After
deployment, send a delivery test through the owner-authenticated endpoint:

```sh
curl -X POST -H "Authorization: Bearer $NZIP_TOKEN" \
  https://share.demo.dev/api/security/test-alert
```

The Worker opens an incident when one scanner tries 20 distinct addresses in
five minutes, or a distributed sweep reaches 128 addresses from 10 scanners with
at least 90% misses. A rate-limit hit or a suspicious live-address hit confirms
the incident. Duplicate email is suppressed unless severity increases or volume
doubles, active incidents summarize hourly, and three quiet windows (15 minutes)
resolve the incident. Probe rows are deduplicated by scanner/address, capped at
30 per scanner per minute in each Cloudflare location; 429 confirmations have a
separate one-per-minute persistence cap. Alert payloads are written to a D1
outbox before delivery and retried by later cron runs with a stable notification
ID. Telemetry contains no raw IP and is pruned after seven days. A daily
activity digest is sent only when probes occurred in the preceding 24 hours.

### Operational checks after deployment

- **Workers Metrics:** request volume and errors. Shared-edge caching is
  intentionally disabled because exact and wildcard hostnames must never share
  an artifact response; budget for each public request to execute the Worker.
- **Workers Observability:** filter `event = "security.request"`; Free retains
  Workers Logs for three days.
- **D1 Metrics → Row Metrics:** rows written is the main enumeration-telemetry
  budget; Free currently includes 100,000 written rows per day.
- **Email Routing:** the destination must remain verified. A successful test
  endpoint response means Cloudflare accepted the message for delivery.

Both routes, `vars.PUBLIC_BASE`, and `vars.SITE_DOMAIN` are required
user-provided values. `PUBLIC_BASE` is the server URL passed to `nzip auth`;
commit responses print the isolated site URL derived from `SITE_DOMAIN`.

When upgrading an existing deployment created before `auth_version` was added,
apply its migration before deploying the new Worker:

```sh
cd worker
npx wrangler d1 execute nzip --remote --file migrations/0001_auth_version.sql
npx wrangler d1 execute nzip --remote --file migrations/0002_security_alerts.sql
npx wrangler d1 execute nzip --remote --file migrations/0003_security_notification_outbox.sql
npx wrangler d1 execute nzip --remote --file migrations/0004_vault_descriptions.sql
npx wrangler d1 execute nzip --remote --file migrations/0005_notifications.sql
npx wrangler d1 execute nzip --remote --file migrations/0006_notification_pairing_window.sql
```

## Owner notifications

Notifications are fail-closed by default. Keep `NOTIFY_ENABLED` set to the
string `"false"` while provisioning and applying the schema. Before deploying,
copy the two notification rate-limit bindings from `wrangler.jsonc` into your
ignored `wrangler.local.jsonc`, then configure one stable VAPID key pair:

```sh
# Generates a public/private P-256 VAPID key pair. Keep the private key private.
npx web-push generate-vapid-keys

# Enter the generated private key only at Wrangler's interactive prompt.
npx wrangler secret put VAPID_PRIVATE_KEY --config wrangler.local.jsonc
```

Set `VAPID_PUBLIC_KEY` to the generated public key and `VAPID_SUBJECT` to a
stable `mailto:` or `https:` contact value in `wrangler.local.jsonc`. Populate
`WEB_PUSH_ORIGINS` with a comma-separated list of exact HTTPS origins observed
from the browsers you intend to pair. Do not add wildcards or the deployment's
own origin. An empty or invalid allowlist rejects subscription attachment and
delivery.

Apply the notification migration before deploying code that reads its tables:

```sh
cd worker
npx wrangler d1 execute nzip --remote \
  --config wrangler.local.jsonc \
  --file migrations/0005_notifications.sql
npx wrangler d1 execute nzip --remote \
  --config wrangler.local.jsonc \
  --file migrations/0006_notification_pairing_window.sql
npx wrangler deploy --dry-run --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
```

`NOTIFY_ENABLED` is the delivery kill switch. Leave it `"false"` until the
deployment configuration is valid and a real device is ready for the pairing
flow.

To pair a phone, first open a 10-minute pairing window from an authenticated
terminal. Then open the deployment root in its browser, tap the temporary `pair`
footer action, and approve the displayed code:

```sh
nzip notify pair
nzip notify approve ABCD-1234 --name "Personal phone"
```

Wait for the browser footer to say `paired` before adding the site to the Home
Screen. Open the installed app, tap `notifications off`, and accept the system
permission request. If the installed app cannot recover the approved claim,
remove it, repeat pairing in the browser, wait for `paired`, and install again.

After pairing succeeds, set `NOTIFY_ENABLED` to `"true"`, redeploy, and use
`nzip notify test` for the final end-to-end smoke test. Notification titles and
bodies may appear on a lock screen; never put passwords, tokens, private URLs,
or other sensitive data in them.

> **Cron gotcha:** deploying the `triggers` block fails with a 403 (API error
> `10063`) until the account has a workers.dev subdomain registered — even if
> the Worker only serves a custom domain. Open the Workers dashboard once to
> auto-create it, or `PUT /accounts/{id}/workers/subdomain` with
> `{"subdomain":"<name>"}`.

## Required domain and wildcard route

1. Add a dedicated zone to your Cloudflare account (registrar -> Cloudflare
   nameservers).
2. In DNS, create a proxied wildcard record for `*`; do not leave the wildcard
   DNS-only.
3. In `wrangler.local.jsonc`, set the exact control Custom Domain, wildcard
   Worker route, `PUBLIC_BASE`, `SITE_DOMAIN`, and your D1 `database_id`.
4. Run `npx wrangler deploy --dry-run --config wrangler.local.jsonc`, then
   deploy. The exact Custom Domain provisions its own DNS and certificate; the
   wildcard route uses the wildcard DNS record from step 2.
5. Verify that `/<address>` returns `308` to `https://<address>.<site-domain>/`,
   an unknown wildcard hostname returns `404`, and `/api/status` is unavailable
   on artifact hostnames.

## CLI

```sh
# from the repo root
deno install -g -A -f --config deno.json -n nzip cli/main.ts

nzip auth --server https://share.demo.dev --token <token-from-step-5>
nzip vault add personal          # slot 0x0
nzip vault add work              # slot 0x1
nzip site push ./docs personal:plan --ttl forever
```

Local development and test commands live in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
