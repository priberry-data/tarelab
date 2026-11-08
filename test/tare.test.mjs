import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tare-test-"));
process.env.TARE_HOME = path.join(tmp, ".tare");

const { priceFor, readUsage, costOf, total, modelName } = await import("../src/prices.mjs");
const { summarizeLog, commandLabel } = await import("../src/logs.mjs");
const { analyze } = await import("../src/analyze.mjs");
const { trimText, trimHook, statusLine } = await import("../src/guard.mjs");
const { compare, receipt } = await import("../src/receipt.mjs");
const { cardSvg } = await import("../src/card.mjs");

const T0 = Date.parse("2026-11-01T10:00:00Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const assistant = (id, min, usage, content = [], model = "claude-opus-5-5") => ({
  type: "assistant", timestamp: at(min), cwd: "/work/demo", requestId: "r" + id,
  message: { id: "m" + id, model, content, usage },
});
const usage = (read, write, out = 100) => ({ input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out });
const bash = (id, command) => ({ type: "tool_use", id, name: "Bash", input: { command } });
const result = (id, min, text) => ({ type: "user", timestamp: at(min), message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });

function writeLog(name, rows) {
  const dir = path.join(tmp, "projects", "-work-demo");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return f;
}

test("prices and model names", () => {
  assert.deepEqual(priceFor("claude-opus-5-5"), { input: 4, output: 20, read: 0.2 });
  assert.equal(priceFor("claude-fable-5-1").read, 0.25);
  assert.equal(priceFor("claude-fable-5").read, 1);
  assert.equal(priceFor("gpt-9"), null);
  assert.equal(modelName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelName("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
});

test("usage is summed over iterations, and cache writes are priced by TTL", () => {
  const u = readUsage({ input_tokens: 0, output_tokens: 0, iterations: [{ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 400, cache_creation: { ephemeral_1h_input_tokens: 400 } }] });
  assert.equal(u.read, 1000);
  assert.equal(u.write1h, 400);
  const c = costOf("claude-opus-5-5", u);
  assert.ok(Math.abs(c.write - (400 * 8) / 1e6) < 1e-12); // 1-hour writes cost 2x input
  assert.ok(Math.abs(total(c) - (10 * 4 + 400 * 8 + 1000 * 0.2 + 5 * 20) / 1e6) < 1e-12);
});

test("command labels skip cd and env assignments", () => {
  assert.equal(commandLabel("cd app && FOO=1 npm run test -- --watch"), "npm run test");
  assert.equal(commandLabel("cd ~/x; git status"), "git status");
  assert.equal(commandLabel("sed -n 1,20p a.js"), "sed");
});

test("a session log: dedupe, carry cost, repeats and an idle cache rebuild", async () => {
  const big = "x".repeat(37_000); // ~10k tokens
  const f = writeLog("s1.jsonl", [
    { type: "user", timestamp: at(0), message: { content: "fix the tests" } },
    assistant(1, 0, usage(0, 30_000), [bash("t1", "npm test")]),
    assistant(1, 0, usage(0, 30_000), [bash("t1", "npm test")]), // same message logged twice
    result("t1", 1, big),
    assistant(2, 1, usage(30_000, 10_000), [bash("t2", "npm test")]),
    result("t2", 2, big), // identical output: a repeat
    assistant(3, 2, usage(40_000, 10_000)),
    assistant(4, 30, usage(0, 50_000)), // 28 minutes later: the cache had expired
  ]);
  const s = await summarizeLog(f);
  assert.equal(s.calls, 4);
  assert.equal(s.prompts, 1);
  assert.equal(s.rebuilds.idle.n, 1);
  assert.equal(s.rebuilds.broken.n, 0);
  assert.equal(s.repeats.n, 1);
  assert.equal(s.trim.n, 2);
  // the first output is written once, then read on calls 3 and 4
  const tokens = s.tools.Bash.tokens / 2;
  const expected = tokens * ((4 * 1.25) / 1e6 + (0.2 / 1e6) * 2);
  assert.ok(s.biggest[0].usd > 0);
  assert.ok(Math.abs(s.biggest[0].usd - expected) < 1e-9, `${s.biggest[0].usd} vs ${expected}`);
});

test("analyze adds sessions up and prices the fixes", async () => {
  const R = await analyze({ days: 0, root: path.join(tmp, "projects") });
  assert.equal(R.sessions, 1);
  assert.ok(R.usd > 0);
  assert.equal(R.rebuilds.idle.n, 1);
  assert.ok(Array.isArray(R.fixes));
  assert.ok(R.lines.length > 0);
  const svg = cardSvg(R);
  assert.match(svg, /^<svg/);
  assert.doesNotMatch(svg, /\/work\/demo/); // no paths on the card
});

test("trimText keeps the failure, the head and the tail", () => {
  const lines = Array.from({ length: 2000 }, (_, i) => (i === 900 ? "FAIL test 900: expected 1 got 2" : `ok ${i}`));
  const r = trimText(lines.join("\n"));
  assert.ok(r);
  assert.match(r.text, /FAIL test 900/);
  assert.match(r.text, /^ok 0/);
  assert.match(r.text, /ok 1999$/);
  assert.ok(r.text.length < lines.join("\n").length / 3);
  assert.equal(trimText("short"), null);
});

test("trim hook only touches long Bash output and keeps the rest of the response", () => {
  const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  const out = trimHook({ session_id: "s", tool_use_id: "t", tool_name: "Bash", tool_input: { command: "make" }, tool_response: { stdout: long, stderr: "", interrupted: false, isImage: false } });
  const u = out.hookSpecificOutput.updatedToolOutput;
  assert.equal(u.interrupted, false);
  assert.match(u.stdout, /Full output: .*\.log/);
  const file = /Full output: (\S+\.log)/.exec(u.stdout)[1];
  assert.match(fs.readFileSync(file, "utf8"), /line 2999/);
  assert.equal(trimHook({ tool_name: "Read", tool_response: { stdout: long } }), null);
});

test("status line counts down and prices a cold cache", () => {
  const f = writeLog("live.jsonl", [assistant(9, 0, usage(100_000, 2_000))]);
  const warm = statusLine({ transcript_path: f }, T0 + 2 * 60_000);
  assert.match(warm, /cache warm .*3:00/);
  const cold = statusLine({ transcript_path: f }, T0 + 20 * 60_000);
  assert.match(cold, /cache cold/);
  assert.match(cold, /\$0\.51/); // 102k tokens rewritten at $5/M
});

test("receipt refuses to call it without enough data, and finds a real 30% saving", () => {
  const mk = (n, usdPerCommit, startDay) =>
    Array.from({ length: n }, (_, i) => ({ session: `x${startDay}${i}`, start: Date.UTC(2026, 9, startDay + i), end: Date.UTC(2026, 9, startDay + i) + 3600_000, usd: usdPerCommit * 2 * (0.9 + (i % 3) * 0.1), commits: 2 }));
  const installedAt = Date.UTC(2026, 9, 20);
  const few = receipt({ sessionList: [...mk(3, 10, 1), ...mk(3, 7, 21)] }, { installedAt });
  assert.equal(few.verdict, "not-enough-data");
  const r = receipt({ sessionList: [...mk(15, 10, 1), ...mk(15, 7, 21)] }, { installedAt });
  assert.equal(r.verdict, "saving");
  assert.ok(Math.abs(r.change.point + 0.3) < 0.02);
  assert.ok(r.workHeld);
  const c = compare(mk(15, 10, 1), mk(15, 10, 21));
  assert.ok(c.lo < 1 && c.hi > 1); // no change -> the range straddles zero
});

test("other agents: Codex, Gemini and Cline sessions are read, priced and added up", async () => {
  const { analyze } = await import("../src/analyze.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tare-home-"));
  const now = new Date();
  const ts = (min) => new Date(now.getTime() - min * 60_000).toISOString();

  // Codex: two calls, one count sent twice, plan limits in the events.
  const cdir = path.join(home, ".codex", "sessions", "2026", "11", "08");
  fs.mkdirSync(cdir, { recursive: true });
  const usage = (input, cached, output, total) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: total });
  const tc = (min, last, total, used) => ({
    timestamp: ts(min),
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: { total_tokens: total } }, rate_limits: { primary: { used_percent: used, window_minutes: 300 }, secondary: { used_percent: used / 2, window_minutes: 10080 } } },
  });
  const codex = [
    { timestamp: ts(30), type: "session_meta", payload: { id: "c1", cwd: "/work/app" } },
    { timestamp: ts(30), type: "turn_context", payload: { model: "gpt-5.3-codex", cwd: "/work/app" } },
    { timestamp: ts(29), type: "response_item", payload: { type: "message", role: "user", content: [] } },
    tc(28, usage(1_000_000, 800_000, 100_000, 1_100_000), 1_100_000, 40),
    tc(27, usage(1_000_000, 800_000, 100_000, 1_100_000), 1_100_000, 40),
    tc(26, usage(1_000_000, 900_000, 0, 1_000_000), 2_100_000, 90),
  ];
  fs.writeFileSync(path.join(cdir, "rollout-x.jsonl"), codex.map((e) => JSON.stringify(e)).join("\n"));

  // Gemini: one priced reply in a .json session.
  const gdir = path.join(home, ".gemini", "tmp", "proj", "chats");
  fs.mkdirSync(gdir, { recursive: true });
  fs.writeFileSync(
    path.join(gdir, "session-1.json"),
    JSON.stringify({ sessionId: "g1", messages: [{ id: "a", type: "user", timestamp: ts(20) }, { id: "b", type: "gemini", model: "gemini-2.5-flash", timestamp: ts(19), tokens: { input: 1_000_000, output: 100_000, cached: 0, thoughts: 0, total: 1_100_000 } }] }),
  );

  // Cline in Cursor: cost as Cline reported it.
  const base = process.platform === "darwin" ? path.join(home, "Library", "Application Support") : path.join(home, ".config");
  const tdir = path.join(base, "Cursor", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks", "t1");
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(
    path.join(tdir, "ui_messages.json"),
    JSON.stringify([
      { ts: now.getTime() - 600_000, type: "say", say: "task", text: "x" },
      { ts: now.getTime() - 590_000, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 10, tokensOut: 5, cacheReads: 0, cacheWrites: 0, cost: 1.5 }) },
    ]),
  );

  const prev = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  const R = await analyze({ days: 30, root: path.join(home, "no-claude-here"), home });
  if (prev) process.env.XDG_CONFIG_HOME = prev;

  // Codex: (200k fresh x 1.75 + 800k cached x 0.175 + 100k out x 14) + (100k x 1.75 + 900k x 0.175) per million
  const codexUsd = (200_000 * 1.75 + 800_000 * 0.175 + 100_000 * 14 + 100_000 * 1.75 + 900_000 * 0.175) / 1e6;
  const geminiUsd = (1_000_000 * 0.3 + 100_000 * 2.5) / 1e6;
  assert.ok(Math.abs(R.byAgent["Codex CLI"].usd - codexUsd) < 1e-9, `codex ${R.byAgent["Codex CLI"]?.usd}`);
  assert.equal(R.byAgent["Codex CLI"].calls, 2, "a count sent twice is one call");
  assert.ok(Math.abs(R.byAgent["Gemini CLI"].usd - geminiUsd) < 1e-9);
  assert.equal(R.byAgent["Cline in Cursor"].usd, 1.5);
  assert.equal(R.cost.reported, 1.5);
  assert.equal(R.limits.peak5h, 90);
  assert.equal(R.limits.peakWeek, 45);
  assert.ok(R.lines.some((l) => /3 agents/.test(l)));
  assert.equal(R.sessionList.length, 0, "the receipt only counts Claude Code sessions");
});

