import { cmdApp } from "./app.ts";

Deno.test("app init reserves the permanent default and writes token-free tracked config", async () => {
  const directory = await Deno.makeTempDir();
  const previousDirectory = Deno.cwd();
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const requests: string[] = [];
  globalThis.fetch = ((input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/api/status")) {
      return Promise.resolve(
        new Response(JSON.stringify({
          ok: true,
          version: "0.9.0",
          defaultVaults: { temporary: "personal", permanent: "public" },
          globalDefaultTtl: 14,
          vaults: [],
          siteCount: 0,
          expiringSoon: 0,
        })),
      );
    }
    if (url.endsWith("/api/apps")) {
      return Promise.resolve(
        new Response(JSON.stringify({
          address: "f123",
          vault: "public",
          alias: "field-notes",
          url: "https://f123.n.zip/",
          createdAt: 1,
          deployed: false,
        })),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  console.log = () => {};
  try {
    Deno.chdir(directory);
    const config = { server: "https://n.zip", token: "owner-secret" };
    await cmdApp(config, ["init", "field-notes"], {});
    await cmdApp(config, ["init"], {});
    const saved = JSON.parse(await Deno.readTextFile("nzip.app.json"));
    if (
      saved.target !== "public:field-notes" || saved.address !== "f123" ||
      saved.origin !== "https://f123.n.zip" || saved.framework !== "lofi"
    ) {
      throw new Error(`unexpected app config: ${JSON.stringify(saved)}`);
    }
    if (JSON.stringify(saved).includes(config.token)) throw new Error("app config leaked token");
    if (requests.filter((url) => url.endsWith("/api/apps")).length !== 2) {
      throw new Error("idempotent init did not verify the server reservation");
    }
  } finally {
    Deno.chdir(previousDirectory);
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("app deploy builds a root-scoped lofi PWA and commits its CSP", async () => {
  const directory = await Deno.makeTempDir();
  const previousDirectory = Deno.cwd();
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  let committed: Record<string, unknown> | undefined;
  globalThis.fetch = ((input, init) => {
    const url = String(input);
    if (url.endsWith("/api/push/prepare")) {
      return Promise.resolve(
        new Response(JSON.stringify({ manifestHash: "a".repeat(64), missing: [] })),
      );
    }
    if (url.endsWith("/api/push/commit")) {
      committed = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(JSON.stringify({
          address: "f123",
          url: "https://f123.n.zip/",
          alias: "field-notes",
          manifestHash: "a".repeat(64),
          expiresAt: null,
          ttl: "forever",
          ttlSource: "vault",
          protected: false,
          seq: 1,
        })),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  console.log = () => {};
  try {
    Deno.chdir(directory);
    await Deno.mkdir("src");
    await Deno.writeTextFile(
      "src/app.ts",
      'const app = { credentialOrigins: ["https://f123.n.zip"] };\n',
    );
    await Deno.writeTextFile(
      "deno.json",
      JSON.stringify({ tasks: { build: "deno run -A build.ts" } }),
    );
    await Deno.writeTextFile(
      "build.ts",
      `await Deno.mkdir("dist", { recursive: true });
const files = {
  "index.html": "<!doctype html><title>app</title>",
  "manifest.webmanifest": "{}",
  "sw.js": "// worker",
  "lofi-precache.json": "[]",
  "lofi-schema.json": "{}",
  "lofi-build.json": JSON.stringify({
    lofiVersion: "1.0.0",
    sourceHash: "fixture",
    basePath: "/",
    csp: "default-src 'self'",
  }),
};
for (const [name, value] of Object.entries(files)) await Deno.writeTextFile("dist/" + name, value);
`,
    );
    await Deno.writeTextFile(
      "nzip.app.json",
      JSON.stringify({
        v: 1,
        framework: "lofi",
        target: "public:field-notes",
        address: "f123",
        origin: "https://f123.n.zip",
        build: { task: "build", output: "dist" },
      }),
    );

    await cmdApp(
      { server: "https://n.zip", token: "owner-secret" },
      ["deploy"],
      {},
    );
    if (
      (committed?.target as { vault?: string })?.vault !== "public" ||
      (committed?.app as { contentSecurityPolicy?: string })?.contentSecurityPolicy !==
        "default-src 'self'"
    ) {
      throw new Error(`unexpected app commit: ${JSON.stringify(committed)}`);
    }
  } finally {
    Deno.chdir(previousDirectory);
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    await Deno.remove(directory, { recursive: true });
  }
});
