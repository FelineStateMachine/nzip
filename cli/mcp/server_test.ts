import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CommitRequest, Manifest, SiteDetail, VaultInfo } from "@nzip/shared";
import type { Config } from "../lib/config.ts";
import { createMcpServer, type McpOptions } from "./server.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}
const config: Config = {
  server: "https://nzip.test",
  token: "test-owner-secret",
  allowVaults: ["home"],
};
const vaults: VaultInfo[] = [
  {
    slot: 2,
    name: "home",
    description: "Personal reviews",
    createdAt: 1,
    siteCount: 0,
    defaultTtl: 7,
    effectiveDefaultTtl: 7,
    defaultFor: ["temporary"],
    maxTtl: 14,
    requirePassword: true,
    hasDefaultPassword: true,
  },
  {
    slot: 3,
    name: "work",
    description: "Work",
    createdAt: 1,
    siteCount: 0,
    defaultTtl: "forever",
    effectiveDefaultTtl: "forever",
    defaultFor: ["permanent"],
  },
];

// Entire fake backend is test-only; no network permission, live sites, or credentials required.
class Backend {
  calls: { path: string; method: string; body: unknown }[] = [];
  commits: CommitRequest[] = [];
  sites = new Map<string, SiteDetail>();
  blobs = new Set<string>();
  next = 0x2001;
  now = 100;

  fetch = ((input: string | URL | Request, init?: RequestInit) => {
    assert(new Headers(init?.headers).get("authorization") === `Bearer ${config.token}`);
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    this.calls.push({ path, method, body });
    const json = (data: unknown, status = 200) => Promise.resolve(Response.json(data, { status }));
    if (path === "/api/status") {
      return json({
        ok: true,
        version: "0.10.0",
        vaults,
        defaultVaults: { temporary: "home", permanent: "work" },
        globalDefaultTtl: 14,
        siteCount: this.sites.size,
        expiringSoon: 0,
      });
    }
    if (path === "/api/sites") return json([...this.sites.values()]);
    if (path.startsWith("/api/sites/")) {
      const target = decodeURIComponent(path.slice("/api/sites/".length));
      const site = this.sites.get(target) ??
        [...this.sites.values()].find((s) => `${s.vault}:${s.alias}` === target);
      if (!site) return json({ error: "site not found" }, 404);
      if (method === "PATCH") {
        if (body.password !== undefined) site.protected = body.password !== null;
        if (body.ttl !== undefined) {
          site.expiresAt = body.ttl === "forever" ? null : this.now + body.ttl * 86400;
        }
      }
      return json(site);
    }
    if (path === "/api/push/prepare") {
      const hashes = Object.values((body as { manifest: Manifest }).manifest.files).map((f) => f.h);
      return json({
        manifestHash: "a".repeat(64),
        missing: hashes.filter((h) => !this.blobs.has(h)),
      });
    }
    if (path.startsWith("/api/blob/")) {
      this.blobs.add(path.slice("/api/blob/".length));
      return json({ ok: true });
    }
    if (path === "/api/push/commit") {
      const request = body as CommitRequest;
      this.commits.push(request);
      const address = ("address" in request.target ? request.target.address : this.next++).toString(
        16,
      );
      const previous = this.sites.get(address);
      const ttl = request.ttl ?? 7;
      const expiresAt = request.ttl === undefined && previous
        ? previous.expiresAt
        : ttl === "forever"
        ? null
        : this.now + ttl * 86400;
      const seq = (previous?.history.length ?? 0) + 1;
      const site: SiteDetail = {
        address,
        vault: "home",
        alias: previous?.alias ?? null,
        manifestHash: "a".repeat(64),
        createdAt: previous?.createdAt ?? this.now,
        updatedAt: this.now,
        expiresAt,
        url: `https://${address}.nzip.test/`,
        protected: request.password === undefined
          ? previous?.protected ?? false
          : request.password !== null,
        history: [
          { seq, manifestHash: "a".repeat(64), pushedAt: this.now, note: null },
          ...(previous?.history ?? []),
        ],
      };
      this.sites.set(address, site);
      return json({
        address,
        url: site.url,
        alias: site.alias,
        manifestHash: site.manifestHash,
        expiresAt,
        ttl,
        ttlSource: request.ttl !== undefined ? "explicit" : previous ? "existing-site" : "vault",
        protected: site.protected,
        seq,
      });
    }
    if (path === "/api/notify") {
      return json({ eventId: "event-1", queuedDevices: 1, inactiveDevices: 0 });
    }
    if (path === "/api/notify/devices") {
      return json([{
        id: "phone-1",
        name: "Phone",
        status: "active",
        lastSuccessAt: 1,
        lastError: null,
        userAgentSummary: "not needed in tool result",
      }]);
    }
    throw new Error(`unexpected API request: ${method} ${path}`);
  }) as typeof fetch;
}

