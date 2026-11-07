// The receipt: did the fixes lower the cost of finished work, measured on your own sessions?
// "Finished" here means a session that made at least one commit. We compare cost per finished
// session and cost per commit before and after `tare fix`, with a bootstrap range, and say
// plainly when there isn't enough data yet.
import fs from "node:fs";
import path from "node:path";
import { TARE_HOME, usd as $ } from "./analyze.mjs";

const MIN_SESSIONS = 8;

function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ratio of mean cost per commit, after / before, with a 90% bootstrap interval.
export function compare(before, after, { iters = 2000, seed = 7 } = {}) {
  const rnd = mulberry(seed);
  const ratio = (b, a) => {
    const pc = (xs) => xs.reduce((s, x) => s + x.usd, 0) / Math.max(1, xs.reduce((s, x) => s + x.commits, 0));
    return pc(a) / pc(b);
  };
  const pick = (xs) => Array.from(xs, () => xs[Math.floor(rnd() * xs.length)]);
  const rs = [];
  for (let i = 0; i < iters; i++) rs.push(ratio(pick(before), pick(after)));
  rs.sort((x, y) => x - y);
  return { point: ratio(before, after), lo: rs[Math.floor(iters * 0.05)], hi: rs[Math.floor(iters * 0.95)] };
}

export function receipt(R, { installedAt } = {}) {
  if (installedAt == null) {
    try {
      installedAt = JSON.parse(fs.readFileSync(path.join(TARE_HOME, "state.json"), "utf8")).installs?.[0]?.at;
    } catch {}
  }
  const sessions = R.sessionList.filter((s) => s.start && s.usd > 0);
  const finished = sessions.filter((s) => s.commits > 0);
  const out = { installedAt: installedAt || null, sessions: sessions.length, finished: finished.length };
  if (!installedAt) return { ...out, verdict: "not-installed" };
  const before = finished.filter((s) => s.end < installedAt);
  const after = finished.filter((s) => s.start >= installedAt);
  const rate = (xs, all) => (all.length ? xs.length / all.length : 0);
  const allBefore = sessions.filter((s) => s.end < installedAt), allAfter = sessions.filter((s) => s.start >= installedAt);
  Object.assign(out, {
    before: { n: before.length, perCommit: perCommit(before), finishRate: rate(before, allBefore) },
    after: { n: after.length, perCommit: perCommit(after), finishRate: rate(after, allAfter) },
  });
  if (before.length < MIN_SESSIONS || after.length < MIN_SESSIONS) return { ...out, verdict: "not-enough-data", need: MIN_SESSIONS };
  const c = compare(before, after);
  out.change = { point: c.point - 1, lo: c.lo - 1, hi: c.hi - 1 };
  out.verdict = c.hi < 1 ? "saving" : c.lo > 1 ? "costlier" : "unclear";
  // Never count a saving that broke the work: flag it if fewer sessions reach a commit.
  out.workHeld = out.after.finishRate >= out.before.finishRate - 0.1;
  return out;
}

const perCommit = (xs) => xs.reduce((s, x) => s + x.usd, 0) / Math.max(1, xs.reduce((s, x) => s + x.commits, 0));
const pct = (x) => `${x > 0 ? "+" : ""}${Math.round(x * 100)}%`;

export function renderReceipt(r) {
  const L = ["", "  TARE RECEIPT", "  ────────────────────────────────────────"];
  if (r.verdict === "not-installed") {
    L.push("  No fixes installed yet, so there's nothing to compare.", "  Run `tare fix`, work as usual for a week or two, then come back.");
    return L.join("\n");
  }
  L.push(`  Fixes installed     ${new Date(r.installedAt).toISOString().slice(0, 10)}`);
  L.push(`  Before              ${r.before.n} finished sessions · ${$(r.before.perCommit)} per commit`);
  L.push(`  After               ${r.after.n} finished sessions · ${r.after.n ? $(r.after.perCommit) : "—"} per commit`);
  L.push("  ────────────────────────────────────────");
  if (r.verdict === "not-enough-data") {
    L.push(`  Not enough data yet: the receipt needs ${r.need} finished sessions on each side.`, "  Tare won't print a number it can't stand behind.");
  } else {
    L.push(`  Cost per commit     ${pct(r.change.point)}  (90% range ${pct(r.change.lo)} to ${pct(r.change.hi)})`);
    L.push(`  Sessions finishing  ${Math.round(r.before.finishRate * 100)}% → ${Math.round(r.after.finishRate * 100)}%${r.workHeld ? "  · work held up" : "  · FEWER sessions finish: check the fixes"}`);
    L.push(
      r.verdict === "saving" ? "  Verdict: a real saving." : r.verdict === "costlier" ? "  Verdict: costlier since the fixes. Try `tare fix --undo`." : "  Verdict: too close to call yet.",
    );
  }
  L.push("  ────────────────────────────────────────", "  Measured on your own logs, on this machine.");
  return L.join("\n");
}
