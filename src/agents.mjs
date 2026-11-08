// Readers for coding agents other than Claude Code. Each one turns a session file into the same
// summary shape logs.mjs builds, so the report adds them up the same way. They read only token
// counts, models, times and plan-limit numbers; never prompts or code.
//
//   Codex CLI   ~/.codex/sessions/**/rollout-*.jsonl     token_count events, plan limits
//   Gemini CLI  ~/.gemini/tmp/*/chats/session-*.json(l)  per-message token counts
//   Cline, Roo Code, Kilo Code, in VS Code, Cursor, Windsurf and other VS Code-based editors:
//               <editor>/User/globalStorage/<extension>/tasks/*/ui_messages.json  (cost as the tool reports it)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { priceFor } from "./prices.mjs";

export function emptySummary(agent, file, session) {
  const b = () => ({ n: 0, tokens: 0, usd: 0 });
  return {
    agent,
    file,
    session,
    sub: false,
    project: null,
    start: null,
    end: null,
    calls: 0,
    unpriced: 0,
    cost: { input: 0, write: 0, read: 0, output: 0, thinking: 0, reported: 0 },
    tokens: { input: 0, cached: 0, output: 0 },
    byModel: {},
    byDay: {},
    byHour: Array(24).fill(0),
    rebuilds: { idle: b(), broken: b(), compact: b(), model: b() },
    startup: { tokens: 0, usd: 0, parts: {} },
    tools: {},
    bash: {},
    mcp: {},
    reads: {},
    repeats: { ...b(), labels: {} },
    errors: b(),
    trim: b(),
    mcpLoaded: [],
    skillsUsed: [],
    biggest: [],
    prompts: 0,
    commits: 0,
    compactions: 0,
    limits: null,
  };
}

// Price one call from plain token counts. `input` includes the cached part, as OpenAI and Google report it.
function price(model, { input = 0, cached = 0, write = 0, output = 0, thinking = 0 }) {
  const p = priceFor(model);
  if (!p) return null;
  const tier = p.over && input > p.over.above ? p.over : p;
  const m = (x, rate) => (x * rate) / 1e6;
  return {
    input: m(Math.max(0, input - cached - write), tier.input),
    write: m(write, tier.write ?? tier.input),
    read: m(cached, tier.read),
    output: m(output, tier.output),
    thinking: m(thinking, tier.output),
  };
}

function record(s, { ts, model, cost, tokens }) {
  const t = ts ? new Date(ts) : null;
  if (!t || isNaN(t)) return;
  s.calls++;
  s.start = s.start && s.start < t.toISOString() ? s.start : t.toISOString();
  s.end = s.end && s.end > t.toISOString() ? s.end : t.toISOString();
  if (tokens) for (const k of Object.keys(s.tokens)) s.tokens[k] += tokens[k] || 0;
  if (!cost) return void s.unpriced++;
  let usd = 0;
  for (const [k, v] of Object.entries(cost)) {
    s.cost[k] += v;
    usd += k === "thinking" ? 0 : v; // thinking is already inside output
  }
  const day = t.toISOString().slice(0, 10);
  s.byDay[day] = (s.byDay[day] || 0) + usd;
  s.byHour[t.getHours()] += usd;
  s.byModel[model || s.agent] = (s.byModel[model || s.agent] || 0) + usd;
}

async function* lines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

// --- Codex CLI ---------------------------------------------------------------------------------
export async function summarizeCodex(file) {
  const s = emptySummary("Codex CLI", file, path.basename(file, ".jsonl"));
  let model = null;
  let prevTotal = 0;
  const limits = { peak5h: 0, peakWeek: 0, hits: 0, plan: null };
  for await (const e of lines(file)) {
    const p = e.payload || {};
    if (e.type === "session_meta") {
      s.project = p.cwd || s.project;
      if (p.id) s.session = p.id;
    } else if (e.type === "turn_context") {
      model = p.model || model;
      s.project ||= p.cwd || null;
    } else if (e.type === "response_item" && p.type === "message" && p.role === "user") s.prompts++;
    else if (e.type === "event_msg" && p.type === "token_count") {
      const rl = p.rate_limits;
      if (rl) {
        for (const w of [rl.primary, rl.secondary]) {
          if (!w) continue;
          if (w.window_minutes && w.window_minutes <= 360) limits.peak5h = Math.max(limits.peak5h, w.used_percent || 0);
          else limits.peakWeek = Math.max(limits.peakWeek, w.used_percent || 0);
        }
        if (rl.rate_limit_reached_type) limits.hits++;
        limits.plan = rl.plan_type || limits.plan;
      }
      const info = p.info;
      if (!info?.last_token_usage) continue;
      // The same count can be sent twice; only a growing total is a new call.
      const total = info.total_token_usage?.total_tokens ?? 0;
      if (total && total <= prevTotal) continue;
      prevTotal = total;
      const u = info.last_token_usage;
      const t = { input: u.input_tokens || 0, cached: u.cached_input_tokens || 0, write: u.cache_write_input_tokens || 0, output: u.output_tokens || 0, thinking: u.reasoning_output_tokens || 0 };
      record(s, { ts: e.timestamp, model, cost: price(model, t), tokens: { input: t.input, cached: t.cached, output: t.output } });
    }
  }
  if (limits.peak5h || limits.peakWeek || limits.hits) s.limits = limits;
  return s;
}

