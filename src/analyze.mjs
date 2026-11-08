// Finds the session logs, summarizes each one (cached, so a second run is instant), and adds them
// up into one report: spend, where it went, and the fixes worth making, each priced in dollars.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { summarizeLog } from "./logs.mjs";
import { findAgentLogs, summarizeAgent } from "./agents.mjs";
import { modelName } from "./prices.mjs";

export const TARE_HOME = process.env.TARE_HOME || path.join(os.homedir(), ".tare");
const CACHE_VERSION = "4";

export function findLogs(root = path.join(os.homedir(), ".claude", "projects")) {
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3 && e.name !== "memory") walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

async function cachedSummary(file, st, read = () => summarizeLog(file)) {
  const key = crypto.createHash("sha1").update(`${CACHE_VERSION}|${file}|${st.size}|${st.mtimeMs}`).digest("hex");
  const cf = path.join(TARE_HOME, "cache", key + ".json");
  try {
    return JSON.parse(fs.readFileSync(cf, "utf8"));
  } catch {}
  const s = await read();
  try {
    fs.mkdirSync(path.dirname(cf), { recursive: true });
    fs.writeFileSync(cf, JSON.stringify(s));
  } catch {}
  return s;
}

const bucket = () => ({ n: 0, tokens: 0, usd: 0 });
function addBucket(into, b, k = 1) {
  into.n += b.n;
  into.tokens += b.tokens * k;
  into.usd += b.usd * k;
}
function addMap(into, from, k = 1) {
  for (const [key, b] of Object.entries(from || {})) addBucket((into[key] ||= bucket()), b, k);
}
const top = (map, n = 5, by = "usd") =>
  Object.entries(map)
    .sort((a, b) => (b[1][by] ?? b[1]) - (a[1][by] ?? a[1]))
    .slice(0, n);

