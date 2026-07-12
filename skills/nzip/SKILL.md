---
name: nzip
description: Set up, diagnose, and use the nzip HTML sharing CLI with repository-local working directories and safe publishing defaults. Use when installing or authenticating nzip, troubleshooting nzip access, publishing or managing an HTML artifact, pairing notification devices, sending or managing owner notifications, or establishing nzip conventions in a repository.
---

# nzip

Use nzip to publish HTML while keeping the editable source beside the repository context that
produced it. Diagnose the local installation before guessing about unavailable access.

## Setup

1. Locate the repository root with `git rev-parse --show-toplevel` when inside a Git repository.
2. Check for the CLI with `command -v nzip` and `nzip --help`.
3. If it is missing and Deno is available, install or upgrade it:

   ```sh
   deno install -g -A -f -n nzip jsr:@nzip/cli
   ```

4. Authenticate only with a server and token supplied by the user or environment:

   ```sh
   nzip auth --server <url> --token <token>
   ```

   When `--server` is omitted, the prompt defaults to `NZIP_SERVER` (or `NZIP_DOMAIN`, expanded to
   `https://<domain>`); check those variables before asking the user for a server. No environment
   variable supplies the token. Omit `--token` when an interactive prompt is safer. The prompt
   requires a TTY: in a non-interactive run, omitting `--token` fails instead of prompting, so ask
   the user to run `nzip auth` themselves. Never print, commit, or invent the token.

5. Ensure the repository `.gitignore` contains this exact rule:

   ```gitignore
   .nzip-*/
   ```

   Add the rule without replacing existing ignore entries. Put generated sites at the repository
   root using a descriptive name such as `.nzip-auth-plan/` or `.nzip-weekly-report/`. Keep the
   directory after publishing so later revisions retain the originating repository context, but do
   not commit it.

## Doctor

Run checks in this order and stop at the first failure that needs user input:

1. `command -v nzip` — if missing, follow Setup.
2. `nzip --help` — confirm the installed command starts.
3. `nzip status --json` — verify saved authentication, server reachability, and token validity.
4. `nzip vault ls --json` — verify available vaults and the default vault.

Use the JSON `error` and `hint` fields as the primary diagnosis. Re-run `nzip auth` for missing or
rejected credentials, correct the configured server for reachability failures, and ask the user to
choose a vault when no safe destination is evident. Ask to use the required network or filesystem
permissions when a sandbox blocks a check instead of reporting nzip as broken.

## Publish an artifact

1. Create a complete site inside `.nzip-<purpose>/` at the repository root. Use `index.html` as its
   entry point and keep any related assets inside the same directory.
2. Validate the artifact locally in proportion to its complexity.
3. Publish with an explicit low TTL:

   ```sh
   nzip site push .nzip-<purpose>/ --ttl 1d
   ```

   Use `1d` for plans, designs, review pages, and other disposable agent artifacts unless the user
   requests a different review window. Choose a longer finite TTL only when the requested workflow
   plainly needs it. Do not use `forever` by default. The nzip service default is 14 days, so always
   pass `--ttl 1d` for these short-lived artifacts rather than relying on omission.

4. Use an explicit `<vault>:<alias>` target when the destination matters, picking a vault from
   `nzip vault ls --json`:

   ```sh
   nzip site push .nzip-<purpose>/ <vault>:<alias> --ttl 1d
   ```

5. Return the canonical URL and expiry. If the user requested a review boundary or asked for only
   the link, return only the link and wait for approval before implementing the reviewed work.

## Use guide

Prefer `--json` when consuming command output programmatically.

```text
nzip
├─ auth [--server URL] [--token T]
├─ vault
│  ├─ add <name> [--slot N] [--description TEXT]
│  ├─ update <name> [--name NEW_NAME] [--description TEXT | --no-description]
│  ├─ ls
│  └─ default <name>
├─ site
│  ├─ push <dir|file> [target] [--ttl DAYS] [--password PW | --no-password]
│  ├─ cp <target> [dir] [--overwrite]
│  ├─ show <target>
│  ├─ update <target> [--ttl DAYS] [--password PW | --no-password]
│  ├─ ls [vault]
│  ├─ where <target>
│  ├─ rm <target> [--yes]
│  └─ revert <target> [--to N] [--list]
├─ status
└─ notify
   ├─ send <body> [--title TEXT] [--open TARGET] [--tag TEXT]
   ├─ test
   ├─ pair
   ├─ approve <code> --name NAME [--yes]
   ├─ devices
   └─ revoke <device-id> [--yes]
```

Use password protection when the content or user requires it; `nzip site push` accepts the same
`--password <pw> | --no-password` flags to set it at publish time. Vault descriptions appear in
`vault ls` and `status`; use them to pick the right destination, and pass `--no-description` to
clear one. A vault rename updates the invoking client's default vault, allow-list, and local push
records, but other clients keep the old name; renaming to a name outside `allowVaults` is refused.
Treat `revert`, vault renames, password changes, TTL changes, and deletion as state changes; do not
perform them while merely diagnosing. Never infer deletion confirmation.

Notifications are external, lock-screen-visible side effects. Do not send,
test, approve, or revoke unless the user explicitly requests that action. Never
put credentials, private URLs, sensitive personal data, or other secrets in a
notification title or body. Prefer `--open <target>` for click-throughs because
the CLI resolves an existing nzip site, applies vault guardrails, and sends only
a same-origin path. A pairing code is short-lived but is not sufficient on its
own; approval still uses the configured owner bearer token.

## Pair notifications

1. On explicit request, run `nzip notify pair` to open the owner-authenticated 10-minute pairing
   window. This is an external state change; do not open it while merely diagnosing.
2. Open the deployment root on the phone while the temporary `pair` action is visible and tap it.
3. Ask the user for the displayed code and device name, then run
   `nzip notify approve <code> --name <name>`. Show the approval preview and preserve the
   interactive confirmation unless the user explicitly requested `--yes`.
4. Wait for the browser to show `paired` before installing the PWA.
5. Open the installed app, tap `notifications off`, and accept the system permission request.
6. Run `nzip notify test` only when the user explicitly requests an end-to-end test.
7. Send only on explicit request with
   `nzip notify send <body> [--title TEXT] [--open TARGET] [--tag TEXT]`.
8. Inspect current delivery health with `nzip notify devices --json`. Add `--all` only when
   disabled, revoked, or expired tombstones are relevant.

If the installed app loses its pairing cookie, instruct the user to remove it, pair again in the
browser, wait for `paired`, and reinstall it. Revoke a device only on explicit request.

## Sane defaults

- Keep generated HTML in `.nzip-<purpose>/`, not a system temp directory or a tracked source
  directory, unless requested.
- Ignore all such directories with `.nzip-*/`.
- Publish disposable plans and designs with `--ttl 1d`.
- Prefer finite TTLs; use `forever` only when explicitly requested.
- Prefer descriptive aliases and an explicit vault when identity or audience matters.
- Preserve the local artifact directory for iteration and `nzip site where`; do not commit it.
- Use complete, self-contained HTML and relative asset paths.
- Use read-only status, list, and inspect operations before mutations when destination state is
  uncertain.
