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
                                                # → https://share.demo.dev/12d8
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
├─ vault
│  ├─ add <name> [--slot N] [--description TEXT]
│  ├─ update <name> [--name NEW_NAME] [--description TEXT | --no-description]
│  ├─ ls                                 list vaults
│  └─ default <name>                     set the default vault
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
   ├─ devices [--all]                    list current notification devices
   └─ revoke <device-id> [--yes]         revoke a notification device
```

Vault descriptions are included in `vault ls --json`. Use
`nzip vault update <name> --no-description` to clear one.

Password and TTL are committed with the content. On a new site, omitting `--ttl` uses 14 days and
omitting `--password` creates an unprotected site. On an existing target, omitted settings preserve
their current values. Pass `--no-password` to clear protection explicitly.

`nzip site cp work:demo ./recovered-demo` reconstructs the current hosted bundle into an empty
directory. It uses the configured bearer token, verifies file hashes, and never exposes source via
the public page URL. Only uploaded files can be restored; ignored dotfiles and local metadata were
never stored.

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