// `root` points at a folder of Claude Code logs; `home` is where the other agents' logs are looked for.
// A test that passes only `root` gets only that folder.
export async function analyze({ days = 30, root, home, onStart, onProgress } = {}) {
  const since = days ? Date.now() - days * 86400_000 : 0;
  const sinceDay = days ? new Date(since).toISOString().slice(0, 10) : "";
  const others = root && !home ? [] : findAgentLogs(home);
  const stat = (f) => {
    try {
      return fs.statSync(f);
    } catch {
      return null;
    }
  };
  const files = [...findLogs(root).map((f) => ({ f })), ...others]
    .map((x) => ({ ...x, st: stat(x.f) }))
    .filter(({ st }) => st && st.mtimeMs >= since);

  onStart?.(files.length);
  const summaries = [];
  let done = 0;
  const queue = [...files];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let job; (job = queue.shift()); ) {
        try {
          summaries.push(await cachedSummary(job.f, job.st, job.kind ? () => summarizeAgent(job) : undefined));
        } catch {}
        onProgress?.(++done, files.length);
      }
    }),
  );

  const R = {
    days,
    since: sinceDay,
    files: summaries.length,
    sessions: new Set(),
    projects: {},
    calls: 0,
    unpriced: 0,
    usd: 0,
    cost: { input: 0, write: 0, read: 0, output: 0, thinking: 0, reported: 0 },
    byAgent: {},
    limits: null,
    byModel: {},
    byDay: {},
    byHour: Array(24).fill(0),
    subUsd: 0,
    rebuilds: { idle: bucket(), broken: bucket(), compact: bucket(), model: bucket() },
    startup: { tokens: [], usd: 0, parts: {} },
    tools: {},
    bash: {},
    mcp: {},
    reads: {},
    repeats: { ...bucket(), labels: {} },
    errors: bucket(),
    trim: bucket(),
    biggest: [],
    prompts: 0,
    commits: 0,
    compactions: 0,
    mcpLoaded: {},
    mcpUsed: new Set(),
    skillsUsed: new Set(),
    sessionList: [],
  };

  for (const s of summaries) {
    const full = Object.values(s.byDay).reduce((a, b) => a + b, 0);
    const inWin = Object.entries(s.byDay).reduce((a, [d, v]) => a + (d >= sinceDay ? v : 0), 0);
    if (!s.calls || inWin <= 0) continue;
    const k = full ? inWin / full : 1; // a session that started before the window counts in part
    R.sessions.add(s.session);
    R.calls += s.calls;
    R.unpriced += s.unpriced;
    R.usd += inWin;
    for (const c of Object.keys(R.cost)) R.cost[c] += (s.cost[c] || 0) * k;
    const agent = s.agent || "Claude Code";
    const a = (R.byAgent[agent] ||= { usd: 0, calls: 0, sessions: 0, tokens: 0 });
    a.usd += inWin;
    a.calls += s.calls;
    if (!s.sub) a.sessions++;
    if (s.limits) {
      const L = (R.limits ||= { peak5h: 0, peakWeek: 0, hits: 0, sessions: 0, plan: null });
      L.peak5h = Math.max(L.peak5h, s.limits.peak5h);
      L.peakWeek = Math.max(L.peakWeek, s.limits.peakWeek);
      L.hits += s.limits.hits;
      L.sessions++;
      L.plan = s.limits.plan || L.plan;
    }
    for (const [m, v] of Object.entries(s.byModel)) R.byModel[m] = (R.byModel[m] || 0) + v * k;
    for (const [d, v] of Object.entries(s.byDay)) if (d >= sinceDay) R.byDay[d] = (R.byDay[d] || 0) + v;
    s.byHour.forEach((v, h) => (R.byHour[h] += v * k));
    if (s.sub) R.subUsd += inWin;
    for (const kind of Object.keys(R.rebuilds)) addBucket(R.rebuilds[kind], s.rebuilds[kind], k);
    if (!s.sub && s.startup.tokens) R.startup.tokens.push(s.startup.tokens);
    R.startup.usd += s.startup.usd * k;
    for (const [p, v] of Object.entries(s.startup.parts)) (R.startup.parts[p] ||= []).push(v);
    addMap(R.tools, s.tools, k);
    addMap(R.bash, s.bash, k);
    addMap(R.mcp, s.mcp, k);
    for (const [p, n] of Object.entries(s.reads)) R.reads[p] = (R.reads[p] || 0) + n;
    addBucket(R.repeats, s.repeats, k);
    for (const [l, n] of Object.entries(s.repeats.labels)) R.repeats.labels[l] = (R.repeats.labels[l] || 0) + n;
    addBucket(R.errors, s.errors, k);
    addBucket(R.trim, s.trim, k);
    R.biggest.push(...s.biggest.map((b) => ({ ...b, project: s.project })));
    R.prompts += s.prompts;
    R.commits += s.commits;
    R.compactions += s.compactions;
    for (const m of s.mcpLoaded) R.mcpLoaded[m] = (R.mcpLoaded[m] || 0) + 1;
    for (const m of Object.keys(s.mcp)) R.mcpUsed.add(m);
    for (const sk of s.skillsUsed) R.skillsUsed.add(sk);
    // The receipt measures Claude Code sessions, where Tare's fixes apply.
    if (!s.sub && !s.agent)
      R.sessionList.push({ session: s.session, project: s.project, start: s.start, end: s.end, usd: full, prompts: s.prompts, commits: s.commits, calls: s.calls });
  }
  // Sub-agent cost belongs to the session that started it.
  const bySession = Object.fromEntries(R.sessionList.map((x) => [x.session, x]));
  for (const s of summaries) if (s.sub && bySession[s.session]) bySession[s.session].usd += Object.values(s.byDay).reduce((a, b) => a + b, 0);

  for (const s of summaries) {
    if (!s.project || !s.calls) continue;
    const name = path.basename(s.project);
    R.projects[name] = (R.projects[name] || 0) + Object.entries(s.byDay).reduce((a, [d, v]) => a + (d >= sinceDay ? v : 0), 0);
  }
  R.biggest = R.biggest.sort((a, b) => b.usd - a.usd).slice(0, 5);
  R.sessions = R.sessions.size;
  R.mcpUsed = [...R.mcpUsed];
  R.skillsUsed = [...R.skillsUsed];
  R.startup.median = median(R.startup.tokens);
  R.startup.parts = Object.fromEntries(Object.entries(R.startup.parts).map(([p, v]) => [p, median(v)]));
  // The agent's own instructions and built-in tool definitions never appear in the log, so the
  // listed parts fall short of the measured total; show the rest as its own line.
  const listed = Object.values(R.startup.parts).reduce((a, b) => a + b, 0);
  if (Object.keys(R.startup.parts).length && R.startup.median - listed > 1000) R.startup.parts["built-in instructions and tools"] = R.startup.median - listed;
  delete R.startup.tokens;
  R.fixes = fixes(R);
  R.lines = lines(R);
  return R;
}

