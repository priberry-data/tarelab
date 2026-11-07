---
name: tare
description: Show where this coding agent's tokens and money go, and cut the waste without breaking the prompt cache. Use when the user asks what their agent costs, why a session was expensive, how to use fewer tokens, for their "Wrapped", or whether a token-saving change actually worked.
---

# Tare: same work, fewer tokens, with the receipt

Tare reads the session logs the coding agent already keeps on disk, prices every API call, and shows
where the money went. It runs locally, spends no tokens and uploads nothing. The command is
`npx -y tarelab` (Node 20+).

## What to run

| The user wants | Run | Then |
|---|---|---|
| Their spend and where it went ("my Wrapped", "why so expensive") | `npx -y tarelab --json --days 30` | Summarize: total, the top 3 fills of the context, the highlights, the top fixes with their saving |
| A card to share | `npx -y tarelab card` | Tell them the HTML page opened and has a PNG download; remind them to check it before posting |
| To apply the fixes | `npx -y tarelab fix --dry-run` first | Show the change, and run `npx -y tarelab fix` only after they say yes |
| To know if the fixes worked | `npx -y tarelab receipt` | Report the range as printed; never round a "not enough data" into a saving |
| To remove Tare | `npx -y tarelab fix --undo` | Confirm their other settings were left alone |

Use `--all` for all time or `--days N` for another window. The JSON has `usd`, `cost` (read, write,
output, input), `tools`, `bash`, `rebuilds`, `startup`, `fixes` and `lines`.

## How to talk about the numbers

- They are **API-equivalent** costs at Anthropic list prices. On a subscription the user pays a flat
  fee, so say "this work would cost $X on the API", never "you were charged $X".
- "Carry cost" is the cost of keeping something in context: a tool output is written to the cache
  once and read back on every later call. That is why a big test log costs more than the call that
  made it.
- The "coffee-break tax" is the cache expiring after a pause of more than 5 minutes (1 hour with the
  long cache), so the whole conversation is written again.
- Don't promise savings Tare hasn't measured. The receipt is the only measured number.

## While you work (cheap habits Tare's data supports)

- Ask for the failures, not the whole log: `npm test 2>&1 | tail -80` or a runner's `--reporter=dot`
  style flag before piping thousands of passing lines into context.
- Read the part of a file you need (line ranges, `grep -n`) rather than the whole file again.
- Don't switch models mid-session: the cache is per model, so a switch rewrites the whole context.
- Before a long break, offer `/compact`; a cold cache on a long conversation is the largest single
  avoidable cost Tare sees.

Source and issues: https://github.com/priberry-data/tarelab · https://tare.priberry.com
