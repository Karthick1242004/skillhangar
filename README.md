# Skillhangar

A local dashboard for the skills, plugins and MCP servers in your Claude Code setup. It shows where
each one came from, audits it for safety, and installs, updates, disables or rolls it back.

```bash
npx -y skillhangar
```

Unofficial. Not affiliated with Anthropic. Site: https://skillhangar.vercel.app

## What it does

- **Inventory across every scope.** Personal, project, plugin, managed, claude.ai-synced and legacy
  command skills; MCP servers in user, local, project, plugin and managed scope; plugins and their
  enabled state. Several Claude profiles (`CLAUDE_CONFIG_DIR`) on one machine, with shared skill
  folders listed once. Name collisions are resolved the way Claude Code resolves them, and the losers
  are marked shadowed.
- **Provenance.** Source repository, commit and install date from the `skills` CLI lock file, the
  plugin record, a `.git` folder or the frontmatter. For skills with no record, *Trace origin* searches
  skills.sh and compares each candidate's SKILL.md with yours.
- **Trust signals** (opt-in network): GitHub stars, licence, last push, archived flag, the days the
  source repository appeared on GitHub Trending, skills.sh install counts and partner audit verdicts,
  OpenSSF Scorecard, and newer versions and known vulnerabilities for MCP packages.
- **Audits.** A static pass over every file (hidden Unicode, prompt injection, exfiltration
  endpoints, credential access, download-and-run, obfuscation, persistence, destructive commands,
  over-broad `allowed-tools`, frontmatter hooks, inline shell, unpinned packages, escaping symlinks),
  plus an optional Claude audit on your own `claude` CLI with the model and spend cap you choose,
  plus Cisco AI Defense skill-scanner and NVIDIA SkillSpector, each run through `uvx` at a pinned version
  on a copy of the skill. Each extra opinion can raise the static verdict, never lower it.
- **Safe changes.** Installs and updates land in quarantine first, are audited and diffed, and need an
  explicit yes when the new version adds a serious finding. Every update keeps a snapshot; every
  removal goes to a 30-day trash; every action is logged with undo.
- **Context cost.** How many characters of skill listings Claude reads before you type, and which
  skills cost the most.
- **Usage.** An opt-in hook counts each time Claude invokes a skill or you type `/name`.
- **Connections.** *Check connections* reads `claude mcp list` health checks: configured servers and
  your claude.ai connectors, each connected, needing sign-in, or failed. No model is called.
- **Same setup on another machine.** `skillhangar export` writes a manifest of skill sources (with
  commits) and MCP launch lines without secret values; `skillhangar apply` replays it.

## Commands

```text
skillhangar                     Start the dashboard (or reuse a running one) and open it
skillhangar serve [--port N]    Run in the foreground
skillhangar scan [--json]       Print the inventory
skillhangar audit <name|path>   Audit one skill; exit code 1 when it is dangerous (CI-friendly)
    --claude --model sonnet --budget 0.50
    --scanner cisco|skillspector|all   also run external scanners (needs uv)
skillhangar export [file]       Manifest of skill sources and MCP servers, with no secret values
skillhangar apply <file>        Dry run of a manifest; --yes downloads, audits and installs its skills
    --project <folder> --force         MCP servers are printed as claude mcp add-json commands
skillhangar stop                Stop the dashboard
```

To use it as a Claude Code skill, copy `skill/SKILL.md` into `~/.claude/skills/skillhangar/`.

## Security model

The server can change your Claude Code setup, so it is built like one that can run commands:

- Binds `127.0.0.1` on a random port. A per-launch token in the URL fragment is exchanged once for an
  HttpOnly, SameSite=Strict cookie.
- Rejects any request whose `Host` is not that loopback address and port (DNS rebinding), and any
  change without a same-origin `Origin` and a CSRF header. It sends no CORS headers, and the page runs
  under a strict Content-Security-Policy.
- Child processes get argument arrays, never a shell. File reads are confined to the skill's folder.
- MCP `env` and `headers` values never leave the server process; the UI sees key names and flags.
- Skill text is shown as plain text with invisible characters made visible, never rendered as HTML.
- Changes to MCP servers and plugins go through `claude mcp` and `claude plugin`; Skillhangar never
  edits `.claude.json`. Settings edits back the file up first and refuse a file that does not parse.
- The Claude audit copies the skill into an empty temporary folder outside your home, renames anything
  Claude Code would load as instructions (`CLAUDE.md`, `.claude`, `.mcp.json`), and runs
  `claude -p` with only Read, Grep and Glob, no MCP servers, no skills or slash commands, no session
  persistence, a turn limit and `--max-budget-usd`. A result from a session that reports any other
  tool is discarded.

## Data

Everything Skillhangar keeps is in `~/.skillhangar` (override with `SKILLHANGAR_HOME`): audit results
keyed by content hash, snapshots, trash, quarantine, the activity log, usage lines and caches. Network
lookups are off until you turn them on.

## Develop

```bash
npm install
npm run dev:server &          # esbuild watch into dist/
node dist/cli.js serve --dev  # API on 127.0.0.1:4517
npm run dev:ui                # Vite on localhost:5173, open the printed Dev UI link
npm run check                 # typecheck, tests, production build
```

Node 22.12 or newer. The UI is built ahead of time and shipped inside the package, so users never run
a bundler.
