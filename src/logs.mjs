// Reads one Claude Code session log (~/.claude/projects/<project>/<session>.jsonl) and returns a
// small summary: what it cost, and where the tokens went. Nothing here calls a model.
//
// Cost of a tool result is its "carry cost": it is written to the prompt cache once, then read
// back on every later API call until the conversation is compacted. A 20k-token test log that
// sits in context for 80 more calls costs far more than the call that produced it.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { readUsage, costOf, priceFor, total } from "./prices.mjs";

export const CHARS_PER_TOKEN = 3.7;
const IMAGE_TOKENS = 1500;
const BIG_REBUILD = 20_000;
export const TRIM_ABOVE = 2500;
export const TRIM_TO = 1200;
const FIVE_MIN = 5 * 60_000;
const HOUR = 60 * 60_000;

const tok = (chars) => Math.round(chars / CHARS_PER_TOKEN);

function resultTokens(content) {
  if (typeof content === "string") return tok(content.length);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (b?.type === "text") n += tok((b.text || "").length);
    else if (b?.type === "image") n += IMAGE_TOKENS;
    else n += tok(JSON.stringify(b ?? "").length);
  }
  return n;
}

// "cd app && FOO=1 npm run test -- --watch" -> "npm run test"
export function commandLabel(cmd) {
  let c = String(cmd || "").trim();
  c = c.replace(/^((cd\s+[^\s;&]+|[A-Za-z_][A-Za-z0-9_]*=[^\s;&]*)\s*(&&|;)?\s*)+/, "");
  const words = c.split(/\s+/).filter(Boolean);
  if (!words.length) return "(empty)";
  const first = path.basename(words[0]);
  const two = new Set(["npm", "pnpm", "yarn", "bun", "npx", "git", "cargo", "go", "docker", "make", "gh", "uv", "pip", "python", "python3", "node", "deno", "kubectl", "terraform", "bunx", "swift", "xcodebuild"]);
  if (two.has(first) && words[1] && !words[1].startsWith("-")) {
    const third = (first === "npm" || first === "pnpm" || first === "yarn" || first === "bun") && words[1] === "run" && words[2];
    return third ? `${first} run ${words[2]}` : `${first} ${words[1]}`.slice(0, 40);
  }
  return first.slice(0, 40);
}

const emptyBucket = () => ({ n: 0, tokens: 0, usd: 0 });
const add = (map, key, tokens, usd, n = 1) => {
  const b = (map[key] ||= emptyBucket());
  b.n += n;
  b.tokens += tokens;
  b.usd += usd;
};

// Sub-agent logs sit under <session>/subagents/, sometimes deeper (…/subagents/workflows/<run>/).
export function logSession(file) {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf("subagents");
  return i > 0 ? { sub: true, session: parts[i - 1] } : { sub: false, session: path.basename(file, ".jsonl") };
}