async function connect(options: McpOptions = {}) {
  const server = await createMcpServer({ loadConfig: () => Promise.resolve(config), ...options });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function withBackend(fn: (backend: Backend) => Promise<void>) {
  const previous = globalThis.fetch;
  const backend = new Backend();
  globalThis.fetch = backend.fetch;
  try {
    await fn(backend);
  } finally {
    globalThis.fetch = previous;
  }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

Deno.test("MCP negotiates, discovers schemas and annotations, and reads guide without credentials", async () => {
  let configReads = 0;
  const connection = await connect({
    loadConfig: () => {
      configReads++;
      return Promise.resolve(null);
    },
  });
  try {
    const { client } = connection;
    const tools = (await client.listTools()).tools;
    equal(tools.length, 7);
    assert(
      tools.every((t) => t.inputSchema.type === "object" && t.outputSchema?.type === "object"),
    );
    assert(tools.every((t) => t.inputSchema.additionalProperties === false));
    const publish = tools.find((t) => t.name === "nzip_publish")!;
    equal(publish.annotations?.readOnlyHint, false);
    equal(publish.annotations?.destructiveHint, true);
    equal(publish.annotations?.idempotentHint, false);
    equal(tools.find((t) => t.name === "nzip_get_site")?.annotations?.readOnlyHint, true);
    equal((await client.listResources()).resources[0].uri, "nzip://guide");
    const guide = await client.readResource({ uri: "nzip://guide" });
    assert("text" in guide.contents[0] && guide.contents[0].text.includes("mode=update"));
    await client.ping();
    equal(configReads, 0);
  } finally {
    await connection.close();
  }
});

Deno.test("MCP auth errors stay in tool results; config is reloaded and discovery stays alive", async () => {
  await withBackend(async () => {
    let saved: Config | null = null;
    const connection = await connect({ loadConfig: () => Promise.resolve(saved) });
    try {
      const missing = await call(connection.client, "nzip_status");
      equal(missing.isError, true);
      assert(JSON.stringify(missing.content).includes("separate terminal"));
      saved = config;
      const status = await call(connection.client, "nzip_status");
      assert(!status.isError);
      equal((status.structuredContent?.vaults as VaultInfo[]).map((v) => v.name), ["home"]);
      const selected = (status.structuredContent?.vaults as VaultInfo[])[0];
      equal(selected.description, "Personal reviews");
      equal(selected.maxTtl, 14);
      equal(selected.requirePassword, true);
      equal(selected.hasDefaultPassword, true);
      equal(status.structuredContent?.defaultVaults, { temporary: "home", permanent: null });
      assert(!JSON.stringify(status).includes(config.token));
    } finally {
      await connection.close();
    }
  });
});

Deno.test("MCP create inherits vault TTL; update after reconnect retains ID, expiry and password", async () => {
  await withBackend(async (backend) => {
    let connection = await connect();
    try {
      const created = await call(connection.client, "nzip_publish", {
        mode: "create",
        vault: "home",
        html: "<!doctype html><title>first</title>",
        password: "test-password",
      });
      assert(!created.isError, JSON.stringify(created));
      equal(created.structuredContent?.address, "2001");
      equal(created.structuredContent?.ttlSource, "vault");
      assert(
        created.content.some((c) =>
          c.type === "resource_link" && c.uri === "https://2001.nzip.test/"
        ),
      );
      assert(!("ttl" in backend.commits[0]), "MCP must not impose a TTL over vault policy");
      const expiresAt = created.structuredContent?.expiresAt;
      await connection.close();
      connection = await connect();
      backend.now += 200;
      const updated = await call(connection.client, "nzip_publish", {
        mode: "update",
        target: "2001",
        html: "<!doctype html><title>second</title>",
      });
      assert(!updated.isError, JSON.stringify(updated));
      equal(updated.structuredContent?.address, "2001");
      equal(updated.structuredContent?.expiresAt, expiresAt);
      equal(updated.structuredContent?.protected, true);
      equal(updated.structuredContent?.seq, 2);
      equal(backend.commits[1].target, { address: 0x2001 });
      assert(!("ttl" in backend.commits[1]) && !("password" in backend.commits[1]));
      const another = await call(connection.client, "nzip_publish", {
        mode: "create",
        vault: "home",
        html: "new site",
      });
      equal(another.structuredContent?.address, "2002");
    } finally {
      await connection.close();
    }
  });
});

Deno.test("MCP input validation and missing updates do not upload or kill the connection", async () => {
  await withBackend(async (backend) => {
    const connection = await connect();
    try {
      const cases = [
        { mode: "update", target: "2001", html: "not found" },
        { mode: "update", html: "missing target" },
        { mode: "create", html: "missing vault" },
        { mode: "create", vault: "home", target: "2001", html: "ambiguous" },
        { mode: "create", vault: "home", html: "two sources", path: "/tmp/site" },
        { mode: "create", vault: "home", html: "ttl invalid", ttl: 3651 },
        { mode: "create", vault: "home", html: "unknown key", token: "should not be accepted" },
        { mode: "update", target: "bare-alias", html: "implicit default forbidden" },
      ];
      for (const args of cases) {
        equal((await call(connection.client, "nzip_publish", args)).isError, true);
      }
      assert(
        !backend.calls.some((c) =>
          c.path.startsWith("/api/push/") || c.path.startsWith("/api/blob/")
        ),
      );
      await connection.client.ping();
    } finally {
      await connection.close();
    }
  });
});

Deno.test("MCP vault restrictions cover create, raw IDs, explicit aliases, lists, policy and notifications", async () => {
  await withBackend(async (backend) => {
    const connection = await connect();
    try {
      const denied: [string, Record<string, unknown>][] = [
        ["nzip_publish", { mode: "create", vault: "work", html: "not allowed" }],
        ["nzip_publish", { mode: "update", target: "3001", html: "not allowed" }],
        ["nzip_get_site", { target: "work:private" }],
        ["nzip_list_sites", { vault: "work" }],
        ["nzip_set_site_policy", { target: "3001", ttl: 30 }],
        ["nzip_notify", { body: "test", openTarget: "3001" }],
      ];
      for (const [name, args] of denied) {
        equal((await call(connection.client, name, args)).isError, true);
      }
      assert(
        backend.calls.every((c) => c.path === "/api/status"),
        "disallowed targets must not be queried or mutated",
      );
    } finally {
      await connection.close();
    }
  });
});

Deno.test("MCP policy and notification tools preserve explicit intent and return delivery facts", async () => {
  await withBackend(async (backend) => {
    const connection = await connect();
    try {
      await call(connection.client, "nzip_publish", {
        mode: "create",
        vault: "home",
        html: "test",
        password: "test-password",
      });
      const policy = await call(connection.client, "nzip_set_site_policy", {
        target: "2001",
        ttl: "forever",
      });
      assert(!policy.isError);
      equal(backend.sites.get("2001")?.expiresAt, null);
      equal(backend.sites.get("2001")?.protected, true);
      equal(backend.calls.filter((c) => c.method === "PATCH")[0].body, { ttl: "forever" });
      const notify = await call(connection.client, "nzip_notify", {
        body: "Report ready",
        openTarget: "2001",
      });
      equal(notify.structuredContent?.queuedDevices, 1);
      equal(backend.calls.find((c) => c.path === "/api/notify")?.body, {
        body: "Report ready",
        path: "/2001",
      });
      equal(
        (await call(connection.client, "nzip_notify", {
          body: "test",
          openTarget: "https://evil.test",
        })).isError,
        true,
      );
      equal(
        (await call(connection.client, "nzip_notify", { body: "x".repeat(241) })).isError,
        true,
      );
      const devices = await call(connection.client, "nzip_notification_devices");
      assert(!devices.isError);
      assert(!JSON.stringify(devices).includes("userAgentSummary"));
    } finally {
      await connection.close();
    }
  });
});

Deno.test("MCP local publishing requires a root and rejects outside paths and escaping symlinks", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.mkdir(`${directory}/allowed`);
  await Deno.mkdir(`${directory}/allowed-sibling`);
  await Deno.writeTextFile(`${directory}/allowed/index.html`, "<title>allowed</title>");
  await Deno.writeTextFile(`${directory}/allowed-sibling/index.html`, "<title>outside</title>");
  await Deno.symlink(`${directory}/allowed-sibling/index.html`, `${directory}/allowed/escape.html`);
  try {
    await withBackend(async (backend) => {
      let connection = await connect();
      try {
        equal(
          (await call(connection.client, "nzip_publish", {
            mode: "create",
            vault: "home",
            path: `${directory}/allowed`,
          })).isError,
          true,
        );
        await connection.close();
        connection = await connect({ roots: [`${directory}/allowed`] });
        for (
          const path of [
            "relative.html",
            `${directory}/allowed-sibling`,
            `${directory}/allowed/escape.html`,
          ]
        ) {
          equal(
            (await call(connection.client, "nzip_publish", { mode: "create", vault: "home", path }))
              .isError,
            true,
          );
        }
        equal(backend.commits.length, 0);
        const result = await call(connection.client, "nzip_publish", {
          mode: "create",
          vault: "home",
          path: `${directory}/allowed`,
        });
        assert(!result.isError, JSON.stringify(result));
        equal(Object.keys(backend.commits[0].manifest.files), ["index.html"]);
      } finally {
        await connection.close();
      }
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("MCP reports progress only when requested and cancellation prevents pending commit", async () => {
  await withBackend(async (backend) => {
    const connection = await connect();
    try {
      const progress: number[] = [];
      const result = await connection.client.callTool(
        {
          name: "nzip_publish",
          arguments: {
            mode: "create",
            vault: "home",
            html: "progress example",
          },
        },
        CallToolResultSchema,
        {
          onprogress: (p) => {
            progress.push(p.progress);
          },
        },
      );
      assert(!result.isError);
      equal(progress, [0, 1, 2]);
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let observedAbort!: () => void;
      const aborted = new Promise<void>((resolve) => {
        observedAbort = resolve;
      });
      globalThis.fetch = ((input, init) => {
        if (String(input).endsWith("/api/push/prepare")) {
          return new Promise<Response>((_, reject) => {
            const stop = () => {
              observedAbort();
              reject(new DOMException("Cancelled", "AbortError"));
            };
            if (init?.signal?.aborted) stop();
            else init?.signal?.addEventListener("abort", stop, { once: true });
            started();
          });
        }
        return backend.fetch(input, init);
      }) as typeof fetch;
      const controller = new AbortController();
      const pending = connection.client.callTool(
        {
          name: "nzip_publish",
          arguments: {
            mode: "create",
            vault: "home",
            html: "cancelled example",
          },
        },
        CallToolResultSchema,
        { signal: controller.signal },
      ).then(() => false, () => true);
      await ready;
      controller.abort();
      assert(await pending);
      await aborted;
      equal(backend.commits.length, 1);
      await connection.client.ping();
    } finally {
      await connection.close();
    }
  });
});

Deno.test("MCP stdio subprocess initializes, returns JSON-only responses and survives missing auth", async () => {
  const directory = await Deno.makeTempDir();
  const transport = new StdioClientTransport({
    command: "deno",
    args: [
      "run",
      "--allow-read",
      "--allow-env",
      new URL("../main.ts", import.meta.url).pathname,
      "mcp",
    ],
    env: { PATH: Deno.env.get("PATH") ?? "", XDG_CONFIG_HOME: directory },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  try {
    await client.connect(transport);
    equal((await client.listTools()).tools.length, 7);
    equal((await call(client, "nzip_status")).isError, true);
    await client.ping();
    equal(errors, []);
    equal([...Deno.readDirSync(directory)], []);
  } finally {
    await client.close();
    await Deno.remove(directory, { recursive: true });
  }
});
