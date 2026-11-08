// API list prices in US dollars per million tokens. Anthropic as published on 6 Oct 2026; OpenAI and
// Google as published on 8 Nov 2026 (standard tier, short prompts, with Google's long-prompt tier).
// Cache writes cost 1.25x input for the 5-minute cache and 2x for the 1-hour cache; cache reads
// have their own per-model rate. Claude Code on a subscription is not billed this way, so Tare
// calls these numbers "API-equivalent" cost: what the same work would cost on the API.
export const PRICES_AS_OF = "2026-10-06";
export const OTHER_PRICES_AS_OF = "2026-11-08";

const P = (input, output, read, over) => ({ input, output, read: read ?? input, ...(over && { over }) });
const LONG = (above, input, output, read) => ({ above, input, output, read });
const TABLE = [
  [/^claude-(fable|mythos)-5-1/, P(10, 50, 0.25)],
  [/^claude-(fable|mythos)-5/, P(10, 50, 1)],
  [/^claude-opus-5-5/, P(4, 20, 0.2)],
  [/^claude-opus-5/, P(5, 25, 0.5)],
  [/^claude-opus-4-[5-9]/, P(5, 25, 0.5)],
  [/^claude-opus-4/, P(15, 75, 1.5)],
  [/^claude-3-opus/, P(15, 75, 1.5)],
  [/^claude-sonnet-5/, P(2, 10, 0.2)],
  [/^claude-(sonnet-4|3-[57]-sonnet)/, P(3, 15, 0.3)],
  [/^claude-haiku-5-5/, P(0.1, 0.5, 0.01)],
  [/^claude-haiku-4-5/, P(1, 5, 0.1)],
  [/^claude-3-5-haiku/, P(0.8, 4, 0.08)],
  // OpenAI (Codex CLI and others). Models with no cached rate are priced at full input.
  [/^gpt-5\.6-sol/, P(4, 20, 0.4)],
  [/^gpt-5\.6-terra/, P(2, 12, 0.2)],
  [/^gpt-5\.6-luna/, P(0.2, 1.2, 0.02)],
  [/^gpt-5\.5-pro/, P(30, 180)],
  [/^gpt-5\.5/, P(5, 30, 0.5)],
  [/^gpt-5\.4-pro/, P(30, 180)],
  [/^gpt-5\.4-mini/, P(0.75, 4.5, 0.075)],
  [/^gpt-5\.4-nano/, P(0.2, 1.25, 0.02)],
  [/^gpt-5\.4/, P(2.5, 15, 0.25)],
  [/^gpt-5\.3-codex/, P(1.75, 14, 0.175)],
  [/^gpt-5\.2-pro/, P(21, 168)],
  [/^gpt-5\.2/, P(1.75, 14, 0.175)],
  [/^gpt-5(\.1)?(-codex)?-mini/, P(0.25, 2, 0.025)],
  [/^gpt-5-nano/, P(0.05, 0.4, 0.005)],
  [/^gpt-5-pro/, P(15, 120)],
  [/^gpt-5(\.1)?(-codex(-max)?)?$/, P(1.25, 10, 0.125)],
  // Google (Gemini CLI and others); the Pro models cost more for prompts over 200k tokens.
  [/^gemini-3\.[68]-flash(?!-lite)/, P(0.75, 3.75, 0.075)],
  [/^gemini-3\.5-flash-lite/, P(0.3, 2.5, 0.03)],
  [/^gemini-3\.1-flash-lite/, P(0.25, 1.5, 0.025)],
  [/^gemini-3\.1-pro/, P(2, 12, 0.2, LONG(200_000, 4, 18, 0.4))],
  [/^gemini-3-flash/, P(0.5, 3, 0.05)],
  [/^gemini-2\.5-pro/, P(1.25, 10, 0.125, LONG(200_000, 2.5, 15, 0.25))],
  [/^gemini-2\.5-flash-lite/, P(0.1, 0.4, 0.01)],
  [/^gemini-2\.5-flash/, P(0.3, 2.5, 0.03)],
];

export function priceFor(model) {
  if (!model) return null;
  for (const [re, p] of TABLE) if (re.test(model)) return p;
  return null;
}

// Short display name: claude-opus-5-5 -> Opus 5.5, gpt-5.3-codex -> GPT-5.3 Codex, gemini-3.1-pro-preview -> Gemini 3.1 Pro
export function modelName(model) {
  if (/^gpt-/.test(model || "")) return model.replace(/^gpt/, "GPT").replace(/-(\w)/g, (_, c, i) => (i > 3 ? " " + c.toUpperCase() : "-" + c));
  if (/^gemini-/.test(model || ""))
    return model
      .replace(/-preview.*$|-\d{2}-\d{2}$/, "")
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ")
      .replace(/ Lite$/, "-Lite");
  const m = /^claude-(\w+)-(\d+)(?:-(\d+))?/.exec(model || "");
  if (!m) return model || "unknown";
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? "." + m[3] : ""}`;
}

// Usage for one API call, summed over `iterations` when the log has them (the top-level
// numbers can be zero while the iterations hold the real counts).
export function readUsage(u) {
  if (!u) return null;
  const parts = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
  const out = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0, thinking: 0, fast: u.speed === "fast" };
  for (const it of parts) {
    out.input += it.input_tokens || 0;
    out.read += it.cache_read_input_tokens || 0;
    out.output += it.output_tokens || 0;
    const cc = it.cache_creation;
    const created = it.cache_creation_input_tokens || 0;
    if (cc && (cc.ephemeral_5m_input_tokens || cc.ephemeral_1h_input_tokens)) {
      out.write5m += cc.ephemeral_5m_input_tokens || 0;
      out.write1h += cc.ephemeral_1h_input_tokens || 0;
    } else out.write5m += created;
  }
  out.thinking = u.output_tokens_details?.thinking_tokens || 0;
  return out;
}

export function costOf(model, u) {
  const p = priceFor(model);
  if (!p || !u) return null;
  const k = u.fast && /opus-5/.test(model) ? 2 : 1;
  // Claude Haiku 5.5 bills prompts over 100K tokens at a higher rate
  const big = /haiku-5-5/.test(model) && u.input + u.read + u.write5m + u.write1h > 100_000 ? 5 : 1;
  const r = (x) => (x * k * big) / 1e6;
  return {
    input: u.input * r(p.input),
    write: u.write5m * r(p.input * 1.25) + u.write1h * r(p.input * 2),
    read: u.read * r(p.read),
    output: u.output * r(p.output),
    thinking: u.thinking * r(p.output),
  };
}

export const total = (c) => (c ? c.input + c.write + c.read + c.output : 0);