// A resumed or forked session's log starts with a copy of the earlier one. `skip` holds the ids of
// the API calls that another log already counts: they still shape the context here, but their cost,
// tool output, prompts and commits are not counted again.
export async function summarizeLog(file, { skip } = {}) {
  const { sub, session } = logSession(file);
  const s = {
    file,
    session,
    sub,
    project: null,
    start: null,
    end: null,
    calls: 0,
    unpriced: 0,
    cost: { input: 0, write: 0, read: 0, output: 0, thinking: 0 },
    byModel: {},
    byDay: {},
    byHour: Array(24).fill(0),
    rebuilds: { idle: emptyBucket(), broken: emptyBucket(), compact: emptyBucket(), model: emptyBucket() },
    startup: { tokens: 0, usd: 0, parts: {} },
    tools: {},
    bash: {},
    mcp: {},
    reads: {},
    repeats: { n: 0, tokens: 0, usd: 0, labels: {} },
    errors: emptyBucket(),
    trim: { n: 0, tokens: 0, usd: 0 },
    mcpLoaded: [],
    skillsUsed: [],
    biggest: [],
    prompts: 0,
    commits: 0,
    compactions: 0,
    ids: [], // every API call id in this file, so a copy in another file is counted only once
  };

  // Prompts and compactions belong to whoever owns the reply that follows them.
  const waiting = { prompts: 0, compactions: 0 };
  const settle = (mine) => {
    if (mine) for (const k in waiting) s[k] += waiting[k];
    waiting.prompts = waiting.compactions = 0;
  };
  let copies = 0;
  let ownStart = null;

  const calls = []; // { read, write } $/token rates per call, for carry cost
  const items = []; // { at, tokens, kind, key, label, tool }
  const boundaries = []; // call index where a compaction happened
  const pending = new Map(); // tool_use_id -> { name, input }
  const seenMsg = new Map(); // call id -> what was counted for it, or null for a copy
  let seen = new Set(); // tool + input + output hash, reset on compaction
  const seenParts = new Set();
  let minContext = Infinity;
  let prev = null; // { t, model, used1h }
  let compactedSinceLast = false;

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const t = d.timestamp ? Date.parse(d.timestamp) : null;
    if (t) {
      s.start = s.start == null ? t : Math.min(s.start, t);
      s.end = s.end == null ? t : Math.max(s.end, t);
    }
    if (!s.project && d.cwd) s.project = d.cwd;

    if (d.type === "system" && d.subtype === "compact_boundary") {
      boundaries.push(calls.length);
      seen = new Set();
      compactedSinceLast = true;
      waiting.compactions++;
      continue;
    }

    if (d.type === "attachment") {
      // What the agent loads before any work: system prompt, skills, MCP notes, tools, memory.
      const a = d.attachment || {};
      if (a.type === "mcp_instructions_delta") for (const n of a.addedNames || []) if (!s.mcpLoaded.includes(n)) s.mcpLoaded.push(n);
      const part = {
        prompt_snapshot: "system prompt",
        skill_listing: "skills list",
        mcp_instructions_delta: "MCP server notes",
        deferred_tools_delta: "tool list",
        deferred_tools_record: "tool list",
        agent_listing_delta: "agents list",
        instructions: "CLAUDE.md and memory",
      }[a.type];
      if (part && !seenParts.has(a.type)) {
        seenParts.add(a.type);
        s.startup.parts[part] = (s.startup.parts[part] || 0) + tok(JSON.stringify(a).length);
      }
      continue;
    }

    if (d.type === "assistant") {
      const m = d.message || {};
      const copy = !!(m.id && skip?.has(m.id));
      if (m.id && m.model !== "<synthetic>") settle(!copy);
      for (const b of m.content || []) {
        if (b?.type !== "tool_use") continue;
        pending.set(b.id, { name: b.name, input: b.input || {} });
        if (b.name === "Skill" && b.input?.skill && !s.skillsUsed.includes(b.input.skill)) s.skillsUsed.push(b.input.skill);
        if (!copy && b.name === "Bash" && /\bgit\s+commit\b/.test(b.input?.command || "")) s.commits++;
      }
      if (!m.id || m.model === "<synthetic>") continue;
      if (seenMsg.has(m.id)) {
        // A streamed reply is logged on several lines, and an early one can carry only part of the output.
        const had = seenMsg.get(m.id);
        const more = had && readUsage(m.usage);
        if (more && more.output > had.output) {
          const next = costOf(had.model, { ...had.usage, output: more.output, thinking: Math.max(had.usage.thinking, more.thinking) });
          if (next) {
            const extra = total(next) - total(had.cost);
            s.cost.output += next.output - had.cost.output;
            s.cost.thinking += next.thinking - had.cost.thinking;
            s.byModel[had.model] += extra;
            if (had.day) {
              s.byDay[had.day] += extra;
              s.byHour[had.hour] += extra;
            }
            had.cost = next;
          }
          had.output = more.output;
        }
        continue;
      }
      seenMsg.set(m.id, null);
      const u = readUsage(m.usage);
      if (!u) continue;
      s.ids.push(m.id);
      const c = costOf(m.model, u);
      const p = priceFor(m.model);
      const context = u.input + u.read + u.write5m + u.write1h;
      if (context > 0) minContext = Math.min(minContext, context);
      if (copy) {
        copies++;
        calls.push({ read: 0, write: 0, copy: true });
        prev = { t, model: m.model, used1h: u.write1h > 0 || prev?.used1h };
        compactedSinceLast = false;
        continue;
      }
      if (ownStart == null && t) ownStart = t;
      s.calls++;
      if (!c) {
        s.unpriced++;
        calls.push({ read: 0, write: 0 });
        continue;
      }
      for (const k of Object.keys(s.cost)) s.cost[k] += c[k];
      const usd = total(c);
      s.byModel[m.model] = (s.byModel[m.model] || 0) + usd;
      const day = t ? new Date(t).toISOString().slice(0, 10) : null;
      const hour = t ? new Date(t).getHours() : null;
      if (t) {
        s.byDay[day] = (s.byDay[day] || 0) + usd;
        s.byHour[hour] += usd;
      }
      seenMsg.set(m.id, { model: m.model, usage: u, output: u.output, cost: c, day, hour });
      const rate = { read: p.read / 1e6, write: (p.input * 1.25) / 1e6 };
      calls.push(rate);

      const written = u.write5m + u.write1h;
      if (calls.length > 1 && written > BIG_REBUILD && written > u.read * 0.5) {
        // Most of the prompt was written to the cache again instead of read from it.
        const lost = written * (rate.write - rate.read);
        const gap = prev?.t && t ? t - prev.t : 0;
        const ttl = prev?.used1h ? HOUR : FIVE_MIN;
        const kind = compactedSinceLast ? "compact" : prev && prev.model !== m.model ? "model" : gap > ttl ? "idle" : "broken";
        add(s.rebuilds, kind, written, lost);
      }
      prev = { t, model: m.model, used1h: u.write1h > 0 || prev?.used1h };
      compactedSinceLast = false;
      continue;
    }

    if (d.type === "user") {
      const content = d.message?.content;
      if (typeof content === "string") {
        if (!d.isMeta && !content.startsWith("<")) waiting.prompts++;
        continue;
      }
      if (!Array.isArray(content)) continue;
      let typed = false;
      for (const b of content) {
        if (b?.type === "text" && !d.isMeta && !String(b.text).startsWith("<")) typed = true;
        if (b?.type !== "tool_result") continue;
        const use = pending.get(b.tool_use_id) || { name: "unknown", input: {} };
        const tokens = resultTokens(b.content);
        const item = { at: calls.length, tokens, tool: use.name, error: !!b.is_error, label: use.name };
        if (use.name === "Bash") item.label = commandLabel(use.input.command);
        if (use.name.startsWith("mcp__")) item.server = use.name.split("__")[1];
        if (use.name === "Read" && use.input.file_path) {
          item.label = use.input.file_path;
          s.reads[item.label] = (s.reads[item.label] || 0) + 1;
        }
        // A repeat is the same call returning byte-identical output the agent already had.
        const key = crypto.createHash("sha1").update(use.name).update(JSON.stringify(use.input)).update(JSON.stringify(b.content ?? "")).digest("base64");
        if (seen.has(key) && tokens > 50) item.repeat = true;
        seen.add(key);
        items.push(item);
      }
      if (typed && !d.isMeta) waiting.prompts++;
    }
  }
  settle(true);
  // A copied log's own work starts at its first new call, not at the copied history.
  if (copies && ownStart != null) s.start = ownStart;

  // Carry cost: written once at the next call, then read on each later call up to the next compaction.
  const readSum = [0];
  for (const c of calls) readSum.push(readSum[readSum.length - 1] + c.read);
  for (const it of items) {
    if (it.at >= calls.length) continue; // the session ended before the agent saw it
    const end = boundaries.find((b) => b > it.at) ?? calls.length;
    const usd = it.tokens * (calls[it.at].write + (readSum[end] - readSum[it.at + 1]));
    it.usd = usd;
    // Output that first arrived in copied history is counted where it was first read; only the
    // cost of reading it again here is added.
    const n = calls[it.at].copy ? 0 : 1;
    if (!n && !usd) continue;
    const tokens = n * it.tokens;
    add(s.tools, it.tool, tokens, usd, n);
    if (it.tool === "Bash") add(s.bash, it.label, tokens, usd, n);
    if (it.server) add(s.mcp, it.server, tokens, usd, n);
    if (it.error) add(s, "errors", tokens, usd, n);
    if (it.tool === "Bash" && it.tokens > TRIM_ABOVE) {
      // What trimming to a head, a tail and the failures would have saved.
      s.trim.n += n;
      s.trim.tokens += n * (it.tokens - TRIM_TO);
      s.trim.usd += (usd * (it.tokens - TRIM_TO)) / it.tokens;
    }
    if (it.repeat) {
      s.repeats.n += n;
      s.repeats.tokens += tokens;
      s.repeats.usd += usd;
      const l = it.tool === "Bash" || it.tool === "Read" ? it.label : it.tool;
      if (n) s.repeats.labels[l] = (s.repeats.labels[l] || 0) + 1;
    }
  }
  s.biggest = items
    .filter((i) => i.usd)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 5)
    .map(({ tool, label, tokens, usd }) => ({ tool, label, tokens, usd }));

  // The fixed context (system prompt, tools, skills, memory) rides on every call; the smallest
  // prompt the thread ever sent is a safe lower bound for it.
  if (calls.length && minContext < Infinity) {
    s.startup.tokens = minContext;
    s.startup.usd = s.startup.tokens * (calls[0].write + (readSum[calls.length] - readSum[1]));
  }
  return s;
}
