// Terminal motion: a short boot log, a live progress line with a spinner, and nothing else.
// Everything here turns itself off when output isn't a real terminal, or under NO_COLOR or CI,
// so logs, pipes and --json stay plain.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const animated = (stream = process.stdout, env = process.env) => Boolean(stream.isTTY && !env.NO_COLOR && !env.CI);

const green = (s) => `\x1b[33m${s}\x1b[0m`; // Tare is amber where Crumple is green
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Prints a few "name ...... ok  detail" lines, one at a time, like a machine coming up.
export async function boot(lines, { stream = process.stdout, env = process.env } = {}) {
  const on = animated(stream, env);
  for (const [name, detail] of lines) {
    const dots = ".".repeat(Math.max(2, 22 - name.length));
    if (on) {
      stream.write(`  ${dim(`${name} ${dots}`)} `);
      await sleep(70);
    } else stream.write(`  ${name} ${dots} `);
    stream.write(on ? `${green("ok")}${detail ? dim(`  ${detail}`) : ""}\n` : `ok${detail ? `  ${detail}` : ""}\n`);
  }
}

export function bar(done, total, width = 24) {
  const full = total ? Math.round((done / total) * width) : 0;
  return green("█".repeat(full)) + dim("░".repeat(width - full));
}

// A status line that stays at the bottom while finished results print above it.
export function progress({ total, label = "", stream = process.stdout, env = process.env } = {}) {
  const on = animated(stream, env);
  let done = 0, frame = 0, extra = "", timer;
  const draw = () => {
    if (!on) return;
    stream.write(`\r\x1b[2K  ${green(FRAMES[frame++ % FRAMES.length])} ${bar(done, total)} ${done}/${total}${label ? dim(`  ${label}`) : ""}${extra ? dim(`  ${extra}`) : ""}`);
  };
  if (on) timer = setInterval(draw, 80);
  draw();
  return {
    // Prints a finished line above the status line and moves the bar on.
    log(line) {
      if (on) stream.write("\r\x1b[2K");
      stream.write(line + "\n");
      draw();
    },
    tick(note = "") {
      done++;
      extra = note;
      draw();
    },
    stop() {
      clearInterval(timer);
      if (on) stream.write("\r\x1b[2K");
    },
  };
}

// For short waits: a spinner and a label, replaced by a tick when the work is done.
export async function spin(label, work, { stream = process.stdout, env = process.env } = {}) {
  if (!animated(stream, env)) return work();
  let frame = 0;
  const timer = setInterval(() => stream.write(`\r\x1b[2K  ${green(FRAMES[frame++ % FRAMES.length])} ${dim(label)}`), 80);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    stream.write(`\r\x1b[2K  ${green("✓")} ${dim(label)}\n`);
  }
}