export function median(xs) {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

const $ = (x) => (x >= 100 ? `$${Math.round(x).toLocaleString("en-US")}` : `$${x.toFixed(2)}`);
const K = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : String(Math.round(x)));
export { $ as usd, K as ktok };

// Each fix: what it is, what it would have saved in this window, and whether Tare can apply it.
function fixes(R) {
  const out = [];
  if (R.trim.usd > 0.5)
    out.push({
      id: "trim",
      title: "Trim long command output",
      saves: R.trim.usd,
      detail: `${R.trim.n} command outputs were longer than ~2.5k tokens and stayed in context. Tare keeps the errors, the start and the end, and saves the full output to a file the agent can open.`,
      auto: "tare fix applies it",
    });
  if (R.repeats.usd > 5) {
    const [l] = top(Object.fromEntries(Object.entries(R.repeats.labels).map(([k, v]) => [k, { usd: v }])), 1)[0] || [];
    out.push({
      id: "repeat",
      title: "Stop repeated identical calls",
      saves: R.repeats.usd * 0.9,
      auto: false,
      detail: `${R.repeats.n} tool calls returned output the agent already had, byte for byte${l ? ` (most often: ${short(l)})` : ""}. Look for a loop in the prompt or a tool that is polled.`,
    });
  }
  if (R.rebuilds.idle.usd > 0.5)
    out.push({
      id: "idle",
      title: "Stop paying the coffee-break tax",
      saves: R.rebuilds.idle.usd * 0.5,
      detail: `${R.rebuilds.idle.n} times a pause of more than 5 minutes let the prompt cache expire, and the whole conversation was written again: ${$(R.rebuilds.idle.usd)} in all. Tare's status line counts down to the cache going cold and shows what the next message will cost; /compact or /clear before a break. Counted as half saved, since some context is always needed.`,
      auto: "tare fix adds the countdown",
    });
  if (R.rebuilds.broken.usd + R.rebuilds.model.usd > 0.5)
    out.push({
      id: "broken",
      title: "Fix cache breaks",
      saves: R.rebuilds.broken.usd + R.rebuilds.model.usd,
      detail: `${R.rebuilds.broken.n + R.rebuilds.model.n} times the cache was rebuilt mid-task without a break (a model switch, a changed setting or tool list). Switching models mid-session is the usual cause: start a new session instead.`,
      auto: false,
    });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/;
  const allUnused = Object.keys(R.mcpLoaded).filter((m) => !R.mcpUsed.includes(m) && !R.mcpUsed.includes(m.replace(/[^\w-]/g, "_")));
  const unused = allUnused.filter((m) => !uuid.test(m));
  const connectors = allUnused.length - unused.length;
  const skills = R.startup.parts["skills list"] || 0;
  const mcpNotes = R.startup.parts["MCP server notes"] || 0;
  if (R.startup.usd > 1 && (unused.length || skills > 2000)) {
    const share = (skills * 0.5 + mcpNotes * (unused.length / Math.max(1, Object.keys(R.mcpLoaded).length))) / Math.max(1, R.startup.median);
    out.push({
      id: "diet",
      title: "Put the startup context on a diet",
      saves: R.startup.usd * Math.min(0.5, share),
      detail: `Every request carries ~${K(R.startup.median)} tokens before any work: ${Object.entries(R.startup.parts)
        .sort((a, b) => b[1] - a[1])
        .map(([p, v]) => `${p} ${K(v)}`)
        .join(", ")}.${unused.length || connectors ? ` MCP servers loaded but never used: ${[...unused.slice(0, 5), connectors ? `${connectors} claude.ai connector${connectors > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ")}.` : ""} Turn off what you don't use.`,
      auto: false,
    });
  }
  if (R.cost.thinking > R.usd * 0.08)
    out.push({
      id: "effort",
      title: "Match effort to the task",
      saves: R.cost.thinking * 0.3,
      detail: `Thinking was ${$(R.cost.thinking)} (${pct(R.cost.thinking / R.usd)} of spend). Low effort is enough for renames, small edits and running tests; keep high effort for planning and debugging.`,
      auto: false,
    });
  return out.sort((a, b) => b.saves - a.saves);
}

const pct = (x) => `${Math.round(x * 100)}%`;
const short = (p) => (p.length > 48 ? "…" + p.slice(-46) : p);

// The lines people screenshot. Each one is a fact from the logs, never a guess.
function lines(R) {
  const L = [];
  const [model, mUsd] = Object.entries(R.byModel).sort((a, b) => b[1] - a[1])[0] || [];
  if (model) L.push(`${modelName(model)} did ${pct(mUsd / R.usd)} of your spend.`);
  const [file, n] = Object.entries(R.reads).sort((a, b) => b[1] - a[1])[0] || [];
  if (n >= 5) L.push(`Your agent opened ${path.basename(file)} ${n} times.`);
  const [cmd, cb] = top(R.bash, 1)[0] || [];
  if (cb && cb.usd > 1) L.push(`\`${cmd}\` output cost ${$(cb.usd)} just by sitting in context.`);
  if (R.rebuilds.idle.n) L.push(`Coffee-break tax: ${$(R.rebuilds.idle.usd)} re-caching after ${R.rebuilds.idle.n} pauses.`);
  if (R.startup.median) L.push(`~${K(R.startup.median)} tokens load before you type a word.`);
  if (R.subUsd > 0) L.push(`Sub-agents spent ${$(R.subUsd)} (${pct(R.subUsd / R.usd)}).`);
  const [day, dUsd] = Object.entries(R.byDay).sort((a, b) => b[1] - a[1])[0] || [];
  if (day) L.push(`Most expensive day: ${day}, ${$(dUsd)}.`);
  const hour = R.byHour.indexOf(Math.max(...R.byHour));
  if (R.usd) L.push(`Peak hour: ${String(hour).padStart(2, "0")}:00.`);
  if (R.commits) L.push(`${$(R.usd / R.commits)} per commit, ${R.commits} commits.`);
  const agents = Object.entries(R.byAgent).sort((a, b) => b[1].usd - a[1].usd);
  if (agents.length > 1) L.push(`${agents.length} agents: ${agents.map(([n, a]) => `${n} ${$(a.usd)}`).join(", ")}.`);
  if (R.limits?.hits) L.push(`Codex hit your plan's usage limit ${R.limits.hits} time${R.limits.hits > 1 ? "s" : ""}.`);
  else if (R.limits?.peakWeek >= 50) L.push(`Codex used up to ${Math.round(R.limits.peakWeek)}% of your weekly plan limit.`);
  return L;
}