// --- Gemini CLI --------------------------------------------------------------------------------
export async function summarizeGemini(file) {
  const s = emptySummary("Gemini CLI", file, path.basename(file).replace(/\.jsonl?$/, ""));
  const msgs = new Map();
  const take = (m) => m && m.id && msgs.set(m.id, { ...msgs.get(m.id), ...m });
  if (file.endsWith(".json")) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return s;
    }
    if (doc.sessionId) s.session = doc.sessionId;
    for (const m of doc.messages || []) take(m);
  } else {
    for await (const r of lines(file)) {
      if (r.sessionId) s.session = r.sessionId;
      if (Array.isArray(r.$set?.messages)) {
        msgs.clear();
        r.$set.messages.forEach(take);
      } else if (Array.isArray(r.messages)) r.messages.forEach(take);
      else take(r);
    }
  }
  for (const m of msgs.values()) {
    if (m.type === "user") s.prompts++;
    if (m.type !== "gemini" || !m.tokens) continue;
    const k = m.tokens;
    const t = { input: (k.input || 0) + (k.tool || 0), cached: k.cached || 0, output: (k.output || 0) + (k.thoughts || 0), thinking: k.thoughts || 0 };
    record(s, { ts: m.timestamp, model: m.model, cost: price(m.model, t), tokens: { input: t.input, cached: t.cached, output: t.output } });
  }
  return s;
}

// --- Cline, Roo Code, Kilo Code ----------------------------------------------------------------
export async function summarizeCline(file, agent = "Cline") {
  const dir = path.dirname(file);
  const s = emptySummary(agent, file, path.basename(dir));
  let msgs;
  try {
    msgs = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return s;
  }
  let model = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "task_metadata.json"), "utf8"));
    model = meta.model_usage?.at(-1)?.model_id || null;
  } catch {}
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (m.type === "say" && (m.say === "task" || m.say === "user_feedback")) s.prompts++;
    if (m.type !== "say" || m.say !== "api_req_started" || !m.text) continue;
    let r;
    try {
      r = JSON.parse(m.text);
    } catch {
      continue;
    }
    if (r.tokensIn == null && r.cost == null) continue;
    const tokens = { input: (r.tokensIn || 0) + (r.cacheReads || 0) + (r.cacheWrites || 0), cached: r.cacheReads || 0, output: r.tokensOut || 0 };
    // Cline prices each call itself, with the provider it used; trust that over a guess.
    const cost = typeof r.cost === "number" ? { reported: r.cost } : price(model, { ...tokens, write: r.cacheWrites || 0 });
    record(s, { ts: m.ts, model, cost, tokens });
  }
  return s;
}

// --- finding the files -------------------------------------------------------------------------
function walk(dir, depth, test, out) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, test, out);
    else if (e.isFile() && test(e.name, p)) out.push(p);
  }
  return out;
}

const EDITORS = ["Code", "Code - Insiders", "Cursor", "Windsurf", "VSCodium", "Trae", "Kiro", "Positron", "Void"];
const EXTENSIONS = { "saoudrizwan.claude-dev": "Cline", "rooveterinaryinc.roo-cline": "Roo Code", "kilocode.kilo-code": "Kilo Code" };

function appSupport(home) {
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support");
  if (process.platform === "win32") return process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
}

// Every non-Claude session file on this machine, with the reader that understands it.
export function findAgentLogs(home = os.homedir()) {
  const out = [];
  const codexHome = process.env.CODEX_HOME && home === os.homedir() ? process.env.CODEX_HOME : path.join(home, ".codex");
  for (const sub of ["sessions", "archived_sessions"])
    for (const f of walk(path.join(codexHome, sub), 4, (n) => /^rollout-.*\.jsonl$/.test(n), [])) out.push({ f, kind: "codex", agent: "Codex CLI" });
  for (const f of walk(path.join(home, ".gemini", "tmp"), 4, (n, p) => /^session-.*\.jsonl?$/.test(n) && p.includes(`${path.sep}chats${path.sep}`), []))
    out.push({ f, kind: "gemini", agent: "Gemini CLI" });
  const base = appSupport(home);
  for (const ed of EDITORS)
    for (const [ext, name] of Object.entries(EXTENSIONS))
      for (const f of walk(path.join(base, ed, "User", "globalStorage", ext, "tasks"), 1, (n) => n === "ui_messages.json", []))
        out.push({ f, kind: "cline", agent: ed === "Code" ? name : `${name} in ${ed}` });
  for (const f of walk(path.join(home, ".cline", "data", "tasks"), 1, (n) => n === "ui_messages.json", [])) out.push({ f, kind: "cline", agent: "Cline CLI" });
  return out;
}

export function summarizeAgent({ f, kind, agent }) {
  if (kind === "codex") return summarizeCodex(f);
  if (kind === "gemini") return summarizeGemini(f);
  return summarizeCline(f, agent);
}
