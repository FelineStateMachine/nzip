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
import { cmdDownload } from "./commands/download.ts";
import { cmdLs, cmdRevert, cmdRm, cmdSite, cmdStatus } from "./commands/sites.ts";
import { cmdVault } from "./commands/vault.ts";
import { cmdWhere } from "./commands/where.ts";
import { requireConfig } from "./lib/config.ts";
import { fail, setJsonMode } from "./lib/fmt.ts";

const HELP = `nzip — html share tool

usage:
  nzip auth [--server URL] [--token T]     authenticate against the server
  nzip vault add <name> [--slot N]         register a vault (16 slots, 0x0-0xf)
  nzip vault ls                            list vaults
  nzip vault default <name>                set default vault
  nzip push <dir|file> [target] [--ttl ...] [--password PW | --no-password]
  nzip download <target> [dir] [--overwrite]
  nzip site <target> [--ttl ...] [--password PW | --no-password]
                                           inspect or update ttl/password
  nzip share <target> [...]                 deprecated alias for nzip site
  nzip ls [vault]                          list sites
  nzip where <target>                      print the local dir this machine pushed from
  nzip rm <target> [--yes]                 delete a site
  nzip status                              server + vault overview
  nzip revert <target> [--to N] [--list]   repoint to a previous push

targets: 2a3f | work:demo | demo (alias in default vault)

agent mode: add --json to any command for one-line JSON on stdout;
errors go to stderr as {"ok":false,"error":…,"hint":…} with a suggested next step.

vault guard: set "allowVaults": ["home"] in config.json to restrict this install
to named vaults — pushes/aliases outside the list are refused (agent guardrail).
`;

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["ttl", "to", "slot", "server", "token", "password"],
    boolean: ["yes", "list", "help", "no-password", "overwrite", "json"],
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
    case "download":
      return await cmdDownload(config, rest[0], rest[1], args.overwrite);
    case "site":
    case "share": // compatibility alias for the former site-management command
      return await cmdSite(config, rest[0], args.ttl, args.password, args["no-password"]);
    case "ls":
      return await cmdLs(config, rest[0]);
    case "where":
      return await cmdWhere(config, rest[0]);
    case "rm":
      return await cmdRm(config, rest[0], args.yes);
    case "status":
      return await cmdStatus(config);
    case "revert":
      return await cmdRevert(config, rest[0], toSeq, args.list);
    case "vault":
      return await cmdVault(config, rest[0], rest[1], slot);
    default:
      fail(`unknown command: ${command}\n\n${HELP}`);
  }
}

if (import.meta.main) {
  main().catch((e) => fail((e as Error).message));
}
