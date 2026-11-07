// Draws the CLI banner as crisp SVG: every █ becomes a solid cell, and every box-drawing
// character becomes the thin line it stands for. Run: node site/build-banner.mjs > site/brand/banner.svg
import { BANNER } from "../src/wrapped.mjs";
const W = 10, H = 20, S = 2.2; // terminal cells are twice as tall as wide
const cells = [], lines = [];
BANNER.forEach((row, r) => [...row].forEach((ch, c) => {
  const x = c * W, y = r * H, cx = x + W / 2, cy = y + H / 2;
  if (ch === "█") return cells.push(`M${x} ${y}h${W}v${H}h-${W}z`);
  const L = { "═": [[x, cy, x + W, cy]], "║": [[cx, y, cx, y + H]],
    "╗": [[x, cy, cx, cy], [cx, cy, cx, y + H]], "╔": [[cx, cy, x + W, cy], [cx, cy, cx, y + H]],
    "╝": [[x, cy, cx, cy], [cx, y, cx, cy]], "╚": [[cx, cy, x + W, cy], [cx, y, cx, cy]] }[ch];
  if (L) for (const [a, b, c2, d] of L) lines.push(a === c2 ? `M${a} ${b}V${d}` : `M${a} ${b}H${c2}`);
}));
const w = Math.max(...BANNER.map((r) => r.length)) * W, h = BANNER.length * H;
console.log(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 ${w + 8} ${h + 8}" role="img" aria-label="tare">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE7B0"/><stop offset=".45" stop-color="#FFC24B"/><stop offset="1" stop-color="#B07A1E"/></linearGradient></defs>
<path d="${lines.join("")}" fill="none" stroke="#6E5226" stroke-width="${S}" stroke-linecap="square"/>
<path d="${cells.join("")}" fill="url(#g)"/>
</svg>`);
