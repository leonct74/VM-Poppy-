// VM-Poppy backend sidecar — the HTTP surface the host proxies frontend calls to,
// plus the teardown hook. Spawned by AgentsPoppy with AGENTSPOPPY_BOOTSTRAP; listens
// on the injected loopback port. See DESIGN.md §3, §13.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EC2Client } from "@aws-sdk/client-ec2";
import { readBootstrap, brokerCredentialsProvider } from "./boot";
import { Ec2Service } from "./ec2";
import { listConfigs, saveConfig, deleteConfig } from "./configs";
import type { VmConfig } from "./types";

const boot = readBootstrap();
const credentials = brokerCredentialsProvider(boot);
const ec2Client = new EC2Client({ region: boot.account.region, credentials });
const svc = new Ec2Service(ec2Client, {
  accountId: boot.account.accountId,
  connectionId: boot.connectionId,
  region: boot.account.region,
});

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** One calm error line (what happened) for the UI — never a raw stack. */
function errorMessage(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.length > 400 ? m.slice(0, 400) : m;
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);

    // Health / meta
    if (method === "GET" && (parts.length === 0 || parts[0] === "health")) return json(res, 200, { ok: true });
    if (method === "GET" && parts[0] === "meta") {
      return json(res, 200, { account: boot.account, connectionId: boot.connectionId });
    }

    // Configs (local templates)
    if (parts[0] === "configs") {
      if (method === "GET" && parts.length === 1) return json(res, 200, { configs: listConfigs() });
      if (method === "POST" && parts.length === 1) {
        const body = (await readBody(req)) as { config?: VmConfig } | VmConfig | undefined;
        const config = (body as { config?: VmConfig })?.config ?? (body as VmConfig);
        if (!config?.id || !config?.name) return json(res, 400, { error: "A config needs at least an id and a name." });
        return json(res, 200, { configs: saveConfig(config) });
      }
      if (method === "DELETE" && parts.length === 2) return json(res, 200, { configs: deleteConfig(parts[1]!) });
    }

    // VMs (live EC2 state)
    if (parts[0] === "vms") {
      if (method === "GET" && parts.length === 1) return json(res, 200, { vms: await svc.listVms() });
      if (method === "POST" && parts[1] === "launch" && parts.length === 2) {
        const body = (await readBody(req)) as { config?: VmConfig } | undefined;
        const config = body?.config;
        if (!config) return json(res, 400, { error: "Missing VM configuration." });
        if (config.id && config.name) saveConfig(config); // remember the template
        const vm = await svc.launch(config);
        return json(res, 200, { vm });
      }
      if (parts.length >= 2) {
        const id = parts[1]!;
        // installState now returns { state, packages } — pass it through whole so the
        // card can name any package that failed to install.
        if (method === "GET" && parts[2] === "install") return json(res, 200, await svc.installState(id));
        if (method === "GET" && parts[2] === "password") return json(res, 200, await svc.windowsPassword(id));
        if (method === "GET" && parts[2] === "key") {
          const keyName = url.searchParams.get("keyName");
          if (!keyName) return json(res, 400, { error: "keyName is required." });
          const pem = svc.getPrivateKey(keyName);
          return pem ? json(res, 200, { keyName, pem }) : json(res, 404, { error: "Key not found on this machine." });
        }
        if (method === "POST" && parts[2] === "stop") { await svc.stop(id); return json(res, 200, { ok: true }); }
        if (method === "POST" && parts[2] === "start") { await svc.start(id); return json(res, 200, { ok: true }); }
        if (method === "POST" && parts[2] === "terminate") { await svc.terminate(id); return json(res, 200, { ok: true }); }
      }
    }

    // Teardown hook (host POSTs this at the start of teardown; MUST be idempotent)
    if (method === "POST" && parts[0] === "teardown" && parts.length === 1) {
      return json(res, 200, { ok: true, removed: await svc.teardown() });
    }

    return json(res, 404, { error: `No route for ${method} /${parts.join("/")}` });
  } catch (e) {
    return json(res, 500, { error: errorMessage(e) });
  }
});

const port = boot.port ?? (process.env.PORT ? Number(process.env.PORT) : 0);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`[vmpoppy] backend listening on 127.0.0.1:${actual} (region ${boot.account.region})`);
});
