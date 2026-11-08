// `setup`: add this tool's MCP server to every AI coding app found on the machine, in each app's own
// config format, pinned to the exact version (an unpinned `npx` server runs whatever is published
// next). Each file is backed up first, nothing else in it changes, and `--undo` removes only our entry.
// A file that isn't plain JSON (comments, say) is never rewritten; we print what to add instead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const appSupport = (home) =>
  process.platform === "darwin" ? path.join(home, "Library", "Application Support") : process.platform === "win32" ? process.env.APPDATA || path.join(home, "AppData", "Roaming") : path.join(home, ".config");

// Every app we know how to configure: where it keeps MCP servers, and in which shape.
export function clients(home = os.homedir()) {
  const app = appSupport(home);
  const list = [
    { name: "Claude Desktop", file: path.join(app, "Claude", "claude_desktop_config.json"), shape: "mcpServers", when: path.join(app, "Claude") },
    { name: "Cursor", file: path.join(home, ".cursor", "mcp.json"), shape: "mcpServers", when: path.join(home, ".cursor") },
    { name: "Windsurf", file: path.join(home, ".codeium", "windsurf", "mcp_config.json"), shape: "mcpServers", when: path.join(home, ".codeium", "windsurf") },
    { name: "VS Code", file: path.join(app, "Code", "User", "mcp.json"), shape: "vscode", when: path.join(app, "Code", "User") },
    { name: "VS Code Insiders", file: path.join(app, "Code - Insiders", "User", "mcp.json"), shape: "vscode", when: path.join(app, "Code - Insiders", "User") },
    { name: "Gemini CLI", file: path.join(home, ".gemini", "settings.json"), shape: "mcpServers", when: path.join(home, ".gemini") },
    { name: "Codex", file: path.join(process.env.CODEX_HOME && home === os.homedir() ? process.env.CODEX_HOME : path.join(home, ".codex"), "config.toml"), shape: "toml", when: path.join(home, ".codex") },
    { name: "Kiro", file: path.join(home, ".kiro", "settings", "mcp.json"), shape: "mcpServers", when: path.join(home, ".kiro") },
    { name: "opencode", file: path.join(home, ".config", "opencode", "opencode.json"), shape: "opencode", when: path.join(home, ".config", "opencode") },
    { name: "Amazon Q", file: path.join(home, ".aws", "amazonq", "mcp.json"), shape: "mcpServers", when: path.join(home, ".aws", "amazonq") },
    { name: "LM Studio", file: path.join(home, ".lmstudio", "mcp.json"), shape: "mcpServers", when: path.join(home, ".lmstudio") },
  ];
  // Cline, Roo Code and Kilo Code keep their own list inside each editor they're installed in.
  for (const ed of ["Code", "Cursor", "Windsurf", "VSCodium", "Trae", "Kiro"])
    for (const [ext, nm, f] of [
      ["saoudrizwan.claude-dev", "Cline", "cline_mcp_settings.json"],
      ["rooveterinaryinc.roo-cline", "Roo Code", "mcp_settings.json"],
      ["kilocode.kilo-code", "Kilo Code", "mcp_settings.json"],
    ]) {
      const dir = path.join(app, ed, "User", "globalStorage", ext);
      list.push({ name: ed === "Code" ? nm : `${nm} in ${ed}`, file: path.join(dir, "settings", f), shape: "mcpServers", when: dir });
    }
  return list;
}

function entry(shape, command, args) {
  if (shape === "vscode") return { type: "stdio", command, args };
  if (shape === "opencode") return { type: "local", command: [command, ...args], enabled: true };
  return { command, args };
}
const key = (shape) => (shape === "vscode" ? "servers" : shape === "opencode" ? "mcp" : "mcpServers");

function backup(file, dir) {
  if (!fs.existsSync(file)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, `${Date.now()}-${file.replace(/[^\w.-]+/g, "_").slice(-120)}`));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function tomlBlock(name, command, args) {
  return `\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map((a) => JSON.stringify(a)).join(", ")}]\n`;
}
const TOML_RE = (name) => new RegExp(`\\n?\\[mcp_servers\\.${name}\\]\\n(?:(?!\\[)[^\\n]*\\n?)*`, "g");

