# One-time Cloudflare setup

Everything here happens once. Day-to-day content pushes never touch wrangler.

The default architecture targets the Workers Free plan. It requires no paid
Email Sending subscription: alerts use Email Routing to one verified destination.
Free-tier limits are account-wide, so review the
[budget notes](../README.md#free-tier-design-target) before exposing a busy or
multi-tenant deployment.

```sh
cd worker

# 1. auth
npx wrangler login

# 2. private Wrangler config
cp wrangler.jsonc wrangler.local.jsonc
# Edit wrangler.local.jsonc now:
# - routes[0].pattern: your hostname, such as share.example.com
# - vars.PUBLIC_BASE: https://<that hostname>
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

# 7. first deploy
npx wrangler deploy --config wrangler.local.jsonc
```

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
  "ALERT_EMAIL_FROM": "alerts@share.example.com"
}
```

Apply `migrations/0002_security_alerts.sql`,
`migrations/0003_security_notification_outbox.sql`,
`migrations/0004_vault_descriptions.sql`, and
`migrations/0005_notifications.sql` before deploying an upgraded Worker.
After deployment, send a delivery test through the owner-authenticated endpoint:

```sh
curl -X POST -H "Authorization: Bearer $NZIP_TOKEN" \
  https://share.example.com/api/security/test-alert
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
ID. Telemetry contains no raw IP and is pruned after seven days. A daily activity
digest is sent only when probes occurred in the preceding 24 hours.

### Operational checks after deployment

- **Workers Metrics:** request volume and errors; cache hits reduce execution and
  storage reads but still count as Worker requests.
- **Workers Observability:** filter `event = "security.request"`; Free retains
  Workers Logs for three days.
- **D1 Metrics → Row Metrics:** rows written is the main enumeration-telemetry
  budget; Free currently includes 100,000 written rows per day.
- **Email Routing:** the destination must remain verified. A successful test
  endpoint response means Cloudflare accepted the message for delivery.

`routes[0].pattern` and `vars.PUBLIC_BASE` are required user-provided values.
`PUBLIC_BASE` is the origin printed in share URLs and the server URL passed to
`nzip auth`.

When upgrading an existing deployment created before `auth_version` was added,
apply its migration before deploying the new Worker:

```sh
cd worker
npx wrangler d1 execute nzip --remote --file migrations/0001_auth_version.sql
npx wrangler d1 execute nzip --remote --file migrations/0002_security_alerts.sql
npx wrangler d1 execute nzip --remote --file migrations/0003_security_notification_outbox.sql
npx wrangler d1 execute nzip --remote --file migrations/0004_vault_descriptions.sql
npx wrangler d1 execute nzip --remote --file migrations/0005_notifications.sql
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
npx wrangler deploy --dry-run --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
```

`NOTIFY_ENABLED` is the delivery kill switch. Leave it `"false"` until the
deployment configuration is valid and a real device is ready for the pairing
flow.

To pair a phone, open the deployment root in its browser, tap the quiet `pair`
footer action, and approve the displayed code from an authenticated terminal:

```sh
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

## Required custom domain

1. Add your zone to your Cloudflare account (registrar -> Cloudflare
   nameservers).
2. In `wrangler.local.jsonc`, set `routes[0].pattern`, `vars.PUBLIC_BASE`, and
   your D1 `database_id`.
3. `npx wrangler deploy --config wrangler.local.jsonc` - the custom-domain route
   provisions DNS + cert automatically.

## CLI

```sh
# from the repo root
deno install -g -f -n nzip \
  --allow-net --allow-read --allow-write --allow-env \
  cli/main.ts

nzip auth --server https://share.example.com --token <token-from-step-5>
nzip vault add personal          # slot 0x0
nzip vault add work              # slot 0x1
nzip push ./docs personal:plan --ttl forever
```

## Local development

```sh
cd worker
npx wrangler d1 execute nzip --local --file schema.sql   # once
npx wrangler dev                                          # local R2/D1, token from .dev.vars
nzip auth --server http://localhost:8787 --token dev-token-local-only
```

Test the GC cron locally: run `wrangler dev --test-scheduled`, then
`curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"`.
