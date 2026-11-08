// Tare Wrapped in the terminal: the bill, where it went, the lines worth sharing, and the fixes.
import path from "node:path";
import { usd as $, ktok as K } from "./analyze.mjs";
import { modelName, PRICES_AS_OF, OTHER_PRICES_AS_OF } from "./prices.mjs";

export const BANNER = [
  "████████╗ █████╗ ██████╗ ███████╗",
  "╚══██╔══╝██╔══██╗██╔══██╗██╔════╝",
  "   ██║   ███████║██████╔╝█████╗  ",
  "   ██║   ██╔══██║██╔══██╗██╔══╝  ",
  "   ██║   ██║  ██║██║  ██║███████╗",
  "   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝",
];
// Warm amber fading darker, row by row: a receipt printer rather than a phosphor screen.
const SHADES = [[255, 214, 110], [250, 196, 80], [240, 176, 56], [222, 154, 40], [196, 128, 30], [160, 100, 24]];

export function banner({ version, tagline, stream = process.stdout, env = process.env } = {}) {
  if (!stream.isTTY || env.NO_COLOR || env.CI || (stream.columns ?? 80) < BANNER[0].length + 4) return "";
  const truecolor = /truecolor|24bit/i.test(env.COLORTERM ?? "");
  const paint = (row, i) => {
    if (!truecolor) return `\x1b[${i < 3 ? "93" : "33"}m${row}\x1b[0m`;
    const [r, g, b] = SHADES[i];
    return row.replace(/(█+)|([^█]+)/g, (_, solid, edge) =>
      solid ? `\x1b[38;2;${r};${g};${b}m${solid}` : `\x1b[38;2;${r >> 1};${g >> 1};${b >> 1}m${edge}`) + "\x1b[0m";
  };
  const dim = (s) => `\x1b[2m${s}\x1b[22m`;
  return ["", ...BANNER.map((row, i) => "  " + paint(row, i)), "", `  ${tagline}${version ? dim(`  v${version}`) : ""}`, ""].join("\n") + "\n";
}

export function render(R, { color = true } = {}) {
  const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = c("1"), dim = c("2"), amber = c("33"), red = c("31"), green = c("32");
  const out = [];
  const w = (s = "") => out.push(s);
  const bar = (x, max, width = 22) => amber("█".repeat(Math.max(1, Math.round((x / (max || 1)) * width))));
  const row = (label, v, max) => w(`  ${label.padEnd(26).slice(0, 26)} ${bar(v, max)} ${$(v)}`);

  const window = R.days ? `last ${R.days} days` : "all time";
  w(`  ${bold("YOUR AGENT, WRAPPED")}  ${dim(`· ${window} · ${R.sessions} sessions · ${R.calls.toLocaleString("en-US")} API calls`)}`);
  w();
  w(`  ${bold(amber($(R.usd)))} ${dim("API-equivalent spend")}`);
  const saves = R.fixes.reduce((a, f) => a + f.saves, 0);
  if (saves > 0) w(`  ${bold(green($(saves)))} ${dim(`of it was avoidable (${Math.round((saves / R.usd) * 100)}%)`)}`);
  w();

  w(`  ${bold("Where it went")}`);
  const parts = [
    ["Reading cached context", R.cost.read],
    ["Writing to the cache", R.cost.write],
    ["Output (thinking incl.)", R.cost.output],
    ["Fresh input", R.cost.input],
    ["Priced by the tool itself", R.cost.reported || 0],
  ];
  const max = Math.max(...parts.map((p) => p[1]));
  for (const [l, v] of parts) if (v > 0.005) row(l, v, max);
  w();

  w(`  ${bold("What filled the context")}  ${dim("(cost of carrying it, call after call)")}`);
  const fills = [
    ["Startup context", R.startup.usd],
    ...Object.entries(R.tools)
      .sort((a, b) => b[1].usd - a[1].usd)
      .slice(0, 5)
      .map(([t, b]) => [toolName(t), b.usd]),
  ].sort((a, b) => b[1] - a[1]);
  const fmax = Math.max(...fills.map((f) => f[1]));
  for (const [l, v] of fills) if (v > 0.005) row(l, v, fmax);
  w();

  const agents = Object.entries(R.byAgent || {}).sort((a, b) => b[1].usd - a[1].usd);
  if (agents.length > 1) {
    w(`  ${bold("Agents")}`);
    for (const [n, a] of agents) row(n, a.usd, agents[0][1].usd);
    w();
  }

  w(`  ${bold("Models")}`);
  const models = Object.entries(R.byModel).sort((a, b) => b[1] - a[1]).slice(0, 4);
  for (const [m, v] of models) row(modelName(m), v, models[0][1]);
  w();

  if (R.lines.length) {
    w(`  ${bold("The highlights")}`);
    for (const l of R.lines) w(`  ${amber("›")} ${l}`);
    w();
  }

  if (R.fixes.length) {
    w(`  ${bold("Top fixes")}  ${dim("saving estimated from your own logs")}`);
    R.fixes.slice(0, 5).forEach((f, i) => {
      w(`  ${amber(`${i + 1}.`)} ${bold(f.title)}  ${green(`~${$(f.saves)}`)}${dim(`  · ${f.auto || "a habit, not a switch"}`)}`);
      w(`     ${dim(wrap(f.detail, 72).join("\n     "))}`);
    });
    w();
  }
  if (R.unpriced) w(`  ${red("!")} ${dim(`${R.unpriced} calls used a model Tare has no price for; they are left out.`)}`);
  w(dim(`  Prices: API list prices (Anthropic as of ${PRICES_AS_OF}, OpenAI and Google as of ${OTHER_PRICES_AS_OF}). On a subscription you pay a flat fee;`));
  w(dim(`  this is what the same work would cost on the API. Nothing left this machine.`));
  return out.join("\n");
}

function toolName(t) {
  if (t.startsWith("mcp__")) return `MCP: ${t.split("__")[1]}`;
  return `${t} output`;
}

export function wrap(text, width) {
  const lines = [];
  let cur = "";
  for (const word of String(text).split(/\s+/)) {
    if ((cur + " " + word).trim().length > width) {
      lines.push(cur);
      cur = word;
    } else cur = (cur + " " + word).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

export const projectName = (p) => (p ? path.basename(p) : "unknown");
