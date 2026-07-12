#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
/**
 * `nzip` — push a directory of HTML from the terminal and get a four-character
 * URL back. This is the CLI entrypoint; it parses argv and dispatches to the
 * command handlers (`auth`, `vault`, `push`, `site`, `ls`, `where`, `rm`,
 * `status`, `revert`).
 *
 * Install and run it as a command rather than importing it:
 *
 * ```sh
 * deno install -g -A -f -n nzip jsr:@nzip/cli
 * nzip auth --server https://share.example.com
 * nzip push ./site work:demo
 * ```
 *
 * @module
 */
// nzip — push HTML and get a tiny URL back.

import { parseArgs } from "@std/cli/parse-args";
import { cmdAuth } from "./commands/auth.ts";
import { cmdPush } from "./commands/push.ts";
import { cmdNotify } from "./commands/notify.ts";
import { cmdCp } from "./commands/cp.ts";
import { cmdLs, cmdRevert, cmdRm, cmdSite, cmdStatus } from "./commands/sites.ts";
import { cmdVault } from "./commands/vault.ts";
import { cmdWhere } from "./commands/where.ts";
import { requireConfig } from "./lib/config.ts";
import { fail, setJsonMode } from "./lib/fmt.ts";

const HELP = `nzip — html share tool

commands:
  nzip
  ├─ auth [--server URL] [--token T]       authenticate against the server
  ├─ vault
  │  ├─ add <name> [--slot N] [--description TEXT]
  │  ├─ update <name> [--name NEW_NAME] [--description TEXT | --no-description]
  │  ├─ ls                                 list vaults
  │  └─ default <name>                     set the default vault
  ├─ push <dir|file> [target] [--ttl ...] [--password PW | --no-password]
  ├─ cp <target> [dir] [--overwrite]       copy a hosted bundle
  ├─ site <target> [--ttl ...] [--password PW | --no-password]
  ├─ ls [vault]                            list sites
  ├─ where <target>                        print this machine's source directory
  ├─ rm <target> [--yes]                   delete a site
  ├─ status                                show server and vault status
  ├─ notify
  │  ├─ <body> [--title TEXT] [--open TARGET] [--tag TEXT]
  │  ├─ test                               queue a diagnostic notification
  │  ├─ approve <code> --name NAME [--yes]
  │  ├─ devices                            list notification devices
  │  └─ revoke <device-id> [--yes]         revoke a notification device
  └─ revert <target> [--to N] [--list]     inspect or restore push history

aliases: list → ls · download → cp · share → site

targets: 2a3f | work:demo | demo (alias in default vault)

agent mode: add --json to any command for one-line JSON on stdout;
errors go to stderr as {"ok":false,"error":…,"hint":…} with a suggested next step.

vault guard: set "allowVaults": ["home"] in config.json to restrict this install
to named vaults — pushes/aliases outside the list are refused (agent guardrail).

notification privacy: titles and bodies may appear on a lock screen; never include
passwords, tokens, private URLs, or sensitive personal data.
`;

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: [
      "ttl",
      "to",
      "slot",
      "server",
      "token",
      "password",
      "name",
      "description",
      "title",
      "open",
      "tag",
    ],
    boolean: ["yes", "list", "help", "no-password", "overwrite", "json", "no-description"],
    alias: { h: "help", y: "yes" },
  });
  setJsonMode(args.json);
  const [command, ...rest] = args._.map(String);

  if (args.help || !command) {
    console.log(HELP);
    return;
  }

  if (command === "auth") return await cmdAuth(args.server, args.token);

  const config = await requireConfig();
  const slot = args.slot === undefined ? undefined : parseInt(args.slot, 10);
  const toSeq = args.to === undefined ? undefined : parseInt(args.to, 10);

  switch (command) {
    case "push":
      return await cmdPush(
        config,
        rest[0],
        rest[1],
        args.ttl,
        args.password,
        args["no-password"],
      );
    case "cp":
    case "download": // compatibility alias for the former command name
      return await cmdCp(config, rest[0], rest[1], args.overwrite);
    case "site":
    case "share": // compatibility alias for the former site-management command
      return await cmdSite(
        config,
        rest[0],
        args.ttl,
        args.password,
        args["no-password"],
      );
    case "ls":
    case "list":
      return await cmdLs(config, rest[0]);
    case "where":
      return await cmdWhere(config, rest[0]);
    case "rm":
      return await cmdRm(config, rest[0], args.yes);
    case "status":
      return await cmdStatus(config);
    case "notify":
      return await cmdNotify(config, rest, {
        title: args.title,
        open: args.open,
        tag: args.tag,
        name: args.name,
        yes: args.yes,
      });
    case "revert":
      return await cmdRevert(config, rest[0], toSeq, args.list);
    case "vault":
      return await cmdVault(config, rest[0], rest[1], {
        slot,
        newName: args.name,
        description: args.description,
        clearDescription: args["no-description"],
      });
    default:
      fail(`unknown command: ${command}\n\n${HELP}`);
  }
}

if (import.meta.main) {
  main().catch((e) => fail((e as Error).message));
}
