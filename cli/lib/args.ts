import { parseArgs } from "@std/cli/parse-args";

/**
 * Parse CLI arguments. Positionals stay strings: hex addresses such as `3e21` or `0123` would
 * otherwise be coerced to numbers.
 */
export function parseCliArgs(argv: string[]) {
  return parseArgs(argv, {
    string: [
      "_",
      "ttl",
      "to",
      "slot",
      "server",
      "token",
      "password",
      "name",
      "description",
      "default-ttl",
      "default-for",
      "framework",
      "output",
      "build-task",
      "title",
      "open",
      "tag",
      "root",
      "max-ttl",
      "default-password-file",
      "message",
      "callback",
    ],
    boolean: [
      "yes",
      "list",
      "help",
      "version",
      "no-password",
      "overwrite",
      "json",
      "no-description",
      "all",
      "no-default-for",
      "new",
      "require-password",
      "allow-unprotected",
      "no-default-password",
      "feedback",
      "no-feedback",
      "request",
    ],
    alias: { h: "help", V: "version", y: "yes" },
    collect: ["root"],
  });
}
