# One-time Cloudflare setup

Everything here happens once. Day-to-day content pushes never touch wrangler.

```sh
cd worker

# 1. auth
npx wrangler login

# 2. private Wrangler config
cp wrangler.jsonc wrangler.local.jsonc
# Edit wrangler.local.jsonc now:
# - routes[0].pattern: your hostname, such as share.example.com
# - vars.PUBLIC_BASE: https://<that hostname>
# - d1_databases[0].database_id: filled in after D1 creation

# 3. storage
npx wrangler r2 bucket create nzip-content
npx wrangler d1 create nzip
#    -> paste the printed database_id into wrangler.local.jsonc

# 4. schema
npx wrangler d1 execute nzip --remote --file schema.sql

# 5. owner token
openssl rand -hex 32                       # keep this — it's your CLI token
npx wrangler secret put NZIP_TOKEN --config wrangler.local.jsonc

# 6. first deploy
npx wrangler deploy --config wrangler.local.jsonc
```

`routes[0].pattern` and `vars.PUBLIC_BASE` are required user-provided values. `PUBLIC_BASE` is the
origin printed in share URLs and the server URL passed to `nzip auth`.

When upgrading an existing deployment created before `auth_version` was added, apply its migration
before deploying the new Worker:

```sh
cd worker
npx wrangler d1 execute nzip --remote --file migrations/0001_auth_version.sql
```

> **Cron gotcha:** deploying the `triggers` block fails with a 403 (API error `10063`) until the
> account has a workers.dev subdomain registered — even if the Worker only serves a custom domain.
> Open the Workers dashboard once to auto-create it, or `PUT /accounts/{id}/workers/subdomain` with
> `{"subdomain":"<name>"}`.

## Required custom domain

1. Add your zone to your Cloudflare account (registrar -> Cloudflare nameservers).
2. In `wrangler.local.jsonc`, set `routes[0].pattern`, `vars.PUBLIC_BASE`, and your D1
   `database_id`.
3. `npx wrangler deploy --config wrangler.local.jsonc` - the custom-domain route provisions DNS +
   cert automatically.

## CLI

```sh
# from the repo root
deno install -g -f -n nzip \
  --allow-net --allow-read --allow-write --allow-env \
  cli/main.ts

nzip auth --server https://share.example.com --token <token-from-step-5>
nzip vault add personal          # slot 0x0
nzip vault add work              # slot 0x1
nzip push ./docs personal:plan --ttl forever
```

## Local development

```sh
cd worker
npx wrangler d1 execute nzip --local --file schema.sql   # once
npx wrangler dev                                          # local R2/D1, token from .dev.vars
nzip auth --server http://localhost:8787 --token dev-token-local-only
```

Test the GC cron locally: run `wrangler dev --test-scheduled`, then
`curl "http://localhost:8787/__scheduled?cron=0+4+*+*+*"`.
