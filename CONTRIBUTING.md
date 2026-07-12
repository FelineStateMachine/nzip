# Contributing to nzip

Thanks for helping improve nzip. CLI and shared-package work is Deno-first; the Cloudflare Worker
uses Node.js tooling for type generation, tests, and Wrangler.

## Prerequisites

- Deno 2.x
- Node.js 24 and npm
- A Cloudflare account only when testing a real deployment

Install the repository tooling:

```sh
npm ci
cd worker
npm ci
```

## Repository checks

Run the Deno workspace checks from the repository root:

```sh
deno task fmt:check
deno task lint
deno task doc
deno task check
deno task test
deno publish --dry-run --allow-dirty
```

Run the Worker checks from `worker/`:

```sh
npm run check
npm test
npx wrangler deploy --dry-run
```

The Worker runtime tests bind localhost and Wrangler writes diagnostic logs. If a sandbox blocks
either operation, rerun the same command with the required permissions rather than treating it as a
code failure.

## Local Worker development

Create local secrets from the non-secret example, initialize local D1 state, and start Wrangler:

```sh
cd worker
cp .dev.vars.example .dev.vars
npx wrangler d1 execute nzip --local --file schema.sql
npm run dev
```

In another terminal, point the CLI at the local Worker:

```sh
nzip auth --server http://localhost:8787 --token dev-token-local-only
```

To exercise scheduled handlers, run `npx wrangler dev --test-scheduled`, then request a cron:

```sh
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"  # alerts and delivery retries
curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"    # GC, pruning, and digest
```

Local configuration and secrets are ignored by Git. Never commit `.dev.vars` or
`worker/wrangler.local.jsonc`.

## Project structure

- `shared/` contains the runtime-neutral wire contract and canonical manifest logic.
- `cli/` contains the Deno command-line client published as `@nzip/cli`.
- `worker/` contains serving, storage, security telemetry, notifications, and scheduled work.

See [ARCHITECTURE.md](ARCHITECTURE.md) for component boundaries and data flow.

## Documentation

Keep documentation portable Markdown:

- Prefer headings, lists, tables, fenced code blocks, and relative links.
- Avoid raw HTML that only renders correctly on one host.
- Keep user workflows in `README.md`, contributor workflows here, internals in `ARCHITECTURE.md`,
  security guidance in `SECURITY.md`, and deployment operations in `worker/setup.md`.
- Update the CLI help, project README, CLI README, and repo-local skill together when command
  grammar changes.

## Releases

Package versions in `cli/deno.json`, `shared/deno.json`, and `shared/version.ts` must match. Tags in
the form `vX.Y.Z` trigger the publication workflow, which validates the workspace, publishes both
JSR packages, and creates the GitHub Release.
