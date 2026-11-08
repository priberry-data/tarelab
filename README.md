# tare

**Same work, fewer tokens, with the receipt.**

Your coding agent keeps a log of every API call it makes. Tare reads those logs, prices every token,
and shows where the money went: Claude Code, Codex CLI, Gemini CLI, and Cline, Roo Code and Kilo Code
in VS Code, Cursor, Windsurf and the other VS Code-based editors. For Codex on a ChatGPT plan it also
shows how close you came to the plan's usage limits. Then it cuts the waste without breaking the prompt cache, and proves
each saving on your own work. It runs locally, uploads nothing and never calls a model.

```
npx tarelab
```

```
  YOUR AGENT, WRAPPED  · last 30 days · 254 sessions · 79,905 API calls

  $6,720 API-equivalent spend
  $623 of it was avoidable (9%)

  Where it went
  Reading cached context     ██████████████████████ $3,809
  Writing to the cache       ████████████ $2,072
  Output (thinking incl.)    █████ $838

  The highlights
  › ~82k tokens load before you type a word.
  › Coffee-break tax: $722 re-caching after 636 pauses.
  › Sub-agents spent $2,734 (41%).
```

*A real month of Priberry's own Claude Code use.*

## Commands

| Command | What it does |
|---|---|
| `tare` | Wrapped for the last 30 days. `--days N`, `--all`, `--json`, `--logs <dir>` |
| `tare card` | A 1200×630 shareable card (SVG, with a PNG download) and post text. Nothing is uploaded |
| `tare fix` | Installs the output trim and the cache status line. `--dry-run`, `--undo`, `--scope project` |
| `tare receipt` | Cost per commit before and after `tare fix`, with a 90% range and a finish-rate check |
| `tare status` | What is installed, and how much output the trim has cut so far |
| `tare setup` | Adds Tare to every AI coding app on this machine. `--dry-run`, `--undo` |
| `tare mcp` | MCP server over stdio: `tare_wrapped`, `tare_receipt`, `tare_cache` |

## How the numbers work

- **API-equivalent.** Every call is priced at Anthropic's API list prices: fresh input, cache writes
  (1.25× input for the 5-minute cache, 2× for the 1-hour cache), cache reads and output. On a
  subscription you pay a flat fee; this is what the same work would cost on the API.
- **Carry cost.** A tool's output is written to the cache once and read back on every later call until
  the conversation is compacted. Tare charges each output for the whole time it stays in context.
- **Cache rebuilds.** When most of a prompt is written to the cache again instead of read from it, Tare
  says why: an idle pause past the cache's lifetime, a model switch, a compaction, or a break.
- **Repeats.** A tool call that returned byte-for-byte what the agent already had.

## The fixes

Tare cuts waste where it enters the context and never rewrites what's already there, because a
rewritten history breaks the prompt cache and costs more than it saves.

- **Output trim** (a `PostToolUse` hook on Bash): output over ~2,500 tokens is cut to the first 40
  lines, every line that looks like a failure (with context) and the last 60 lines. The full output
  is saved in `~/.tare/out/` and the agent is told where.
- **Cache countdown** (the status line): how long until the cache goes cold, and what the next message
  costs warm versus cold. Installed only if you don't already have a status line.

Settings are backed up to `~/.tare/backups/` first, and `tare fix --undo` removes only Tare's entries.

## The receipt

`tare receipt` compares cost per commit in sessions before and after the fixes, with a bootstrap 90%
interval, and checks that as many sessions still reach a commit. With fewer than 8 finished sessions
on either side it prints "not enough data" and no number.

## In your agent

One command adds Tare to every AI coding app it finds: Claude Code, Claude Desktop, Cursor, VS Code,
Windsurf, Codex, Gemini CLI, Kiro, opencode, Amazon Q, LM Studio, and Cline, Roo Code and Kilo Code.
The entry is pinned to the exact version, each file is backed up first, and `--undo` removes it.

```
npx tarelab setup
```

Or one app at a time:

- **Claude Code plugin:** `/plugin marketplace add priberry-data/tarelab`, then `/plugin install tare@priberry`.
- **Gemini CLI extension:** `gemini extensions install https://github.com/priberry-data/tarelab`
- **Skill (Claude Code or Codex):** copy `skills/tare` into `~/.claude/skills/` or `~/.codex/skills/`.
- **Any MCP client:** `{"command": "npx", "args": ["-y", "tarelab@0.2.0", "mcp"]}`. Then ask "what did my agent cost this month?"

## Limits

Tare reads the logs that agents keep on your machine. Cursor's own agent, Windsurf's Cascade, Copilot
and the browser app builders (Lovable, Bolt, v0, Replit) keep usage on their servers, so Tare can't see
them yet; opencode is next. Cline-family costs are the ones the extension itself recorded. The
`fix` and `receipt` commands work on Claude Code, where the hooks exist. Token counts for tool output are
estimated from text length (the API reports totals per call, not per block). Prices are as of
2026-10-06 for Anthropic and 2026-11-08 for OpenAI and Google, and live in `src/prices.mjs`.

Apache-2.0 · Built by [Priberry](https://priberry.com), who also make [Crumple](https://crumple.priberry.com).
