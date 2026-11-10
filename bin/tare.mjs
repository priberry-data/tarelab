#!/usr/bin/env node
// tare: see where your coding agent's tokens go, cut the waste, and prove the saving.
//   tare            Wrapped for the last 30 days   ·   tare fix   install the cache-safe fixes
//   tare receipt    before and after, per finished task   ·   tare card   the shareable card
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { analyze, TARE_HOME } from "../src/analyze.mjs";
import { render, banner } from "../src/wrapped.mjs";
import { progress } from "../src/ui.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version: VERSION } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let parsed;
try {
  parsed = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: "string", default: "30" },
    all: { type: "boolean" },
    json: { type: "boolean" },
    logs: { type: "string" },
    undo: { type: "boolean" },
    "dry-run": { type: "boolean" },
    scope: { type: "string", default: "user" },
    out: { type: "string" },
    "no-open": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  });
} catch (e) {
  // A guard run by a hook must never block the agent, so it ignores flags it doesn't know.
  if (process.argv[2] === "guard") parsed = { values: {}, positionals: process.argv.slice(2).filter((a) => !a.startsWith("-")) };
  else {
    console.error(`tare: ${e.message}\nRun \`npx tarelab --help\` for the commands and options.`);
    process.exit(2);
  }
}
const { values: opt, positionals } = parsed;

const HELP = `tare ${VERSION}: same work, fewer tokens, with the receipt.

  tare [wrapped]        Where your coding agents' tokens went (last 30 days). Local, zero tokens.
       --days N | --all   Choose the window.       --json   Machine-readable output.
  tare card             Write the shareable Wrapped card (HTML + SVG) and open it.
  tare fix              Install the cache-safe fixes in Claude Code (output trim, cache countdown).
       --scope user|project   Where to install.   --dry-run   Show the change only.   --undo   Remove them.
  tare receipt          Cost per session and per commit before vs after tare fix, with a range.
  tare status           What is installed and what it has saved so far.
  tare setup            Add Tare to every AI coding app on this machine (Cursor, VS Code, Windsurf,
                        Claude, Codex, Gemini CLI, Cline, Kiro and more).  --dry-run   --undo
  tare mcp              Run Tare as an MCP server (stdio) for any agent.

Nothing leaves this machine. Prices are API list prices; on a subscription this is
"API-equivalent" cost. Docs: https://tare.priberry.com · Issues: github.com/priberry-data/tarelab`;

const cmd = positionals[0] || "wrapped";
const days = opt.all ? 0 : Number(opt.days) || 30;

async function runAnalysis() {
  let p = null;
  try {
    return await analyze({
      days,
      root: opt.logs,
      onStart: opt.json ? undefined : (total) => (p = progress({ total, label: "reading session logs" })),
      onProgress: () => p?.tick(),
    });
  } finally {
    p?.stop();
  }
}

async function main() {
  if (opt.version) return console.log(VERSION);
  if (opt.help || cmd === "help") return console.log(HELP);

  if (cmd === "wrapped") {
    // The welcome screen heads the report in a wide terminal; a narrower one gets the smaller banner.
    if (!opt.json) {
      const { welcome } = await import("../src/welcome.mjs");
      process.stdout.write(welcome({ version: VERSION }) || banner({ version: VERSION, tagline: "Same work, fewer tokens, with the receipt." }));
    }
    const R = await runAnalysis();
    if (opt.json) return console.log(JSON.stringify(R, null, 2));
    if (!R.calls)
      return console.log(
        "  No agent sessions found in this window. Tare reads Claude Code, Codex CLI, Gemini CLI, and Cline,\n  Roo Code and Kilo Code in VS Code, Cursor, Windsurf and other VS Code-based editors.\n  Try --all, or --logs <dir> for Claude Code logs somewhere else.",
      );
    console.log(render(R, { color: Boolean(process.stdout.isTTY && !process.env.NO_COLOR) }));
    console.log(`\n  Next: ${"tare card"} for a shareable card · ${"tare fix"} to apply the fixes\n`);
    return;
  }
  if (cmd === "card") {
    const { writeCard } = await import("../src/card.mjs");
    const R = await runAnalysis();
    const file = writeCard(R, opt.out || path.join(TARE_HOME, "wrapped"));
    console.log(`  Card written: ${file}`);
    if (!opt["no-open"]) (await import("node:child_process")).spawn(process.platform === "darwin" ? "open" : "xdg-open", [file], { stdio: "ignore", detached: true }).unref();
    return;
  }
  if (cmd === "fix") {
    const { install, uninstall } = await import("../src/fix.mjs");
    const r = opt.undo ? uninstall({ scope: opt.scope, dryRun: opt["dry-run"] }) : install({ scope: opt.scope, dryRun: opt["dry-run"] });
    return console.log(r);
  }
  if (cmd === "receipt") {
    const { receipt, renderReceipt } = await import("../src/receipt.mjs");
    const R = await analyze({ days: 0, root: opt.logs });
    const r = receipt(R);
    return console.log(opt.json ? JSON.stringify(r, null, 2) : renderReceipt(r));
  }
  if (cmd === "status") {
    const { status } = await import("../src/fix.mjs");
    return console.log(status());
  }
  if (cmd === "guard") {
    const { runGuard } = await import("../src/guard.mjs");
    return runGuard(positionals[1]);
  }
  if (cmd === "setup") {
    const { setup, renderSetup } = await import("../src/clients.mjs");
    const rows = setup({ name: "tare", pkg: "tarelab", version: VERSION, dryRun: opt["dry-run"], undo: opt.undo, backupDir: path.join(TARE_HOME, "backups") });
    return console.log(renderSetup(rows, { name: "Tare", undo: opt.undo, dryRun: opt["dry-run"], color: Boolean(process.stdout.isTTY && !process.env.NO_COLOR) }));
  }
  if (cmd === "mcp") {
    const { serve } = await import("../src/mcp.mjs");
    return serve({ version: VERSION });
  }
  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch((e) => {
  // A hook must never break the agent: guards fail open.
  if (cmd === "guard") return;
  console.error(`tare: ${e.message}`);
  process.exitCode = 1;
});
