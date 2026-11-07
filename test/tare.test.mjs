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