test("setup adds a pinned MCP entry to each app found, leaves the rest alone, and undoes cleanly", async () => {
  const { setup } = await import("../src/clients.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tare-setup-"));
  const app = process.platform === "darwin" ? path.join(home, "Library", "Application Support") : path.join(home, ".config");
  fs.mkdirSync(path.join(home, ".cursor"));
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  fs.mkdirSync(path.join(app, "Code", "User"), { recursive: true });
  const vsc = '{\n  // mine\n  "servers": {}\n}\n';
  fs.writeFileSync(path.join(app, "Code", "User", "mcp.json"), vsc);
  fs.mkdirSync(path.join(home, ".codex"));
  const toml = 'model = "gpt-5.3-codex"\n\n[mcp_servers.other]\ncommand = "y"\n';
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), toml);
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  const prevCodex = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  const opts = { name: "tare", pkg: "tarelab", version: "9.9.9", home, backupDir: path.join(home, "bk"), claudeCli: false };

  const rows = setup(opts);
  const by = Object.fromEntries(rows.map((r) => [r.client, r.status]));
  assert.equal(by.Cursor, "added");
  assert.equal(by["VS Code"], "skipped", "a file with comments is never rewritten");
  assert.equal(by.Codex, "added");
  assert.equal(by.opencode, "added");
  assert.equal(by.Windsurf, undefined, "apps that aren't installed are left out");
  const cursor = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(cursor.mcpServers.tare, { command: "npx", args: ["-y", "tarelab@9.9.9", "mcp"] });
  assert.ok(cursor.mcpServers.other);
  assert.equal(fs.readFileSync(path.join(app, "Code", "User", "mcp.json"), "utf8"), vsc);
  assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.tare\]\ncommand = "npx"\nargs = \["-y", "tarelab@9\.9\.9", "mcp"\]/);
  const oc = JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8"));
  assert.deepEqual(oc.mcp.tare.command, ["npx", "-y", "tarelab@9.9.9", "mcp"]);

  assert.ok(setup(opts).filter((r) => r.status !== "skipped").every((r) => r.status === "already there"), "running it twice changes nothing");

  setup({ ...opts, undo: true });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers), ["other"]);
  assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8").trim(), toml.trim());
  if (prevCodex) process.env.CODEX_HOME = prevCodex;
});
