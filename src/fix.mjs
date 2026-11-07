// Installs and removes Tare's fixes in Claude Code's settings. Every change is backed up first,
// touches only entries Tare owns, and `tare fix --undo` puts the file back the way it was.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { TARE_HOME } from "./analyze.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(TARE_HOME, "app");
const STATE = path.join(TARE_HOME, "state.json");
const MARK = "/.tare/app/bin/tare.mjs";
const ours = (cmd) => typeof cmd === "string" && (cmd.includes(MARK) || /\btarelab?\b.*\bguard\b/.test(cmd));

export function settingsPath(scope, cwd = process.cwd()) {
  if (scope === "project") return path.join(cwd, ".claude", "settings.json");
  const p = path.join(os.homedir(), ".claude", "settings.json");
  try {
    return fs.realpathSync(p); // the settings file may be a symlink into a dotfiles repo
  } catch {
    return p;
  }
}

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new Error(`${p} is not valid JSON; fix it first, Tare won't overwrite it`);
  }
};

// Hooks run on every tool call, so they point at a copy of Tare in ~/.tare/app rather than at
// npx, which would be slow and would need the network.
function installApp() {
  fs.rmSync(APP, { recursive: true, force: true });
  for (const d of ["bin", "src"]) fs.cpSync(path.join(ROOT, d), path.join(APP, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(APP, "package.json"));
  return `${nodeCommand()} "${path.join(APP, "bin", "tare.mjs")}"`;
}

// Prefer plain `node` from PATH: a versioned path like /usr/local/Cellar/node/26.3.1/bin/node
// disappears on the next upgrade and would silently switch the hooks off.
function nodeCommand() {
  const r = spawnSync("node", ["-e", "process.stdout.write(process.version)"], { encoding: "utf8" });
  return r.status === 0 && r.stdout === process.version ? "node" : `"${process.execPath}"`;
}

export function install({ scope = "user", dryRun = false, cwd } = {}) {
  const file = settingsPath(scope, cwd);
  const before = readJson(file, {});
  const s = structuredClone(before);
  const cmd = dryRun ? `${nodeCommand()} "${path.join(APP, "bin", "tare.mjs")}"` : installApp();
  const done = [];

  s.hooks ||= {};
  s.hooks.PostToolUse = (s.hooks.PostToolUse || []).filter((m) => !(m.hooks || []).some((h) => ours(h.command)));
  s.hooks.PostToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: `${cmd} guard trim`, timeout: 10 }] });
  done.push("Output trim: long Bash output is cut to errors + head + tail; the full text is saved in ~/.tare/out");

  if (!s.statusLine || ours(s.statusLine.command)) {
    s.statusLine = { type: "command", command: `${cmd} guard statusline`, refreshInterval: 2 };
    done.push("Status line: cache-warm countdown and the cost of your next message");
  } else {
    done.push(`Status line: you already have one, so Tare left it alone. To use Tare's, set statusLine.command to: ${cmd} guard statusline`);
  }

  const lines = [`  ${dryRun ? "Would change" : "Changed"} ${file}`, ...done.map((d) => `  ✓ ${d}`)];
  if (dryRun) return [...lines, "", JSON.stringify({ hooks: { PostToolUse: s.hooks.PostToolUse }, statusLine: s.statusLine }, null, 2)].join("\n");

  fs.mkdirSync(path.join(TARE_HOME, "backups"), { recursive: true });
  const backup = path.join(TARE_HOME, "backups", `settings-${scope}-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(before, null, 2));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  const state = readJson(STATE, {});
  state.installs = [...(state.installs || []), { at: Date.now(), scope, file, backup, fixes: ["trim", "statusline"] }];
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  return [...lines, `  Backup: ${backup}`, "  New sessions pick this up; restart open ones. Undo any time: tare fix --undo", "  In a week or two, run: tare receipt"].join("\n");
}

export function uninstall({ scope = "user", dryRun = false, cwd } = {}) {
  const file = settingsPath(scope, cwd);
  const s = readJson(file, null);
  if (!s) return `  Nothing to undo: ${file} does not exist.`;
  let removed = 0;
  for (const [event, matchers] of Object.entries(s.hooks || {})) {
    const kept = [];
    for (const m of matchers) {
      const hooks = (m.hooks || []).filter((h) => !ours(h.command));
      removed += (m.hooks || []).length - hooks.length;
      if (hooks.length) kept.push({ ...m, hooks });
    }
    if (kept.length) s.hooks[event] = kept;
    else delete s.hooks[event];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  if (s.statusLine && ours(s.statusLine.command)) {
    delete s.statusLine;
    removed++;
  }
  if (!removed) return `  Tare isn't installed in ${file}.`;
  if (!dryRun) {
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
    const state = readJson(STATE, {});
    state.uninstalls = [...(state.uninstalls || []), { at: Date.now(), scope, file }];
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  }
  return `  ${dryRun ? "Would remove" : "Removed"} ${removed} Tare entr${removed > 1 ? "ies" : "y"} from ${file}. Your other settings are untouched.`;
}

export function status() {
  const state = readJson(STATE, {});
  const out = [];
  for (const scope of ["user", "project"]) {
    const s = readJson(settingsPath(scope), {});
    const hooks = Object.values(s.hooks || {}).flat().flatMap((m) => m.hooks || []).filter((h) => ours(h.command)).length;
    const sl = s.statusLine && ours(s.statusLine.command);
    out.push(`  ${scope.padEnd(8)} ${hooks ? `✓ output trim` : "· output trim off"}   ${sl ? "✓ status line" : "· status line off"}`);
  }
  let n = 0, tokens = 0;
  try {
    for (const l of fs.readFileSync(path.join(TARE_HOME, "savings.jsonl"), "utf8").split("\n")) {
      if (!l) continue;
      const e = JSON.parse(l);
      n++;
      tokens += e.tokens || 0;
    }
  } catch {}
  const first = state.installs?.[0]?.at;
  out.push("", first ? `  Installed since ${new Date(first).toISOString().slice(0, 10)}.` : "  Not installed yet: tare fix");
  if (n) out.push(`  Output trim has cut ${n} long outputs, ~${Math.round(tokens / 1000)}k tokens before they entered context.`);
  out.push("  For the measured saving per task, run: tare receipt");
  return out.join("\n");
}
