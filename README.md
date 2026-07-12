# `nzip`

**Push a directory of HTML from the terminal. Get a four-character URL back.**

_Deno CLI → Cloudflare Worker → R2 + D1. Free-tier-oriented static site hosting
with optional expiration, password protection, and enumeration alerts._

[![JSR](https://jsr.io/badges/@nzip/cli)](https://jsr.io/@nzip/cli)

[github.com/FelineStateMachine/nzip](https://github.com/FelineStateMachine/nzip)
· [args.io/cat/nzip](https://args.io/cat/nzip)

```console
$ nzip push ./demo work:demo --ttl 30d
  bundling ./demo … 3 files, 197 B
  manifest 4a91d75d — 3 new blobs (197 B), 0 deduped
✓ pushed work:demo -> https://share.example.com/12d8  (expires in 30d, push #1)
```

---

## How addresses work

Every share lives at four hex characters. The first digit selects one of **16
registered vaults**, the rest a site within it. Each vault holds 4,096 slots,
allocated randomly so URLs don't leak how many sites exist.

```text
https://share.example.com/2a3f
                          |+- site 0xa3f   (0x000-0xFFF, random within the vault)
                          +-- vault 0x2    ("work" - 16 slots, registered by name)
```

Aliases like `work:demo` are resolved by the API; the URL never exposes them.
Commands accept any of three target forms:

| form        | example     | meaning                    |
| ----------- | ----------- | -------------------------- |
| address     | `2a3f`      | direct hex address         |
| vault:alias | `work:demo` | alias within a named vault |
| bare alias  | `demo`      | alias in the default vault |

## Features

- **Instant.** A push is one manifest exchange plus the blobs the server hasn't
  seen. Nothing rebuilds, nothing redeploys.
- **Content-addressed.** Per-file sha256 blobs plus a canonical manifest per
  push. Identical files are stored once across every site; re-pushing an
  unchanged directory uploads `0 new blobs`.
- **Ephemeral by default.** 14-day TTL, with `--ttl 30d` or `--ttl forever` to
  override. Expired shares answer `410 Gone`; a daily cron sweeps them and
  garbage-collects unreferenced content.
- **Revertible.** The last 10 pushes per site are kept. `nzip revert` repoints
  the address at any of them, and the revert itself is recorded as a push.
- **Password-protectable.** `nzip push ./demo work:demo --password …` publishes
  the content and password policy atomically, then gates the site behind an
  unlock form (PBKDF2 hashing, signed per-site cookie, 7 days). Changing the
  password policy revokes existing cookies immediately. Use `nzip site` to
  change protection later.
- **Single-user by design.** One bearer token, stored as a Worker secret and in
  `~/.config/nzip/config.json` (mode 0600).
- **Locates itself.** `nzip where <target>` prints the local directory this
  machine pushed a site from. A breadcrumb registry
  (`~/.config/nzip/paths.json`) records the source path on every push and
  self-cleans: expired entries drop on write, `rm` forgets its entry, and `ls`
  reconciles against the live set. Use it as `cd "$(nzip where personal:plan)"`.
- **Vault guardrail.** An optional `"allowVaults": ["home"]` in `config.json`
  restricts which vaults this install may target by name. Pushes or aliases
  outside the list are refused before any upload, so a home-project agent can't
  drop a doc into a vault that sits adjacent to what you share professionally.
  Absent = unrestricted; raw hex addresses bypass it (they name no vault).

## Commands

```text
nzip auth [--server URL] [--token T]     authenticate and save config
nzip vault add <name> [--slot N] [--description TEXT]
                                         register a vault (16 slots, 0x0–0xf)
nzip vault update <name> [--name NEW_NAME] [--description TEXT]
                                         rename or describe a vault
nzip vault ls | default <name>           list vaults / set the default
nzip push <dir|file> [target] [--ttl …] [--password PW | --no-password]
nzip cp <target> [dir] [--overwrite]        copy the current hosted bundle locally
nzip site <target> [--ttl …] [--password PW | --no-password]
nzip ls [vault]                          list sites
nzip where <target>                      print the local dir this machine pushed from
nzip rm <target> [--yes]                 delete a site
nzip status                              server + vault overview
nzip revert <target> [--to N] [--list]   repoint to a previous push
```

Vault descriptions are returned by `vault ls --json` so agents can choose an
appropriate destination from its purpose or audience. Pass an empty description
to `vault update` to clear it.

Password and TTL are committed with the content. On a new site, omitting
`--password` creates an unprotected site; on an existing target, omission
preserves its current password. Pass `--no-password` to clear protection
explicitly. The former `nzip share` command remains available as a compatibility
alias for `nzip site`.

Pushing a single `page.html` stores it as the site's `index.html`. Directory
pushes skip dotfiles and `node_modules`, and honor a `.nzipignore` (one glob per
line). Single-file sites serve directly at the bare address (`/2a3f`);
multi-file bundles redirect to `/2a3f/` so relative asset URLs resolve.

`nzip cp work:demo ./recovered-demo` recovers the exact current bundle from the
authenticated server when the original local directory is unavailable. It
refuses non-empty destinations unless `--overwrite` is passed, and verifies
every downloaded file against the hosted manifest. It can only restore uploaded
files—not dotfiles, `.nzipignore`, or other local project metadata excluded from
a push. The former `nzip download` command remains available as a compatibility
alias.

## Architecture

### Overview

```mermaid
flowchart LR
    CLI["nzip<br/>Deno CLI"] -- "push API<br/>bearer token" --> W
    V(["visitor"]) -- "GET /2a3f" --> C{"Workers Cache<br/>60s public TTL"}
    C -- "HIT" --> V
    C -- "MISS / BYPASS" --> W["nzip Worker<br/>serve · API"]
    W -- "cacheable response<br/>tagged by site" --> C
    W --> R2[("R2<br/>blobs · manifests")]
    W --> D1[("D1<br/>sites · vaults · history")]
```

### Security lens

<details>
<summary>View the security request and alert flow</summary>

```mermaid
flowchart LR
    REQ(["request"]) --> SURFACE{"request surface"}
    SURFACE -- "/api/*" --> TOKEN["bearer-token check"]
    SURFACE -- "GET /xxxx" --> ENUM["enumeration limiter"]
    SURFACE -- "POST /xxxx/__unlock" --> UNLOCK["password limiter"]
    TOKEN --> API["owner API"]
    ENUM --> SERVE["site lookup / serve"]
    UNLOCK --> SERVE
    SERVE --> GATE{"password protected?"}
    GATE -- "yes" --> COOKIE["PBKDF2 + signed cookie"]
    GATE -- "no" --> PUBLIC["public response"]
    ENUM -. "HMAC scanner identity" .-> PROBES[("D1 probe windows")]
    PROBES --> EVAL["5-minute incident evaluator"]
    EVAL --> OUTBOX[("D1 notification outbox")]
    OUTBOX --> EMAIL["verified-destination email"]
    EMAIL -. "retry on later cron" .-> OUTBOX
    EMAIL --> INBOX(["operator inbox"])
```

</details>

### Observability lens

<details>
<summary>View the logging and metrics flow</summary>

```mermaid
flowchart LR
    RESP["Worker response"] --> CLASSIFY["classify security-relevant request"]
    CLASSIFY --> SAMPLE{"deterministic 1%<br/>scanner sample"}
    SAMPLE -- "normal + selected" --> LOGS["Workers Logs<br/>security.request"]
    SAMPLE -- "429 + selected" --> RESAMPLE{"secondary 1%<br/>request sample"}
    SAMPLE -- "not selected" --> DROP["no log event"]
    RESAMPLE -- "selected" --> LOGS
    RESAMPLE -- "not selected" --> DROP
    PROBES[("D1 probe windows")] --> CRON["5-minute aggregation"]
    CRON --> WINDOW["security.enumeration_window"]
    LOGS --> DASH["Cloudflare Observability"]
    WINDOW --> DASH
    PROBES --> METRICS["D1 row metrics"]
```

</details>

<details>
<summary>Protocol, caching, and storage details</summary>

A push is a stateless three-step protocol, and the manifest itself is the state:

1. `POST /api/push/prepare`: send the manifest, get back which blob hashes the
   server is missing
2. `PUT /api/blob/{sha256}`: upload only those, one per request, 6 at a time;
   the server re-hashes and rejects mismatches or blobs above 50 MiB
3. `POST /api/push/commit`: the server re-verifies every blob exists, then
   commits atomically, resolving or allocating the address, applying
   TTL/password policy, repointing the site, and appending history

Serving is one D1 read (address → manifest, expiry, password) and two R2 reads,
with `ETag` revalidation and a 60-second Workers Cache. Cloudflare checks this
cache before invoking the Worker, so a hit skips Worker execution and the D1/R2
reads. Public responses are tagged per site and purged when a push, revert,
deletion, TTL, or password policy changes; protected responses and errors are
never cached.

Content metadata lives in three tables:

| table    | keys                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| `vaults` | slot (0–15), name, optional description                                          |
| `sites`  | address (0–65535), vault, alias, current manifest, expiry, password hash/version |
| `pushes` | per-site history (seq, manifest, note), capped at 10, powers `revert`            |

Security alert state is deliberately separate:

| table                    | purpose                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `security_probes`        | deduplicated five-minute scanner/address observations; retained 7 days   |
| `security_signals`       | rate-limit confirmations, deduplicated by scanner and window             |
| `security_incidents`     | open/closed state, severity, suppression timestamps, and incident totals |
| `security_notifications` | durable email payloads, delivery attempts, and retry state               |

**GC safety rule:** an R2 object is deleted only if no live site or retained
history entry references it _and_ it's older than 24 hours, so an in-flight push
can never lose objects to a concurrent sweep.

</details>

## Security and observability

The public address space is intentionally small and human-friendly, so nzip
treats enumeration as something to observe and rate-limit rather than pretending
four hex characters are a secret. The two telemetry paths serve different jobs:

<details>
<summary>Signals, alert policy, and operator workflow</summary>

| path                         | signal and retention                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| Workers Logs                 | structured `security.request` events for a deterministic 1% scanner-identity sample |
| D1 five-minute probe windows | bounded, unsampled bare-address observations used for automatic incident decisions  |

Log events classify bare addresses, missing address assets, unlock attempts, bad
API requests, and other scanner-shaped paths. They include the response result,
derived vault/site slots (for example, `/0123` → vault `0x0`, site `0x123`),
country, colo, ASN, and an HMAC-derived `scanner_id`. Raw client IPs are neither
logged nor stored. Automatic invocation logs are disabled, successful site
assets are omitted, paths are length-bounded, and blocked floods are sampled a
second time to control log volume.

The five-minute evaluator opens or escalates an enumeration incident on these
signals:

| severity  | signal                                                                                |
| --------- | ------------------------------------------------------------------------------------- |
| warning   | one scanner tries 20 distinct addresses in 5 minutes                                  |
| warning   | 128 addresses from 10 scanners in 5 minutes, with at least 90% misses                 |
| confirmed | an enumeration request reaches the 429 limiter                                        |
| confirmed | a live hit after 8-address/sequence evidence, or any live hit during an open incident |

Duplicate email is suppressed unless severity increases, volume doubles, a live
site is hit for the first time, or a new vault is targeted after 30 minutes.
Active incidents summarize at most hourly and resolve after three quiet windows
(15 minutes). Alert state and the exact email payload are committed to a D1
outbox before delivery; transient failures retry on later cron runs with a
stable notification ID. A daily activity digest is sent only when probes
occurred. Alerts use a Worker email binding restricted to one verified
destination; the owner-authenticated `/api/security/test-alert` endpoint
validates delivery.

Inspect sampled events under **Workers & Pages → nzip → Observability**,
filtering on `event = "security.request"`. Each event's `sample_rate` records
its sampling factor for aggregate estimates. Watch D1 row metrics as the direct
free-tier budget signal for alert storage, and Worker request/log counts for the
overall service budget.

</details>

## Free-tier design target

nzip is designed so a small personal deployment can stay inside Cloudflare's
included free usage without disabling security or observability. This is a
design target, not a promise: account-wide traffic and storage count toward the
same quotas, Cloudflare can change its limits, and a sufficiently distributed
attack can exhaust a daily quota.

<details>
<summary>Included quotas, safeguards, and failure behavior</summary>

| resource      | how nzip keeps usage bounded                                                                        | current included usage to watch                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers       | short request path; cache checked before invocation                                                 | [100,000 requests/day; 10 ms CPU/invocation](https://developers.cloudflare.com/workers/platform/limits/)                                              |
| Workers Cache | public content only, 60-second TTL, tag purge on mutation                                           | [no separate request allowance](https://developers.cloudflare.com/workers/platform/pricing/); cached Worker requests still count toward Workers usage |
| Workers Logs  | invocation logs off; deterministic 1% identity sample; successful assets omitted                    | [200,000 log events/day with 3-day retention](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing)                     |
| D1            | probe rows deduplicated by scanner/address/window, capped per scanner/location, pruned after 7 days | [5M rows read/day, 100K written/day, 5 GB](https://developers.cloudflare.com/d1/platform/pricing/)                                                    |
| R2 Standard   | content-addressed deduplication, retained-history cap, daily GC                                     | [10 GB-month, 1M Class A and 10M Class B operations/month; free egress](https://developers.cloudflare.com/r2/pricing/#free-tier)                      |
| Alert email   | restricted to a verified Email Routing destination; no arbitrary-recipient sending                  | [verified-destination sends are free on all plans](https://developers.cloudflare.com/email-service/platform/pricing/)                                 |

On the Workers Free plan, exceeding included daily usage does not create an
overage bill. D1 queries fail until the quota resets; Worker request-limit
behavior follows the route's configured fail-open/fail-closed mode. Probe
persistence runs after the response and catches its own errors, so an exhausted
alert-storage budget does not stop normal site serving; it does reduce detection
coverage until the quota resets. Cache hits reduce execution and storage reads,
but they do not remove the request from the Workers request quota. The telemetry
rate limiter is best-effort and local to a Cloudflare location; deduplication
and seven-day pruning provide the durable bounds, while a distributed attack can
still consume the daily D1 allowance.

</details>

## Repo layout

```text
shared/   manifest canonicalization, hashing, addressing (imported by both sides)
cli/      the nzip command (Deno, no framework), published as jsr:@nzip/cli
worker/   Cloudflare Worker: serving, cache, API, security alerts, and GC (wrangler)
```

`shared/` is the contract: canonical JSON serialization lives in exactly one
file ([`shared/manifest.ts`](shared/manifest.ts)) so the CLI and Worker can
never disagree about a manifest hash. It sticks to Web-standard APIs only, so
the same code runs under Deno and workerd.

## Install

The CLI ships on [JSR](https://jsr.io/@nzip/cli). With
[Deno](https://docs.deno.com/runtime/) on your `PATH`, install it in one line,
then point it at your server and push:

```sh
deno install -g -A -f -n nzip jsr:@nzip/cli    # 1. install the `nzip` command

nzip auth --server https://share.example.com   # 2. authenticate (prompts for the token)

nzip push ./site work:demo                     # 3. get a URL back
```

`nzip auth` prompts for anything you omit and saves it to
`~/.config/nzip/config.json` (mode 0600), so every later command just works.
Upgrade any time by re-running the install line; try it without installing via
`deno run -A jsr:@nzip/cli --help`.

Adding a **second machine**? Only the CLI is per-machine; the Worker, R2, D1,
vaults, and token are already provisioned. Install from JSR and run `nzip auth`
with the same server and token, and every vault and site is instantly there.
(The `nzip where` breadcrumb registry is local, so it only knows sites pushed
from this machine.)

`nzip` is self-hosted. The server URL is supplied by the operator; there is no
bundled public service. Use the same URL you set as `vars.PUBLIC_BASE` in your
Wrangler config. Standing up that server is the one-time setup below.

## Self-hosting: one-time Cloudflare setup

See [`worker/setup.md`](worker/setup.md) for the full checklist. In short:

<details>
<summary>Cloudflare provisioning commands and deployment gotchas</summary>

```sh
cd worker
npx wrangler login
cp wrangler.jsonc wrangler.local.jsonc
# edit wrangler.local.jsonc:
# - routes[0].pattern: your hostname, such as share.example.com
# - vars.PUBLIC_BASE: https://<that hostname>
# - d1_databases[0].database_id: filled in after D1 creation
npx wrangler r2 bucket create nzip-content
npx wrangler d1 create nzip                       # paste id into wrangler.local.jsonc
npx wrangler d1 execute nzip --remote --file schema.sql
openssl rand -hex 32 | npx wrangler secret put NZIP_TOKEN --config wrangler.local.jsonc
# configure and verify the alert destination; see worker/setup.md
npx wrangler deploy --config wrangler.local.jsonc
nzip auth --server https://share.example.com      # use your actual PUBLIC_BASE
```

`routes[0].pattern` and `vars.PUBLIC_BASE` are required for a real deployment.
`PUBLIC_BASE` controls the URLs returned by `nzip push`, and the CLI
authenticates against that same origin.

Two gotchas learned the hard way:

- **Cron triggers require a workers.dev subdomain** on the account (API error
  `10063`), even if the Worker only serves a custom domain. Register one in the
  dashboard (or `PUT /accounts/{id}/workers/subdomain`) before deploying with
  `triggers`.
- The required custom-domain route
  (`"routes": [{ "pattern": "share.example.com",
  "custom_domain": true }]`)
  needs the zone on your account; it provisions DNS and the cert automatically
  on deploy.

</details>

## Development

<details>
<summary>Local checks, Worker development, and scheduled-handler testing</summary>

```sh
deno task check                                   # typecheck CLI + shared
cd worker && npx tsc --noEmit                     # typecheck Worker

npx wrangler d1 execute nzip --local --file schema.sql   # once per fresh state
npx wrangler dev                                  # local R2/D1; token in .dev.vars
nzip auth --server http://localhost:8787 --token dev-token-local-only
```

Test scheduled handlers with `npx wrangler dev --test-scheduled`, then invoke
either cron locally:

```sh
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"  # alert evaluation
curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"    # GC + digest
```

</details>
