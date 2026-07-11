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
nzip auth [--server URL] [--token T]     authenticate and save config
nzip vault add <name> [--slot N]         register a vault (16 slots, 0x0–0xf)
nzip vault ls | default <name>           list vaults / set the default
nzip push <dir|file> [target] [--ttl …] [--password PW | --no-password]
nzip cp <target> [dir] [--overwrite]
nzip site <target> [--ttl …] [--password PW | --no-password]
nzip ls [vault]                          list sites
nzip where <target>                      print the local dir this machine pushed from
nzip rm <target> [--yes]                 delete a site
nzip status                              server + vault overview
nzip revert <target> [--to N] [--list]   repoint to a previous push
```

Password and TTL are committed with the content. On a new site, omitting `--password` creates an
unprotected site; on an existing target, omission preserves its current password. Pass
`--no-password` to clear protection explicitly. The former `nzip share` command remains available as
a compatibility alias for `nzip site`.

`nzip cp work:demo ./recovered-demo` reconstructs the current hosted bundle into an empty directory.
It uses the configured bearer token, verifies file hashes, and never exposes source via the public
page URL. Only uploaded files can be restored; ignored dotfiles and local metadata were never
stored. The former `nzip download` command remains available as a compatibility alias.

See the [project README](https://github.com/FelineStateMachine/nzip) for how addresses work,
self-hosting setup, and architecture. MIT licensed.
