// The welcome screen: a balance with a stack of tokens on one pan, drawn in the terminal with half-block
// characters, two pixels to a character cell. Shown only to a real terminal that is wide enough; never in
// pipes, CI, or with NO_COLOR, where the plain help is printed instead.

// --- a very small pixel painter ---------------------------------------------------------------------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// 24-bit colour where the terminal says it has it; otherwise the nearest of the colours every terminal has.
const colour = (hex, layer, truecolor) => {
  const [r, g, b] = rgb(hex);
  if (truecolor) return `${layer};2;${r};${g};${b}`;
  // Near-greys go to the 24-step grey ramp, so a dark grey stays grey instead of turning teal.
  if (Math.max(r, g, b) - Math.min(r, g, b) < 24) return `${layer};5;${232 + Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)))}`;
  const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  return `${layer};5;${16 + 36 * q(r) + 6 * q(g) + q(b)}`;
};

export const canvas = (w, h) => Array.from({ length: h }, () => Array(w).fill("."));
export const blit = (c, sprite, x, y) => {
  sprite.forEach((row, j) => [...row].forEach((ch, i) => ch !== "." && c[y + j]?.[x + i] !== undefined && (c[y + j][x + i] = ch)));
  return c;
};

// Each line of text holds two rows of pixels: the upper half-block takes the top pixel's colour as its
// foreground and the bottom pixel's as its background.
export function paint(c, palette, truecolor) {
  const lines = [];
  for (let y = 0; y < c.length; y += 2) {
    let line = "";
    for (let x = 0; x < c[0].length; x++) {
      const top = palette[c[y][x]];
      const bottom = palette[c[y + 1]?.[x]];
      if (!top && !bottom) line += "\x1b[0m ";
      else if (top && bottom) line += `\x1b[0;${colour(top, 38, truecolor)};${colour(bottom, 48, truecolor)}m▀`;
      else if (top) line += `\x1b[0;${colour(top, 38, truecolor)}m▀`;
      else line += `\x1b[0;${colour(bottom, 38, truecolor)}m▄`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines;
}

export const canShow = (stream, env, width) => Boolean(stream.isTTY && !env.NO_COLOR && !env.CI && env.TERM !== "dumb" && (stream.columns ?? 80) >= width);

// --- Tare's scene -----------------------------------------------------------------------------------
// The heavy pan hangs lower: that is the weight Tare takes off.
const BALANCE = [
  "..............tt..............",
  ".............tttt.............",
  "..............tt...bbbbbbbbbb.",
  "..........bbbbttbbbb........c.",
  ".bbbbbbbbbb...tt...c........c.",
  ".c........c...tt...c........c.",
  ".c........c...tt...c........c.",
  ".c..OOOO..c...tt...c........c.",
  ".c..oooo..c...tt..pppppppppppp",
  ".c..OOOO..c...tt...PPPPPPPPPP.",
  ".c..oooo..c...tt..............",
  ".c..OOOO..c...tt..............",
  ".c..oooo..c...tt..............",
  "pppppppppppp..tt..............",
  ".PPPPPPPPPP...tt..............",
  "..............tt..............",
  "..............tt..............",
  "...........tttttttt...........",
  ".........tttttttttttt.........",
];
const PALETTE = { t: "#a7ada9", b: "#d9dcd8", c: "#6c726e", p: "#ffc24b", P: "#b9861f", o: "#ff9f40", O: "#ffe7b0", d: "#2f3430", s: "#8b918d", S: "#f1f3f1" };

export function scene() {
  const c = canvas(32, 22);
  blit(c, BALANCE, 1, 1);
  for (let x = 0; x < 32; x++) c[20][x] = "d";
  for (const [x, y, ch] of [[26, 13, "s"], [29, 16, "S"], [22, 15, "s"], [6, 1, "s"], [27, 0, "s"]]) c[y][x] = ch;
  return c;
}

export function welcome({ version = "", stream = process.stdout, env = process.env } = {}) {
  if (!canShow(stream, env, 102)) return "";
  const truecolor = /truecolor|24bit/i.test(env.COLORTERM ?? "");
  const art = paint(scene(), PALETTE, truecolor);
  // The words use the terminal's own text colours, so they read on a dark or a light background.
  const off = "\x1b[0m", bold = "\x1b[1m", faint = "\x1b[2m", amber = "\x1b[33m";
  const cmd = (c, note) => `${amber}$${off} ${c}${" ".repeat(Math.max(2, 24 - c.length))}${faint}${note}${off}`;
  const text = {
    2: `${bold}${amber}tare${off}${version ? `  ${faint}v${version}${off}` : ""}`,
    3: "Same work, fewer tokens, with the receipt.",
    5: cmd("npx tarelab", "where your tokens went, last 30 days"),
    6: cmd("npx tarelab fix", "install the cache-safe fixes"),
    7: cmd("npx tarelab receipt", "before and after, per commit"),
    8: `${faint}Nothing leaves this machine.${off}`,
    9: `${faint}--help for everything  ·  tare.priberry.com${off}`,
  };
  return ["", ...art.map((line, i) => `  ${line}   ${text[i] ?? ""}`.trimEnd()), ""].join("\n") + "\n";
}
