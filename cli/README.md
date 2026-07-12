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
```

Try it without installing:

```sh
deno run -A jsr:@nzip/cli --help
```

## Use

```sh
nzip auth --server https://share.example.com   # authenticate (prompts for the token)
nzip vault add work                            # register a named vault
nzip push ./site work:demo --ttl 30d --password secret
                                                # → https://share.example.com/12d8
```

Config is saved to `~/.config/nzip/config.json` (mode 0600), so later commands just work. On a
second machine, install from JSR and re-run `nzip auth` with the same server and token; every vault
and site is already there.

## Commands

```text
nzip
├─ auth [--server URL] [--token T]       authenticate and save config
├─ vault
│  ├─ add <name> [--slot N] [--description TEXT]
│  ├─ update <name> [--name NEW_NAME] [--description TEXT | --no-description]
│  ├─ ls                                 list vaults
│  └─ default <name>                     set the default vault
├─ push <dir|file> [target] [--ttl …] [--password PW | --no-password]
├─ cp <target> [dir] [--overwrite]       copy a hosted bundle
├─ site <target> [--ttl …] [--password PW | --no-password]
├─ ls [vault]                            list sites
├─ where <target>                        print this machine's source directory
├─ rm <target> [--yes]                   delete a site
├─ status                                show server and vault status
├─ notify
│  ├─ <body> [--title TEXT] [--open TARGET] [--tag TEXT]
│  ├─ test                               send a diagnostic notification
│  ├─ approve <code> --name NAME [--yes]
│  ├─ devices [--all]                    list current notification devices
│  └─ revoke <device-id> [--yes]         revoke a notification device
└─ revert <target> [--to N] [--list]     inspect or restore push history

aliases: list → ls · download → cp · share → site
```

Vault descriptions are included in `vault ls --json`. Use
`nzip vault update <name> --no-description` to clear one.

Password and TTL are committed with the content. On a new site, omitting `--password` creates an
unprotected site; on an existing target, omission preserves its current password. Pass
`--no-password` to clear protection explicitly.

`nzip cp work:demo ./recovered-demo` reconstructs the current hosted bundle into an empty directory.
It uses the configured bearer token, verifies file hashes, and never exposes source via the public
page URL. Only uploaded files can be restored; ignored dotfiles and local metadata were never
stored.

## Notifications

Pairing starts from the deployment root. After the phone shows a code, approve it from the
authenticated CLI:

```sh
nzip notify approve ABCD-1234 --name "Personal phone"
nzip notify devices
nzip notify devices --all # include disabled, revoked, and expired tombstones
nzip notify "Report ready" --title "nzip" --open work:report
```

`--open` accepts an existing nzip target and applies the same local vault guardrails as other
target-aware commands. It never accepts an arbitrary URL. `nzip notify test` uses the ordinary
notification delivery path. Use `nzip notify revoke <device-id> --yes` to remove a device.

Notification content may appear on a lock screen. Never include passwords, tokens, private URLs, or
sensitive personal data in a title or body.

See the [project README](https://github.com/FelineStateMachine/nzip) for how addresses work,
self-hosting setup, and architecture. MIT licensed.
