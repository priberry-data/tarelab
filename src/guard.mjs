// The live pieces Claude Code runs as hooks and as the status line. Every one fails open: if
// anything goes wrong, the agent sees exactly what it would have seen without Tare.
//
//   tare guard trim        PostToolUse on Bash: long output is cut to the errors, a head and a
//                          tail, and the full text is saved to a file the agent can open.
//   tare guard statusline  The status line: cache warmth countdown and what a cold cache costs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TARE_HOME } from "./analyze.mjs";
import { CHARS_PER_TOKEN } from "./logs.mjs";
import { readUsage, priceFor, modelName } from "./prices.mjs";

export const TRIM = { aboveTokens: 2500, headLines: 40, tailLines: 60, maxErrorLines: 80 };
const ERROR_LINE = /\b(error|errors|failed|failure|fail|FAIL|panic|exception|traceback|assert|expected|✗|✘|×)\b/i;

const readStdin = () =>
  new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => resolve(s));
    setTimeout(() => resolve(s), 3000).unref();
  });

export async function runGuard(which) {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    return;
  }
  if (which === "trim") {
    const out = trimHook(input);
    if (out) process.stdout.write(JSON.stringify(out));
  } else if (which === "statusline") {
    process.stdout.write(statusLine(input));
  }
}

// Keeps what an agent needs from a long log: the first lines (what ran), every line that looks
// like a failure with a little context, and the last lines (the summary). Returns null if the
// text is short enough to leave alone.
export function trimText(text, opts = TRIM) {
  if (!text || text.length / CHARS_PER_TOKEN <= opts.aboveTokens) return null;
  const lines = text.split("\n");
  if (lines.length <= opts.headLines + opts.tailLines) {
    // Few, very long lines (minified output, a JSON blob): cut by characters instead.
    const keep = Math.round(opts.aboveTokens * CHARS_PER_TOKEN * 0.4);
    return { text: `${text.slice(0, keep)}\n…\n${text.slice(-keep)}`, dropped: text.length - 2 * keep };
  }
  const keep = new Set();
  for (let i = 0; i < opts.headLines; i++) keep.add(i);
  for (let i = lines.length - opts.tailLines; i < lines.length; i++) keep.add(i);
  let errs = 0;
  for (let i = opts.headLines; i < lines.length - opts.tailLines && errs < opts.maxErrorLines; i++) {
    if (ERROR_LINE.test(lines[i])) {
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 3); j++) keep.add(j);
      errs++;
    }
  }
  const out = [];
  let gap = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (gap) out.push(`… ${gap} line${gap > 1 ? "s" : ""} trimmed by tare …`);
      gap = 0;
      out.push(lines[i]);
    } else gap++;
  }
  const t = out.join("\n");
  return t.length < text.length * 0.8 ? { text: t, dropped: text.length - t.length } : null;
}

export function trimHook(input) {
  if (input.tool_name !== "Bash") return null;
  const r = input.tool_response;
  if (!r || typeof r !== "object" || r.isImage) return null;
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  const so = trimText(stdout);
  const se = trimText(stderr);
  if (!so && !se) return null;

  const dir = path.join(TARE_HOME, "out");
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.createHash("sha1").update(`${input.session_id}|${input.tool_use_id || Date.now()}|${stdout.length}`).digest("hex").slice(0, 12);
  const file = path.join(dir, `${id}.log`);
  fs.writeFileSync(file, `$ ${input.tool_input?.command ?? ""}\n\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`);
  const note = `\n[tare: output trimmed from ~${Math.round((stdout.length + stderr.length) / CHARS_PER_TOKEN)} tokens. Full output: ${file}. Read or grep it if you need more.]`;
  logSaving(input.session_id, ((so?.dropped || 0) + (se?.dropped || 0)) / CHARS_PER_TOKEN);
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { ...r, stdout: (so ? so.text : stdout) + note, stderr: se ? se.text : stderr },
    },
  };
}

function logSaving(session, tokens) {
  try {
    fs.appendFileSync(path.join(TARE_HOME, "savings.jsonl"), JSON.stringify({ t: Date.now(), session, fix: "trim", tokens: Math.round(tokens) }) + "\n");
  } catch {}
}

// The last API call in a transcript, read from the end of the file so it stays fast on 100 MB logs.
export function lastCall(transcript) {
  let fd;
  try {
    fd = fs.openSync(transcript, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    const first = len < size ? 1 : 0; // when reading mid-file, the first line is cut off
    for (let i = lines.length - 1; i >= first; i--) {
      if (!lines[i].includes('"assistant"') || !lines[i].includes('"usage"')) continue;
      try {
        const d = JSON.parse(lines[i]);
        if (d.type !== "assistant" || !d.message?.usage || d.message.model === "<synthetic>") continue;
        const u = readUsage(d.message.usage);
        return { t: Date.parse(d.timestamp), model: d.message.model, context: u.input + u.read + u.write5m + u.write1h, ttl: u.write1h > 0 ? 3600_000 : 300_000 };
      } catch {}
    }
  } catch {
  } finally {
    if (fd) fs.closeSync(fd);
  }
  return null;
}

export function statusLine(input, now = Date.now()) {
  const amber = (s) => `\x1b[33m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`, red = (s) => `\x1b[31m${s}\x1b[0m`, green = (s) => `\x1b[32m${s}\x1b[0m`;
  const parts = [amber("tare")];
  const cost = input.cost?.total_cost_usd;
  if (typeof cost === "number") parts.push(`$${cost.toFixed(2)}`);
  const last = input.transcript_path ? lastCall(input.transcript_path) : null;
  if (last && last.t) {
    const p = priceFor(last.model);
    parts.push(dim(`${Math.round(last.context / 1000)}k ctx`));
    const left = last.ttl - (now - last.t);
    const rewrite = p ? (last.context * p.input * 1.25) / 1e6 : 0;
    const warm = p ? (last.context * p.read) / 1e6 : 0;
    if (left > 0) {
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      const clock = `${m}:${String(s).padStart(2, "0")}`;
      parts.push(`cache warm ${left < 60000 ? red(clock) : green(clock)}${p ? dim(` · next msg ~$${warm.toFixed(2)}`) : ""}`);
    } else if (last.context > 20000) {
      parts.push(`${red("cache cold")}${p ? dim(` · next msg ~$${rewrite.toFixed(2)} · /compact first saves most of it`) : ""}`);
    }
  }
  return parts.join(dim(" · "));
}

export { modelName };
