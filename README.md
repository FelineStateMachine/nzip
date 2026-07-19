# `nzip`

**Push a directory of HTML from the terminal. Get a four-character URL back.**

_Deno CLI → Cloudflare Worker → R2 + D1. Free-tier-oriented static site hosting with optional
expiration, password protection, owner notifications, and enumeration alerts._

[![JSR](https://jsr.io/badges/@nzip/cli)](https://jsr.io/@nzip/cli)

[github.com/FelineStateMachine/nzip](https://github.com/FelineStateMachine/nzip) ·
[args.io/cat/nzip](https://args.io/cat/nzip)

```console
$ nzip site push ./demo work:demo --ttl 30d
  bundling ./demo … 3 files, 197 B
  manifest 4a91d75d — 3 new blobs (197 B), 0 deduped
✓ pushed work:demo -> https://12d8.demo.dev/  (expires in 30d, push #1)
```

## Install

The CLI ships on [JSR](https://jsr.io/@nzip/cli). With [Deno](https://docs.deno.com/runtime/) on
your `PATH`:

```sh
deno install -g -A -f -n nzip jsr:@nzip/cli
nzip --version
nzip auth --server https://share.demo.dev
nzip site push ./site work:demo
```

`nzip auth` prompts for omitted values and saves configuration to `~/.config/nzip/config.json` with
mode 0600. `nzip --version` reports the installed JSR release without requiring authentication; add
`--json` for machine-readable output. Try the CLI without installing it with
`deno run -A jsr:@nzip/cli --help`.

On another machine, install the CLI and authenticate with the same server and token. Hosted vaults
and sites are already available; only the `nzip site where` breadcrumb registry is machine-local.

## How addresses work

Every share lives at four hex characters. The first digit selects one of 16 registered vaults, and
the remaining three select one of 4,096 randomly allocated sites within that vault.

```text
https://2a3f.demo.dev/
        |+- site 0xa3f
        +-- vault 0x2 ("work")
```

Aliases such as `work:demo` are resolved by the authenticated API; public URLs do not expose them.
The control-plane shorthand `https://share.demo.dev/2a3f` permanently redirects to the canonical
site hostname. Each site hostname is a separate browser origin, so its storage, service workers,
and host-only cookies are isolated from other nzip sites. The default passkey relying-party ID is
also the site hostname; see the parent-domain caveat in [SECURITY.md](SECURITY.md).

| form        | example     | meaning                    |
| ----------- | ----------- | -------------------------- |
| address     | `2a3f`      | direct hexadecimal address |
| vault alias | `work:demo` | alias within a named vault |
| bare alias  | `demo`      | alias in the temporary default vault |

## Features

- **Instant and content-addressed.** Push one canonical manifest and only the blobs the server does
  not already have. Identical files are stored once across every site.
- **Lifecycle-aware by default.** Fresh servers use `personal` (slot `0`, 14 days) for temporary
  shares and `public` (slot `f`, forever) for permanent app origins. Every vault can override its
  own default TTL.
- **First-class lofi apps.** `app init` reserves the final browser origin before the first build;
  `app deploy` validates and publishes a root-scoped lofi PWA without ever recycling that origin.
- **Revertible.** The last ten pushes per site are retained and available through
  `nzip site revert`.
- **Password-protectable.** Password policy is committed atomically with content. Signed, host-only
  per-site cookies are invalidated when the policy changes.
- **Recoverable.** `nzip site cp` reconstructs and verifies the currently hosted bundle.
- **Owner notifications.** Explicitly approved phones receive Web Push notifications with bounded,
  same-origin click targets.
- **Machine-local breadcrumbs.** `nzip site where` locates the source directory recorded during a
  push.
- **Vault guardrails.** Optional `allowVaults` configuration refuses disallowed vaults and raw
  addresses before upload.
- **Observable abuse controls.** Enumeration is rate-limited and evaluated through bounded,
  privacy-preserving telemetry.

## Commands

```text
nzip
├─ --version [--json]                     show the installed CLI version
├─ auth [--server URL] [--token T]       authenticate and save config
├─ status                                show server and vault status
├─ app
│  ├─ init <alias|vault:alias>           reserve a stable app URL
│  └─ deploy                             build and deploy the configured lofi app
├─ vault
│  ├─ add <name> [--slot N] [--default-ttl 14d|forever|inherit]
│  ├─ update <name> [--default-ttl 14d|forever|inherit]
│  ├─ ls                                 list vaults
│  └─ default <temporary|permanent> <name>
├─ site
│  ├─ push <dir|file> [target] [--ttl …] [--password PW | --no-password]
│  ├─ cp <target> [dir] [--overwrite]    copy a hosted bundle
│  ├─ show <target>                      show site details
│  ├─ update <target> [--ttl …] [--password PW | --no-password]
│  ├─ ls [vault]                         list sites
│  ├─ where <target>                     print this machine's source directory
│  ├─ rm <target> [--yes]                delete a site
│  └─ revert <target> [--to N] [--list]  inspect or restore push history
└─ notify
   ├─ send <body> [--title TEXT] [--open TARGET] [--tag TEXT]
   ├─ test                               send a diagnostic notification
   ├─ pair                               allow device pairing for 10 minutes
   ├─ approve <code> --name NAME [--yes]
   ├─ devices [--all]                    list notification devices
   └─ revoke <device-id> [--yes]         revoke a notification device
```

Password and TTL values are committed with content. New-site TTL resolves in this order: explicit
`--ttl`, existing-site expiry, vault default, then the global 14-day fallback. Changing a vault
default never rewrites existing sites. `public` names a durable namespace, not an access policy;
sites there may still be password-protected. `status --json` and `vault ls --json` expose
`defaultVaults`, `globalDefaultTtl`, and each vault's effective default for agent planning. Push JSON
reports `ttl` and `ttlSource`. Directory pushes skip dotfiles and `node_modules` and honor a
`.nzipignore` file containing one glob per line.

## Host a lofi app

Reserve the production origin before configuring credentials or building:

```sh
cd field-notes
nzip app init field-notes
# add the printed origin to src/app.ts credentialOrigins
nzip app deploy
```

`app init` defaults to the permanent vault, is idempotent, and writes a token-free
`nzip.app.json` that is safe to commit. Before the first deploy, the reserved URL serves a small
not-deployed page. `app deploy` runs the configured Deno build task with `LOFI_BASE_PATH=/`, verifies
the lofi build identity, PWA files, stable credential origin, and optional passkey RP ID, then
publishes `dist/`. It also mirrors lofi's generated CSP as a response header. Deleting or expiring
app content does not free its address: the origin reservation remains a permanent tombstone because
service workers, OPFS, IndexedDB, and passkeys bind application identity to that origin.

See [`cli/README.md`](cli/README.md) for detailed CLI behavior and examples.

## Owner notifications

Pairing is closed by default. Open a 10-minute window, then tap the temporary `pair` action on the
deployment root and approve the displayed code:

```sh
nzip notify pair
nzip notify approve ABCD-1234 --name "Personal phone"
```

Wait for `paired` before installing the PWA. In the installed app, tap `notifications off` to
request permission and attach the subscription. Send a notification with:

```sh
nzip notify send "Build finished" --open work:report
```

Notification content may be visible on a lock screen. Never include passwords, tokens, private URLs,
or sensitive personal information. See [SECURITY.md](SECURITY.md) for the enrollment and delivery
trust boundaries.

## Self-hosting

nzip is self-hosted; there is no bundled public service. The Worker uses an exact control hostname,
a wildcard site route, R2, D1, rate-limit bindings, and optional Email Routing and Web Push
configuration.

Follow [`worker/setup.md`](worker/setup.md) for provisioning, migrations, secrets, notification
setup, deployment, and operational checks. The system is designed for small personal deployments on
Cloudflare's included usage; see the
[architecture budget notes](ARCHITECTURE.md#free-tier-design-target) before exposing a busy or
multi-tenant instance.

## Project documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — components, push protocol, caching, storage, background work,
  observability, and resource budgets.
- [SECURITY.md](SECURITY.md) — trust boundaries, pairing security, enumeration controls, reporting,
  and monitoring.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, checks, local Worker workflow,
  documentation conventions, and releases.
- [`worker/setup.md`](worker/setup.md) — production Cloudflare deployment and upgrades.
- [`cli/README.md`](cli/README.md) — CLI installation and command reference.
- [`shared/README.md`](shared/README.md) — shared package contract and usage.

MIT licensed.