// Returns one line per app: added, updated, already there, removed, skipped (with why), or not installed.
export function setup({ name, pkg, version, home = os.homedir(), dryRun = false, undo = false, backupDir, claudeCli = true }) {
  const command = "npx";
  const args = ["-y", `${pkg}@${version}`, "mcp"];
  const out = [];
  for (const c of clients(home)) {
    if (!fs.existsSync(c.when)) continue;
    const rec = (status, note) => out.push({ client: c.name, file: c.file, status, note });
    try {
      if (c.shape === "toml") {
        const t = fs.existsSync(c.file) ? fs.readFileSync(c.file, "utf8") : "";
        const has = TOML_RE(name).test(t);
        if (undo) {
          if (!has) continue;
          if (!dryRun) (backup(c.file, backupDir), fs.writeFileSync(c.file, t.replace(TOML_RE(name), "\n")));
          rec("removed");
          continue;
        }
        const block = tomlBlock(name, command, args);
        if (t.includes(block.trim())) {
          rec("already there");
          continue;
        }
        if (!dryRun) {
          backup(c.file, backupDir);
          fs.mkdirSync(path.dirname(c.file), { recursive: true });
          fs.writeFileSync(c.file, (has ? t.replace(TOML_RE(name), "\n") : t).replace(/\n*$/, "\n") + block);
        }
        rec(has ? "updated" : "added");
        continue;
      }
      let cfg = {};
      if (fs.existsSync(c.file)) {
        const text = fs.readFileSync(c.file, "utf8");
        if (text.trim()) {
          try {
            cfg = JSON.parse(text);
          } catch {
            rec("skipped", `has comments or isn't plain JSON; add under "${key(c.shape)}": ${JSON.stringify({ [name]: entry(c.shape, command, args) })}`);
            continue;
          }
        }
      }
      const k = key(c.shape);
      const cur = cfg[k]?.[name];
      if (undo) {
        if (!cur) continue;
        delete cfg[k][name];
        if (!dryRun) (backup(c.file, backupDir), writeJson(c.file, cfg));
        rec("removed");
        continue;
      }
      const want = entry(c.shape, command, args);
      if (cur && JSON.stringify(cur) === JSON.stringify({ ...cur, ...want })) {
        rec("already there");
        continue;
      }
      cfg[k] = { ...(cfg[k] || {}), [name]: { ...(cur || {}), ...want } };
      if (!dryRun) (backup(c.file, backupDir), writeJson(c.file, cfg));
      rec(cur ? "updated" : "added");
    } catch (e) {
      rec("skipped", e.message);
    }
  }
  // Claude Code keeps MCP servers in a large file it rewrites often, so go through its own CLI.
  if (claudeCli && fs.existsSync(path.join(home, ".claude"))) {
    // Run from the home folder so a project's own .mcp.json isn't mistaken for the user's entry.
    const run = (a) => execFileSync("claude", a, { cwd: home, stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }).toString();
    let current = null;
    try {
      const got = run(["mcp", "get", name]); // fails when there is no such server
      if (/Scope:\s*User/i.test(got)) current = got;
    } catch {}
    try {
      const has = current != null;
      if (undo) {
        if (has && !dryRun) run(["mcp", "remove", "-s", "user", name]);
        if (has) out.push({ client: "Claude Code", file: "claude mcp", status: "removed" });
      } else if (has && current.includes(`${pkg}@${version}`)) out.push({ client: "Claude Code", file: "claude mcp", status: "already there" });
      else {
        if (!dryRun) {
          if (has) run(["mcp", "remove", "-s", "user", name]);
          run(["mcp", "add", "-s", "user", name, "--", command, ...args]);
        }
        out.push({ client: "Claude Code", file: "claude mcp", status: has ? "updated" : "added" });
      }
    } catch {
      if (!undo) out.push({ client: "Claude Code", file: "claude mcp", status: "skipped", note: `run: claude mcp add -s user ${name} -- ${command} ${args.join(" ")}` });
    }
  }
  return out;
}

export function renderSetup(rows, { name, undo, dryRun, color = true }) {
  const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const green = c("32"), dim = c("2"), yellow = c("33");
  const L = [];
  if (!rows.length) {
    L.push(undo ? `  ${name} isn't set up in any app on this machine.` : "  No supported AI coding app found on this machine.");
    return L.join("\n");
  }
  for (const r of rows) {
    const mark = r.status === "skipped" ? yellow("!") : r.status === "already there" ? dim("·") : green("✓");
    const status = dryRun && /added|updated|removed/.test(r.status) ? `would be ${r.status}` : r.status;
    L.push(`  ${mark} ${r.client.padEnd(22)} ${status}${r.note ? dim(`  ${r.note}`) : ""}`);
  }
  if (dryRun) L.push(dim("\n  Dry run: nothing was written."));
  else if (!undo && rows.some((r) => /added|updated/.test(r.status))) L.push(dim(`\n  Restart those apps to load it. Ask your agent to use ${name}. Undo any time with --undo.`));
  return L.join("\n");
}
