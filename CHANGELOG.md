# Changelog

## 0.2.4

Fixes to the counting. **Your totals will change after upgrading.**

- A resumed or forked session copies earlier API calls into a new log file. Earlier versions counted those calls again, with their tool output, prompts and commits. Each is now counted once; the new session is still charged for reading that history again.
- Sub-agent logs more than a few folders down, such as those written by workflows, are now read.
- Claude Fable 5.2, Mythos 5.2 and Sonnet 5.5 have their own prices. Before, they took an older model's rates (Fable 5.2 was priced well above list). Fast mode is now doubled on every model that offers it. Anthropic prices as of 27 Nov 2026.
- A reply logged over several lines is priced from its fullest line. Before, a first line with partial output could price it low.
- `--days N` no longer skips a log last written early on the window's first day.
- The first run after upgrading reads your logs afresh.

## 0.2.3

- Every hint now prints the command that works after `npx` (`npx tarelab fix`, not `tare fix`), so it runs without a global install. Help says how to get the short `tare` command.

## 0.2.2

- "What filled the context" no longer lists the same MCP server twice: every tool of a server is now added up into one row, so the top five shows five different sources.

## 0.2.1

- A welcome screen: in a wide terminal, Tare's report now opens with a pixel-art balance, a stack of tokens on the heavy pan, and the three commands that matter. Pipes, CI, `NO_COLOR`, `--json` and narrow windows get plain text as before.

## 0.2.0

- Reads more agents than Claude Code: Codex CLI (with how close you came to your ChatGPT plan's usage limits),
  Gemini CLI, and Cline, Roo Code and Kilo Code in VS Code, Cursor, Windsurf and other VS Code-based editors.
  Wrapped shows spend by agent when you use more than one.
- OpenAI and Google API list prices (as of 8 Nov 2026) next to Anthropic's.
- `tare setup`: adds Tare's MCP server to every AI coding app found (Claude Code, Claude Desktop, Cursor, VS Code,
  Windsurf, Codex, Gemini CLI, Kiro, opencode, Amazon Q, LM Studio, Cline, Roo Code, Kilo Code), pinned to the
  exact version, with backups and `--undo`.
- A Gemini CLI extension, and an MCP registry manifest.
- The Claude Code plugin runs its own bundled code for the MCP server instead of an unpinned `npx tarelab`.
- Help no longer mentions a "repeat guard" that doesn't exist.

## 0.1.0

- First release: Wrapped from Claude Code logs, the share card, the output trim and cache countdown
  (`tare fix`), the receipt, and the MCP server.
