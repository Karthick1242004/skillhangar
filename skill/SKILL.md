---
name: skillhangar
description: Open Skillhangar, a local dashboard that lists every installed Claude Code skill, plugin and MCP server with its source, install date, GitHub stars and trending history, audits each one for safety (static rules plus an optional Claude audit on a model the user picks), and installs, updates, disables or rolls back skills. Use when the user asks to see, manage, audit, clean up, update or install skills or MCP servers, or asks whether a skill is safe.
argument-hint: "[scan | audit <skill>]"
allowed-tools: Bash(npx -y skillhangar@0.1.0:*)
---

# Skillhangar

Skillhangar runs on the user's machine at 127.0.0.1 and opens in their browser. It reads Claude Code's
own files; it changes them only when the user clicks an action in the dashboard.

## Open the dashboard

Run:

```bash
npx -y skillhangar@0.1.0
```

It starts the server in the background (or reuses a running one), opens the browser and prints a link
like `http://127.0.0.1:PORT/#token=...`. Give the user that link. The token is per launch; do not repeat
it anywhere else.

## Answer without the browser

- `npx -y skillhangar@0.1.0 scan` prints a summary: profiles, skill counts by scope, MCP servers, the
  size of the skill listing Claude reads each session, and anything that needs attention.
- `npx -y skillhangar@0.1.0 audit <skill-name-or-folder>` runs the static audit and prints findings. Add
  `--claude --model sonnet --budget 0.50` for a Claude audit on the user's own `claude` CLI. That costs
  money on their plan or API key, so ask first and say which model and cap you will use.

## What to tell the user

- An audit lowers risk; it does not prove a skill is safe. Report the verdict and the top findings in
  plain words, with file and line.
- Never mark a skill reviewed, remove, update or install anything on the user's behalf from the
  command line; those actions are in the dashboard, where the user confirms them.
- Stop the server with `npx -y skillhangar@0.1.0 stop`. It also stops by itself after 30 idle minutes.
