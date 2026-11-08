// Tare as an MCP server (stdio, newline-delimited JSON-RPC), so any agent or editor that speaks MCP
// can ask what it costs. No dependencies: the protocol surface used here is small.
import readline from "node:readline";
import { analyze } from "./analyze.mjs";
import { receipt } from "./receipt.mjs";
import { lastCall } from "./guard.mjs";
import { priceFor } from "./prices.mjs";

const TOOLS = [
  {
    name: "tare_wrapped",
    description: "Where this machine's coding-agent tokens and money went (Claude Code, Codex CLI, Gemini CLI, Cline, Roo Code, Kilo Code): API-equivalent spend, plan-limit use, what filled the context, cache rebuilds, highlights and the top fixes with estimated savings. Local and free.",
    inputSchema: { type: "object", properties: { days: { type: "number", description: "Window in days; 0 for all time. Default 30." } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "tare_receipt",
    description: "Cost per commit before and after Tare's fixes were installed, with a 90% range, or a plain 'not enough data yet'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "tare_cache",
    description: "For one session transcript: context size, whether the prompt cache is still warm, and what the next message will cost warm versus cold.",
    inputSchema: { type: "object", properties: { transcript_path: { type: "string" } }, required: ["transcript_path"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

const round = (x) => Math.round(x * 100) / 100;

async function call(name, args = {}) {
  if (name === "tare_wrapped") {
    const R = await analyze({ days: args.days ?? 30 });
    return {
      window_days: R.days, sessions: R.sessions, api_calls: R.calls, usd_api_equivalent: round(R.usd),
      cost: Object.fromEntries(Object.entries(R.cost).map(([k, v]) => [k, round(v)])),
      context_fill: Object.fromEntries([["startup", round(R.startup.usd)], ...Object.entries(R.tools).sort((a, b) => b[1].usd - a[1].usd).slice(0, 6).map(([k, v]) => [k, round(v.usd)])]),
      cache_rebuilds: Object.fromEntries(Object.entries(R.rebuilds).map(([k, v]) => [k, { n: v.n, usd: round(v.usd) }])),
      highlights: R.lines,
      fixes: R.fixes.map((f) => ({ ...f, saves: round(f.saves) })),
      note: "API list prices; on a subscription this is what the work would cost on the API.",
    };
  }
  if (name === "tare_receipt") return receipt(await analyze({ days: 0 }));
  if (name === "tare_cache") {
    const last = lastCall(args.transcript_path);
    if (!last) return { error: "no API calls found in that transcript" };
    const p = priceFor(last.model);
    const left = last.ttl - (Date.now() - last.t);
    return {
      model: last.model, context_tokens: last.context, cache_warm: left > 0, seconds_left: Math.max(0, Math.round(left / 1000)),
      next_message_usd_warm: p && round((last.context * p.read) / 1e6), next_message_usd_cold: p && round((last.context * p.input * 1.25) / 1e6),
    };
  }
  throw new Error(`unknown tool ${name}`);
}

export function serve({ version, input = process.stdin, output = process.stdout } = {}) {
  const send = (msg) => output.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: "parse error" } });
    }
    if (m.id === undefined) return; // notifications need no answer
    try {
      if (m.method === "initialize")
        return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tare", version } } });
      if (m.method === "ping") return send({ id: m.id, result: {} });
      if (m.method === "tools/list") return send({ id: m.id, result: { tools: TOOLS } });
      if (m.method === "tools/call") {
        try {
          const r = await call(m.params?.name, m.params?.arguments);
          return send({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], structuredContent: r } });
        } catch (e) {
          return send({ id: m.id, result: { content: [{ type: "text", text: `tare: ${e.message}` }], isError: true } });
        }
      }
      send({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
    } catch (e) {
      send({ id: m.id, error: { code: -32603, message: e.message } });
    }
  });
  return new Promise((resolve) => rl.on("close", resolve));
}
