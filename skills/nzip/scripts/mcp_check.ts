// Smoke-test an nzip MCP launch command over stdio, so a harness registration can be verified
// without restarting the agent session that made it. Prints no credentials: nzip_status never
// returns the token.
//
// Usage: deno run --allow-run mcp_check.ts -- <command> [args...]

const argv = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
if (!argv.length) {
  console.error("usage: deno run --allow-run mcp_check.ts -- <command> [args...]");
  Deno.exit(2);
}

type Message = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

const child = new Deno.Command(argv[0], {
  args: argv.slice(1),
  stdin: "piped",
  stdout: "piped",
  stderr: "piped",
}).spawn();
const stderr = new Response(child.stderr).text();
const writer = child.stdin.getWriter();
const encoder = new TextEncoder();
const pending = new Map<number, (message: Message) => void>();
let nextId = 1;

const deadline = setTimeout(() => fail("timed out after 60s waiting for the server"), 60_000);

async function fail(reason: string): Promise<never> {
  clearTimeout(deadline);
  console.error(`FAIL: ${reason}`);
  try {
    child.kill();
  } catch { /* already exited */ }
  const log = (await stderr).trim();
  if (log) console.error(`server stderr:\n${log}`);
  Deno.exit(1);
}

(async () => {
  let buffer = "";
  for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Message;
      if (typeof message.id === "number") pending.get(message.id)?.(message);
    }
  }
  if (pending.size) await fail("server exited before answering");
})();

function send(message: Record<string, unknown>) {
  return writer.write(encoder.encode(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"));
}

async function request(method: string, params: Record<string, unknown> = {}) {
  const id = nextId++;
  const answer = new Promise<Message>((resolve) => pending.set(id, resolve));
  await send({ id, method, params });
  const message = await answer;
  pending.delete(id);
  if (message.error) return fail(`${method}: ${message.error.message ?? "error"}`);
  return message.result ?? {};
}

const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "nzip-mcp-check", version: "1" },
});
await send({ method: "notifications/initialized" });
const info = init.serverInfo as { name?: string; version?: string } | undefined;
console.log(`server: ${info?.name} ${info?.version} (protocol ${init.protocolVersion})`);
console.log(`instructions: ${init.instructions ?? "(none)"}`);

const { tools = [] } = await request("tools/list") as { tools?: { name: string }[] };
console.log(`tools: ${tools.map((tool) => tool.name).join(", ")}`);

const call = await request("tools/call", { name: "nzip_status", arguments: {} });
const text = (call.content as { type: string; text?: string }[] | undefined)
  ?.find((part) => part.type === "text")?.text ?? "{}";
const status = JSON.parse(text);
if (call.isError || !status.ok) {
  await fail(`nzip_status: ${status.error ?? text}${status.hint ? ` (hint: ${status.hint})` : ""}`);
}
console.log(`status: ok, server ${status.server}, backend ${status.version}`);
console.log(`default vaults: ${JSON.stringify(status.defaultVaults)}`);
for (const vault of status.vaults ?? []) {
  const policy = [
    `ttl=${vault.effectiveDefaultTtl}`,
    `maxTtl=${vault.maxTtl ?? "none"}`,
    `requirePassword=${vault.requirePassword ?? "unsupported"}`,
    `defaultPassword=${vault.hasDefaultPassword ?? "unsupported"}`,
  ].join(" ");
  console.log(
    `vault ${vault.name}: ${policy}${vault.description ? ` "${vault.description}"` : ""}`,
  );
}

clearTimeout(deadline);
await writer.close();
child.kill();
await child.status;
Deno.exit(0);
