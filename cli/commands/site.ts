import type { Config } from "../lib/config.ts";
import { fail } from "../lib/fmt.ts";
import { cmdCp } from "./cp.ts";
import { cmdPush } from "./push.ts";
import { cmdLs, cmdRevert, cmdRm, cmdSitePolicy, cmdSiteShow } from "./sites.ts";
import { cmdWhere } from "./where.ts";

export type SiteInvocation =
  | { kind: "push"; source?: string; target?: string }
  | { kind: "cp"; target?: string; dir?: string }
  | { kind: "show"; target?: string }
  | { kind: "policy"; target?: string }
  | { kind: "ls"; vault?: string }
  | { kind: "where"; target?: string }
  | { kind: "rm"; target?: string }
  | { kind: "revert"; target?: string };

export function parseSiteInvocation(rest: string[]): SiteInvocation {
  const [action, first, second, ...extra] = rest;
  if (!action) fail("usage: nzip site <push|cp|show|policy|ls|where|rm|revert> ...");
  if (extra.length > 0) fail(`too many arguments for nzip site ${action}`);
  switch (action) {
    case "push":
      return { kind: "push", source: first, target: second };
    case "cp":
      return { kind: "cp", target: first, dir: second };
    case "show":
      if (second !== undefined) fail("usage: nzip site show <target>");
      return { kind: "show", target: first };
    case "policy":
      if (second !== undefined) fail("usage: nzip site policy <target> [options]");
      return { kind: "policy", target: first };
    case "update":
      return fail(
        "site update was replaced by site policy",
        "publish content with `nzip site push <dir|file> <target>`; change TTL/password with `nzip site policy <target> ...`",
      );
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
    newSite: boolean;
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
        options.newSite,
      );
    case "cp":
      return await cmdCp(config, invocation.target, invocation.dir, options.overwrite);
    case "show":
      return await cmdSiteShow(config, invocation.target);
    case "policy":
      return await cmdSitePolicy(
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
