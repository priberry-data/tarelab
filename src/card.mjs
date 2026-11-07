// The shareable card: a 1200x630 SVG (the size X, LinkedIn and Slack previews use) and an HTML page
// around it. Same terminal look as Crumple, in amber. Only totals and file names go on it, never
// paths, prompts or code, and nothing is uploaded: the person decides whether to post it.
import fs from "node:fs";
import path from "node:path";
import { usd as $, ktok as K } from "./analyze.mjs";
import { modelName } from "./prices.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const C = { bg: "#0B0905", fg: "#F2DFB8", hi: "#FFC24B", dim: "#9A8460", line: "#3E301A", ok: "#7CE38B" };

export function cardSvg(R) {
  const saves = R.fixes.reduce((a, f) => a + f.saves, 0);
  const window = R.days ? `LAST ${R.days} DAYS` : "ALL TIME";
  const [model, mUsd] = Object.entries(R.byModel).sort((a, b) => b[1] - a[1])[0] || ["", 0];
  const stats = [
    ["sessions", R.sessions.toLocaleString("en-US")],
    ["API calls", R.calls.toLocaleString("en-US")],
    ["per commit", R.commits ? $(R.usd / R.commits) : "—"],
    ["top model", model ? `${modelName(model)} ${Math.round((mUsd / R.usd) * 100)}%` : "—"],
  ];
  const lines = R.lines.filter((l) => !/^Peak hour|did \d+% of your spend/.test(l)).slice(0, 4);
  const fix = R.fixes[0];
  const mono = `font-family="IBM Plex Mono, SF Mono, Menlo, Consolas, DejaVu Sans Mono, monospace"`;
  const t = (x, y, s, size, fill, weight = 400, extra = "") => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${esc(s)}</text>`;
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" ${mono}>`);
  o.push(`<defs><pattern id="scan" width="4" height="3" patternUnits="userSpaceOnUse"><rect width="4" height="1" y="2" fill="#000" opacity=".22"/></pattern>
<radialGradient id="vig" cx="50%" cy="50%" r="75%"><stop offset="62%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".55"/></radialGradient>
<filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`);
  o.push(`<rect width="1200" height="630" fill="${C.bg}"/>`);
  o.push(`<rect x="24" y="24" width="1152" height="582" fill="none" stroke="${C.line}" stroke-width="2"/>`);
  // header bar
  o.push(`<rect x="24" y="24" width="1152" height="52" fill="#120E07"/><line x1="24" y1="76" x2="1176" y2="76" stroke="${C.line}" stroke-width="2"/>`);
  o.push(`<rect x="48" y="38" width="24" height="24" fill="${C.hi}"/>${t(54, 57, "t", 18, C.bg, 600)}`);
  o.push(t(84, 57, "tare", 20, C.fg, 600) + t(140, 57, "· YOUR AGENT, WRAPPED", 18, C.dim));
  o.push(t(1152, 57, window, 18, C.dim, 400, 'text-anchor="end"'));
  // the bill
  // Drawn twice, a soft copy under a sharp one: a glow that survives renderers without SVG filters.
  o.push(t(56, 168, $(R.usd), 84, C.hi, 600, 'opacity=".35" stroke="#FFC24B" stroke-width="6" stroke-linejoin="round"') + t(56, 168, $(R.usd), 84, C.hi, 600));
  o.push(t(60, 204, "API-equivalent spend on my coding agent", 20, C.dim));
  if (saves > 0) o.push(t(60, 246, `${$(saves)} of it was avoidable (${Math.round((saves / R.usd) * 100)}%)`, 24, C.ok, 600));
  // stats column
  stats.forEach(([k, v], i) => {
    const y = 128 + i * 40;
    o.push(t(760, y, k.padEnd(11, " "), 20, C.dim, 400, 'xml:space="preserve"') + t(1152, y, v, 22, C.fg, 600, 'text-anchor="end"'));
  });
  o.push(`<line x1="56" y1="282" x2="1144" y2="282" stroke="${C.line}" stroke-width="2" stroke-dasharray="6 6"/>`);
  // the highlights
  lines.forEach((l, i) => o.push(t(60, 330 + i * 40, "›", 24, C.hi, 600) + t(88, 330 + i * 40, l.replace(/`/g, "").slice(0, 78), 23, C.fg)));
  if (fix) {
    o.push(`<rect x="56" y="${500}" width="1088" height="64" fill="#17110A" stroke="${C.line}"/>`);
    o.push(t(76, 540, "TOP FIX", 18, C.dim, 600) + t(180, 540, fix.title, 22, C.fg, 600) + t(1124, 540, `~${$(fix.saves)}`, 24, C.ok, 600, 'text-anchor="end"'));
  }
  o.push(t(56, 596, "npx tarelab", 18, C.hi, 600) + t(1144, 596, "tare.priberry.com · measured locally, nothing uploaded", 16, C.dim, 400, 'text-anchor="end"'));
  o.push(`<rect width="1200" height="630" fill="url(#scan)"/><rect width="1200" height="630" fill="url(#vig)"/></svg>`);
  return o.join("\n");
}

export function cardHtml(R, svg) {
  const text = [`My coding agent, wrapped: ${$(R.usd)} API-equivalent in ${R.days ? `${R.days} days` : "total"}.`, ...R.lines.slice(0, 3), "Measured with npx tarelab"].join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tare Wrapped</title>
<style>
:root{--bg:${C.bg};--fg:${C.fg};--hi:${C.hi};--dim:${C.dim};--line:${C.line}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 "IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace;padding:32px 16px}
main{max-width:1000px;margin:0 auto}.card{width:100%;height:auto;display:block;border:1px solid var(--line)}
h1{font-size:18px;color:var(--hi);margin:0 0 18px}p{color:var(--dim)}
.row{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}
a.btn,button{font:inherit;background:var(--hi);color:var(--bg);border:0;padding:9px 14px;cursor:pointer;text-decoration:none;font-weight:600}
button.ghost{background:none;color:var(--hi);border:1px solid var(--hi)}
textarea{width:100%;height:120px;background:#120E07;color:var(--fg);border:1px solid var(--line);font:inherit;padding:10px}
</style></head><body><main>
<h1>tare · your agent, wrapped</h1>
<img class="card" src="wrapped.svg" alt="Tare Wrapped card: ${esc($(R.usd))} API-equivalent spend">
<div class="row"><button id="png">Download PNG</button><a class="btn ghost" style="background:none;color:var(--hi);border:1px solid var(--hi)" href="wrapped.svg" download="tare-wrapped.svg">SVG</a><button class="ghost" id="copy">Copy post text</button></div>
<textarea id="post" readonly>${esc(text)}</textarea>
<p>This page was made on your machine and has not been uploaded anywhere. Check the card before you post it: it shows totals and file names only.</p>
</main><script>
document.getElementById("copy").onclick=()=>navigator.clipboard.writeText(document.getElementById("post").value);
// Most sites won't take an SVG upload, so draw the card onto a canvas at 2x and save a PNG.
document.getElementById("png").onclick=()=>{const img=new Image();img.onload=()=>{const c=document.createElement("canvas");c.width=2400;c.height=1260;c.getContext("2d").drawImage(img,0,0,2400,1260);c.toBlob(b=>{const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="tare-wrapped.png";a.click()},"image/png")};img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(${JSON.stringify(svg).replace(/</g, "\\u003c")})};
</script></body></html>`;
}

export function writeCard(R, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const svg = cardSvg(R);
  fs.writeFileSync(path.join(dir, "wrapped.svg"), svg);
  fs.writeFileSync(path.join(dir, "index.html"), cardHtml(R, svg));
  return path.join(dir, "index.html");
}
