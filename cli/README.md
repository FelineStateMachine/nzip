# `@nzip/cli`

**Push a directory of HTML from the terminal. Get a four-character URL back.**

The command-line client for [nzip](https://github.com/FelineStateMachine/nzip), a personal,
self-hosted share tool. The CLI bundles a directory, uploads only the blobs your server hasn't seen,
and prints a tiny URL. The backend is your own Cloudflare Worker (R2 + D1); there is no public
service.

## Install

Requires [Deno](https://docs.deno.com/runtime/) on your `PATH`.

```sh
deno install -g -A -f -n nzip jsr:@nzip/cli
nzip --version
```

Try it without installing:

```sh
deno run -A jsr:@nzip/cli --help
```

## Use

```sh
nzip auth --server https://share.demo.dev   # authenticate (prompts for the token)
nzip vault add work                            # register a named vault
nzip site push ./site work:demo --ttl 30d --password secret
                                                # → https://12d8.demo.dev/
```

Config is saved to `~/.config/nzip/config.json` (mode 0600), so later commands just work. On a
second machine, install from JSR and re-run `nzip auth` with the same server and token; every vault
and site is already there.

`nzip --version` prints the installed release without reading saved configuration. Use
`nzip --version --json` to receive a single JSON object with a `version` field for scripts and
agents.

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
│  ├─ push <dir|file> [target] [--new] [--ttl …] [--password PW | --no-password]
│  ├─ cp <target> [dir] [--overwrite]    copy a hosted bundle
│  ├─ show <target>                      show site details
│  ├─ policy <target> [--ttl …] [--password PW | --no-password]
│  ├─ ls [vault]                         list sites
│  ├─ where <target>                     print this machine's source directory
│  ├─ rm <target> [--yes]                delete a site
│  └─ revert <target> [--to N] [--list]  inspect or restore push history
└─ notify
   ├─ send <body> [--title TEXT] [--open TARGET] [--tag TEXT]
   ├─ test                               send a diagnostic notification
   ├─ pair                               allow device pairing for 10 minutes
   ├─ approve <code> --name NAME [--yes]
   ├─ devices [--all]                    list current notification devices
   └─ revoke <device-id> [--yes]         revoke a notification device
```

Vault descriptions, lifecycle roles, configured TTLs, and effective TTLs are included in
`vault ls --json`. Use `nzip vault update <name> --no-description` to clear a description,
`--default-ttl inherit` to restore the global fallback, and
`nzip vault default <temporary|permanent> <name>` to select lifecycle defaults.

Password and TTL are committed with the content. TTL precedence is explicit flag, existing-site
expiry, vault default, then the global 14-day fallback. Fresh servers create `personal` in slot `0`
as the temporary 14-day default and `public` in slot `f` as the permanent forever default, without
overwriting occupied slots on upgrade. `public` does not mean unprotected. Pass `--no-password` to
clear protection explicitly. Push JSON includes the resolved `ttl` and `ttlSource`.

Use `site push` for content revisions and `site policy` for TTL or password changes. An untargeted
push reuses a unique unexpired local breadcrumb for the same logical source; a directory and its
`index.html` are treated as one source. Multiple matches stop with candidate targets instead of
guessing; an explicit targeted push rebinds the source for later untargeted revisions. Pass `--new`
only when a separate URL is intended.

For a lofi PWA, run `nzip app init <alias>` before editing its deployed credential origins. The
command reserves the permanent default vault's final URL and writes a token-free `nzip.app.json`.
After adding the printed origin to `src/app.ts` `credentialOrigins`, run `nzip app deploy`. It
builds at `/`, validates the lofi output and stable identity settings, mirrors the generated CSP,
and pushes to the reservation. The address remains reserved after content deletion or expiry and is
never returned to ordinary site allocation.

`nzip site cp work:demo ./recovered-demo` reconstructs the current hosted bundle into an empty
directory. It uses the configured bearer token, verifies file hashes, and never exposes source via
the public page URL. Only uploaded files can be restored; ignored dotfiles and local metadata were
never stored.

## MCP for AI clients

See [MCP.md](MCP.md) for the proposed `nzip mcp` stdio mode, stateless create/update semantics,
purpose-driven vault selection, supported MCP conventions, and client configuration examples.

Vault policy flags (owner administration, not agent tools):

```sh
nzip vault update reviews --description "Private temporary review pages" --default-ttl 7d --max-ttl 14d --require-password --default-password-file /secure/path/review-password
```

`--max-ttl none` removes the cap; `--allow-unprotected` removes mandatory protection;
`--no-default-password` clears only the default for future sites. Existing sites are not silently
changed. Tightening rules is refused until existing sites comply. Password-file contents are sent
over the authenticated API and stored only as a verifier; no password is included in JSON results.

## Notifications

Pairing is closed by default. Open a 10-minute pairing window from the authenticated CLI, then open
the deployment root on the phone. The `pair` action appears only while that window is open. After
the phone shows a code, approve it from the CLI:

```sh
nzip notify pair
nzip notify approve ABCD-1234 --name "Personal phone"
nzip notify devices
nzip notify devices --all # include disabled, revoked, and expired tombstones
nzip notify send "Report ready" --title "nzip" --open work:report
```

`--open` accepts an existing nzip target and applies the same local vault guardrails as other
target-aware commands. It never accepts an arbitrary URL. `nzip notify test` uses the ordinary
notification delivery path. Use `nzip notify revoke <device-id> --yes` to remove a device.

Notification content may appear on a lock screen. Never include passwords, tokens, private URLs, or
sensitive personal data in a title or body.

See the [project README](../README.md) for how addresses work, the
[deployment runbook](../worker/setup.md) for self-hosting, and [ARCHITECTURE.md](../ARCHITECTURE.md)
for internals. MIT licensed.
