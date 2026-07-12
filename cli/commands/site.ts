import type { Config } from "../lib/config.ts";
import { fail } from "../lib/fmt.ts";
import { cmdCp } from "./cp.ts";
import { cmdPush } from "./push.ts";
import { cmdLs, cmdRevert, cmdRm, cmdSiteShow, cmdSiteUpdate } from "./sites.ts";
import { cmdWhere } from "./where.ts";

export type SiteInvocation =
  | { kind: "push"; source?: string; target?: string }
  | { kind: "cp"; target?: string; dir?: string }
  | { kind: "show"; target?: string }
  | { kind: "update"; target?: string }
  | { kind: "ls"; vault?: string }
  | { kind: "where"; target?: string }
  | { kind: "rm"; target?: string }
  | { kind: "revert"; target?: string };

export function parseSiteInvocation(rest: string[]): SiteInvocation {
  const [action, first, second, ...extra] = rest;
  if (!action) fail("usage: nzip site <push|cp|show|update|ls|where|rm|revert> ...");
  if (extra.length > 0) fail(`too many arguments for nzip site ${action}`);
  switch (action) {
    case "push":
      return { kind: "push", source: first, target: second };
    case "cp":
      return { kind: "cp", target: first, dir: second };
    case "show":
      if (second !== undefined) fail("usage: nzip site show <target>");
      return { kind: "show", target: first };
    case "update":
      if (second !== undefined) fail("usage: nzip site update <target> [options]");
      return { kind: "update", target: first };
    case "ls":
      if (second !== undefined) fail("usage: nzip site ls [vault]");
      return { kind: "ls", vault: first };
    case "where":
      if (second !== undefined) fail("usage: nzip site where <target>");
      return { kind: "where", target: first };
    case "rm":
      if (second !== undefined) fail("usage: nzip site rm <target> [--yes]");
      return { kind: "rm", target: first };
    case "revert":
      if (second !== undefined) fail("usage: nzip site revert <target> [--to N] [--list]");
      return { kind: "revert", target: first };
    default:
      return fail(`unknown site command: ${action}`);
  }
}

export async function cmdSiteGroup(
  config: Config,
  rest: string[],
  options: {
    ttl?: string;
    password?: string;
    noPassword: boolean;
    overwrite: boolean;
    yes: boolean;
    toSeq?: number;
    list: boolean;
  },
): Promise<void> {
  const invocation = parseSiteInvocation(rest);
  switch (invocation.kind) {
    case "push":
      return await cmdPush(
        config,
        invocation.source,
        invocation.target,
        options.ttl,
        options.password,
        options.noPassword,
      );
    case "cp":
      return await cmdCp(config, invocation.target, invocation.dir, options.overwrite);
    case "show":
      return await cmdSiteShow(config, invocation.target);
    case "update":
      return await cmdSiteUpdate(
        config,
        invocation.target,
        options.ttl,
        options.password,
        options.noPassword,
      );
    case "ls":
      return await cmdLs(config, invocation.vault);
    case "where":
      return await cmdWhere(config, invocation.target);
    case "rm":
      return await cmdRm(config, invocation.target, options.yes);
    case "revert":
      return await cmdRevert(config, invocation.target, options.toSeq, options.list);
  }
}
