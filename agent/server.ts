import definitions from "./tools.json" with { type: "json" };

type Json = Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: Json };
const tools = definitions as Tool[];

class ToolError extends Error {}

function asObject(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError("arguments must be an object");
  }
  return value as Json;
}

function stringArg(args: Json, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined) {
    if (required) throw new ToolError(name + " is required");
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError(name + " must be a non-empty string");
  }
  return value;
}

function ttlArg(args: Json): string | undefined {
  const ttl = stringArg(args, "ttl");
  if (ttl && !/^(?:\d+d?|forever|0)$/.test(ttl)) {
    throw new ToolError("ttl must be a number of days or forever");
  }
  return ttl;
}

async function runNzip(args: string[]): Promise<Json> {
  let result: Deno.CommandOutput;
  try {
    result = await new Deno.Command("nzip", {
      args: [...args, "--json"],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    throw new ToolError("could not run nzip: " + (error as Error).message);
  }
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  const body = stdout || stderr;
  try {
    const parsed = JSON.parse(body) as Json;
    if (!result.success || parsed.ok === false) {
      throw new ToolError(String(parsed.error ?? "nzip command failed"));
    }
    return parsed;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(body || "nzip exited with status " + result.code);
  }
}

async function hostHtml(args: Json): Promise<Json> {
  const html = stringArg(args, "html", true)!;
  const target = stringArg(args, "target");
  const ttl = ttlArg(args);
  const password = stringArg(args, "password");
  const dir = await Deno.makeTempDir({ prefix: "nzip-agent-" });
  try {
    await Deno.writeTextFile(dir + "/index.html", html);
    const command = ["push", dir + "/index.html"];
    if (target) command.push(target);
    if (ttl) command.push("--ttl", ttl);
    const hosted = await runNzip(command);
    if (!password) return hosted;
    const address = String(hosted.address ?? "");
    if (!address) throw new ToolError("nzip push did not return an address");
    return await runNzip(["share", address, "--password", password]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

export async function invoke(name: string, input: unknown): Promise<Json> {
  const args = asObject(input);
  if (name === "status") return await runNzip(["status"]);
  if (name === "list_vaults") return await runNzip(["vault", "ls"]);
  if (name === "list_sites") {
    const vault = stringArg(args, "vault");
    return await runNzip(vault ? ["ls", vault] : ["ls"]);
  }
  if (name === "inspect_site") return await runNzip(["share", stringArg(args, "target", true)!]);
  if (name === "host_html") return await hostHtml(args);
  if (name === "configure_site") {
    const target = stringArg(args, "target", true)!;
    const ttl = ttlArg(args);
    const password = args.password;
    if (!ttl && password === undefined) {
      throw new ToolError("configure_site requires ttl or password");
    }
    const command = ["share", target];
    if (ttl) command.push("--ttl", ttl);
    if (password === null) command.push("--no-password");
    else if (typeof password === "string" && password) command.push("--password", password);
    else if (password !== undefined) throw new ToolError("password must be a string or null");
    return await runNzip(command);
  }
  if (name === "download_site") {
    const command = ["download", stringArg(args, "target", true)!];
    const directory = stringArg(args, "directory");
    if (directory) command.push(directory);
    if (args.overwrite === true) command.push("--overwrite");
    else if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") {
      throw new ToolError("overwrite must be a boolean");
    }
    return await runNzip(command);
  }
  if (name === "restore_site") {
    const command = ["revert", stringArg(args, "target", true)!];
    if (args.to !== undefined) {
      if (!Number.isInteger(args.to) || (args.to as number) < 1) {
        throw new ToolError("to must be a positive integer");
      }
      command.push("--to", String(args.to));
    }
    return await runNzip(command);
  }
  if (name === "delete_site") {
    if (args.confirm !== true) throw new ToolError("delete_site requires confirm: true");
    return await runNzip(["rm", stringArg(args, "target", true)!, "--yes"]);
  }
  throw new ToolError("unknown nzip tool: " + name);
}

function rpc(id: unknown, result: Json): Json {
  return { jsonrpc: "2.0", id, result };
}

async function handle(request: Json): Promise<Json | null> {
  const id = request.id;
  if (request.method === "initialize") {
    return rpc(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "nzip", version: "0.1.0" },
    });
  }
  if (request.method === "notifications/initialized") return null;
  if (request.method === "tools/list") return rpc(id, { tools });
  if (request.method === "tools/call") {
    const params = asObject(request.params);
    try {
      const result = await invoke(stringArg(params, "name", true)!, params.arguments ?? {});
      return rpc(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (error) {
      return rpc(id, {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: (error as Error).message }),
        }],
        isError: true,
      });
    }
  }
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
}

let pending = "";
const decoder = new TextDecoder();
const encoder = new TextEncoder();
for await (const chunk of Deno.stdin.readable) {
  pending += decoder.decode(chunk, { stream: true });
  const lines = pending.split(/\r?\n/);
  pending = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const result = await handle(JSON.parse(line) as Json);
      if (result) await Deno.stdout.write(encoder.encode(JSON.stringify(result) + "\n"));
    } catch (error) {
      const failure = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: (error as Error).message },
      };
      await Deno.stdout.write(encoder.encode(JSON.stringify(failure) + "\n"));
    }
  }
}
