# Changelog

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
