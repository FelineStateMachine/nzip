# `@nzip/shared`

**The runtime-agnostic contract between the [nzip](https://github.com/FelineStateMachine/nzip) CLI
and Worker.**

Manifest canonicalization, content hashing, address/target parsing, and the wire types exchanged
over the API. Canonical JSON serialization lives in exactly one place
([`manifest.ts`](./manifest.ts)) so the CLI and Worker can never disagree about a manifest hash.

This package uses only Web-standard APIs (`crypto.subtle`, `TextEncoder`/`TextDecoder`, `JSON`), so
the same code runs under Deno, Cloudflare Workers, Node.js, Bun, and browsers.

## Install

```sh
deno add jsr:@nzip/shared
```

## Use

```ts
import { canonicalManifestBytes, type Manifest, manifestHash, parseTarget } from "@nzip/shared";

const manifest: Manifest = {
  v: 1,
  files: {
    "index.html": {
      h: "…64-hex-sha256…",
      s: 128,
      ct: "text/html; charset=utf-8",
    },
  },
};

// Byte-identical on every runtime, which is what makes hashes agree across CLI and Worker.
const hash = await manifestHash(manifest);
const bytes = canonicalManifestBytes(manifest);

parseTarget("2a3f"); // { kind: "address", address: 10815 }
parseTarget("work:demo"); // { kind: "vaultAlias", vault: "work", alias: "demo" }
parseTarget("demo"); // { kind: "alias", alias: "demo" }
```

MIT licensed.
