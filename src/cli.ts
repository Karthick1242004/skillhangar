import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Finding, ScannerResult, SkillRecord, StaticAudit } from './shared/types';

declare const __SKILLHANGAR_VERSION__: string;
const VERSION = typeof __SKILLHANGAR_VERSION__ === 'string' ? __SKILLHANGAR_VERSION__ : 'dev';

const HELP = `Skillhangar ${VERSION}: inspect, audit and service Claude Code skills and MCP servers.

Usage
  skillhangar                     Start the dashboard (or reuse a running one) and open it
  skillhangar serve [--port N]    Run the dashboard in the foreground
  skillhangar scan [--json]       Print the inventory
  skillhangar audit <name|path>   Audit one skill; exit code 1 when it is dangerous
      --claude                    Also run a Claude audit with your claude CLI
      --model <alias|id>          Model for --claude (default sonnet)
      --budget <usd>              Spend cap for --claude (default 0.50)
      --scanner <cisco|skillspector|all>  Also run an external scanner (pinned, through uvx)
      --json                      Machine-readable output
  skillhangar export [file]       Write a manifest of skill sources and MCP servers (no secrets)
  skillhangar apply <file>        Show what a manifest would install here; add --yes to install
      --project <folder>          Install the manifest's project skills into this folder
      --force                     Also install skills the audit marks dangerous
  skillhangar stop                Stop the running dashboard

Options
  --no-open                       Do not open a browser
  -v, --version                   Print the version
  -h, --help                      Print this help

Unofficial. Not affiliated with Anthropic.`;

async function openBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['explorer.exe', [url]] : ['xdg-open', [url]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    // printing the URL is enough
  }
}

async function waitForServer(timeoutMs: number) {
  const { runningServer } = await import('./server/serve');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await runningServer();
    if (info) return info;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function cmdOpen(noOpen: boolean): Promise<number> {
  const { runningServer, launchUrl } = await import('./server/serve');
  let info = await runningServer();
  if (!info) {
    const self = fileURLToPath(import.meta.url);
    spawn(process.execPath, [self, 'serve', '--no-open', '--quiet'], { detached: true, stdio: 'ignore', env: process.env }).unref();
    info = await waitForServer(15_000);
    if (!info) {
      console.error('Skillhangar did not start within 15 seconds. Run `skillhangar serve` to see the error.');
      return 1;
    }
  }
  const url = launchUrl(info);
  console.log(`Skillhangar is running at ${url}`);
  if (!noOpen) await openBrowser(url);
  return 0;
}

async function cmdServe(port: number | undefined, dev: boolean, noOpen: boolean, quiet: boolean): Promise<number> {
  const { startServer, launchUrl, runningServer } = await import('./server/serve');
  const existing = await runningServer();
  if (existing && !dev) {
    console.log(`Already running at ${launchUrl(existing)}`);
    return 0;
  }
  const { info, close } = await startServer({ port: dev ? (port ?? 4517) : port, dev });
  const url = launchUrl(info);
  if (!quiet) {
    console.log(`Skillhangar ${VERSION} listening on 127.0.0.1:${info.port}`);
    console.log(dev ? `Dev UI: http://localhost:5173/#token=${info.token}` : `Open: ${url}`);
  }
  if (!noOpen && !dev) await openBrowser(url);
  const shutdown = () => void close().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return new Promise<number>(() => undefined);
}

function severityTag(f: Finding): string {
  return f.severity.toUpperCase().padEnd(8);
}

function printAudit(name: string, audit: StaticAudit): void {
  console.log(`\n${name}: ${audit.verdict.toUpperCase()}  (${audit.scannedFiles} files scanned, ruleset ${audit.ruleset})`);
  for (const f of audit.findings.filter((x) => x.severity !== 'info')) {
    console.log(`  ${severityTag(f)} ${f.ruleId}  ${f.file}${f.line ? `:${f.line}` : ''}`);
    if (f.evidence) console.log(`           ${f.evidence}`);
  }
}

async function cmdScan(json: boolean): Promise<number> {
  const [{ buildInventory }, { AuditCache }] = await Promise.all([import('./core/inventory'), import('./core/audit/cache')]);
  const { inventory } = await buildInventory(new AuditCache());
  if (json) {
    process.stdout.write(`${JSON.stringify(inventory)}\n`);
    return 0;
  }
  const byScope = new Map<string, number>();
  for (const s of inventory.skills) byScope.set(s.scope, (byScope.get(s.scope) ?? 0) + 1);
  console.log(`Profiles: ${inventory.profiles.map((p) => `${p.label}${p.isActive ? ' (active)' : ''}`).join(', ')}`);
  console.log(`Skills: ${inventory.skills.length} (${[...byScope].map(([k, v]) => `${v} ${k}`).join(', ')})`);
  console.log(`MCP servers: ${inventory.mcp.length}   Plugins: ${inventory.plugins.length}   Projects: ${inventory.projects.length}`);
  console.log(`Always-loaded skill listings: ${inventory.context.listed} skills, ${inventory.context.totalChars.toLocaleString('en')} characters`);
  const issues = inventory.skills.flatMap((s) => s.health.filter((h) => h.severity === 'high').map((h) => `${s.name}: ${h.message}`));
  const mcpIssues = inventory.mcp.flatMap((m) => m.health.filter((h) => h.severity !== 'info' && h.severity !== 'low').map((h) => `${m.name}: ${h.message}`));
  if (issues.length || mcpIssues.length) console.log(`\nNeeds attention:\n${[...issues, ...mcpIssues].map((l) => `  - ${l}`).join('\n')}`);
  console.log(`\nScanned in ${inventory.durationMs} ms.`);
  return 0;
}

async function cmdAudit(target: string | undefined, opts: { json: boolean; claude: boolean; model: string; budget: number; scanner?: string }): Promise<number> {
  if (!target) {
    console.error('Name a skill or a folder: skillhangar audit <name|path>');
    return 2;
  }
  const [{ buildInventory }, { AuditCache }, { runStaticAudit }, { walkTree, TreeHasher }, { parseSkillFile }, { readFile }] = await Promise.all([
    import('./core/inventory'),
    import('./core/audit/cache'),
    import('./core/audit/static'),
    import('./core/tree'),
    import('./core/discovery/frontmatter'),
    import('node:fs/promises'),
  ]);
  let root: string;
  let name: string;
  let description: string;
  let contentHash: string;
  let frontmatter: Record<string, unknown>;
  let skill: SkillRecord | undefined;
  const looksLikePath = /[/\\]/.test(target) || target.startsWith('.');
  if (looksLikePath) {
    root = resolve(target);
    const parsed = parseSkillFile(await readFile(`${root}/SKILL.md`, 'utf8').catch(() => ''));
    frontmatter = parsed.data;
    name = typeof parsed.data.name === 'string' ? parsed.data.name : root.split(/[/\\]/).pop()!;
    description = typeof parsed.data.description === 'string' ? parsed.data.description : '';
    contentHash = await new TreeHasher().treeHash(root, await walkTree(root));
  } else {
    const snap = await buildInventory(new AuditCache());
    skill = snap.inventory.skills.find((s) => s.name === target && !s.shadowedBy) ?? snap.inventory.skills.find((s) => s.name === target || s.folderName === target);
    if (!skill) {
      console.error(`No installed skill named "${target}".`);
      return 2;
    }
    root = skill.realPath;
    name = skill.name;
    description = skill.description;
    contentHash = skill.contentHash;
    frontmatter = snap.scanned.get(skill.id)?.frontmatter ?? {};
  }
  const audit = await runStaticAudit(root, await walkTree(root), frontmatter, contentHash);
  let verdict = audit.verdict;
  let claudeResult: unknown = null;
  if (opts.claude) {
    const { runClaudeAudit } = await import('./core/audit/claude');
    if (!opts.json) process.stderr.write(`Running a Claude audit with ${opts.model} (budget $${opts.budget.toFixed(2)})...\n`);
    const { audit: claude, isolation } = await runClaudeAudit({ name, description, root, contentHash, singleFile: false }, audit, { model: opts.model, budgetUsd: opts.budget, maxTurns: 24 });
    verdict = claude.combinedVerdict;
    claudeResult = { ...claude, isolation };
  }
  const scannerResults: ScannerResult[] = [];
  if (opts.scanner) {
    const [{ runScanner, SCANNERS }, { verdictFromFindings, worseVerdict }] = await Promise.all([import('./core/audit/scanners'), import('./core/audit/verdict')]);
    const ids = opts.scanner === 'all' ? SCANNERS.map((s) => s.id) : [opts.scanner];
    for (const id of ids) {
      if (!SCANNERS.some((s) => s.id === id)) {
        console.error(`Unknown scanner "${id}". Use cisco, skillspector or all.`);
        return 2;
      }
      if (!opts.json) process.stderr.write(`Running ${id} (the first run downloads it)...\n`);
      const result = await runScanner(id as 'cisco' | 'skillspector', root, false);
      scannerResults.push(result);
      if (result.ok) verdict = worseVerdict(verdict, verdictFromFindings(result.findings));
    }
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ name, path: root, verdict, static: audit, claude: claudeResult, scanners: scannerResults })}\n`);
  } else {
    printAudit(name, audit);
    if (claudeResult) {
      const c = claudeResult as { verdict: string; summary: string; costUsd: number | null; findings: Finding[] };
      console.log(`\nClaude: ${c.verdict.toUpperCase()}${c.costUsd !== null ? ` ($${c.costUsd.toFixed(4)})` : ''}\n  ${c.summary}`);
      for (const f of c.findings) console.log(`  ${severityTag(f)} ${f.category}  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.reason}`);
    }
    for (const r of scannerResults) {
      console.log(`\n${r.scanner}: ${r.ok ? `${r.findings.length} finding(s)` : `failed: ${r.error}`}`);
      for (const f of r.findings.filter((x) => x.severity !== 'info')) console.log(`  ${severityTag(f)} ${f.ruleId}  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.reason.slice(0, 120)}`);
    }
    console.log(`\nVerdict: ${verdict.toUpperCase()}`);
  }
  return verdict === 'dangerous' ? 1 : 0;
}

async function cmdExport(file: string | undefined): Promise<number> {
  const [{ buildInventory }, { AuditCache }, { buildManifest }] = await Promise.all([import('./core/inventory'), import('./core/audit/cache'), import('./core/ops/manifest')]);
  const { inventory } = await buildInventory(new AuditCache());
  const text = `${JSON.stringify(buildManifest(inventory), null, 2)}\n`;
  if (file) {
    await writeFile(file, text);
    console.log(`Wrote ${file}`);
  } else process.stdout.write(text);
  return 0;
}

async function cmdApply(file: string | undefined, opts: { yes: boolean; force: boolean; project?: string }): Promise<number> {
  if (!file) {
    console.error('Name a manifest: skillhangar apply skillhangar.json');
    return 2;
  }
  const [{ readFile }, { buildInventory }, { AuditCache }, { ManifestSchema, planApply, executeApply }, { Quarantine }] = await Promise.all([
    import('node:fs/promises'),
    import('./core/inventory'),
    import('./core/audit/cache'),
    import('./core/ops/apply'),
    import('./core/ops/quarantine'),
  ]);
  let manifest;
  try {
    manifest = ManifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    console.error(`${file} is not a Skillhangar manifest: ${(error as Error).message.split('\n')[0]}`);
    return 2;
  }
  const { inventory } = await buildInventory(new AuditCache());
  const profile = inventory.profiles.find((p) => p.isActive) ?? inventory.profiles[0];
  if (!profile) {
    console.error('No Claude Code profile found on this machine.');
    return 1;
  }
  const projectPath = opts.project ? resolve(opts.project) : undefined;
  const steps = planApply(manifest, inventory, { profileId: profile.id, projectPath });
  const installs = steps.filter((s) => s.kind === 'install-skill');
  console.log(`Manifest from ${manifest.generatedAt ?? 'an unknown date'}: ${manifest.skills.length} skills, ${manifest.mcpServers.length} MCP servers.\n`);
  for (const step of steps) {
    if (step.kind === 'install-skill') console.log(`  install  ${step.name} from ${step.source}${step.ref ? `@${step.ref.slice(0, 12)}` : ''} into ${step.destination.kind === 'project' ? step.destination.path : profile.skillsDir}`);
    else if (step.kind === 'skip-skill') console.log(`  skip     ${step.name}: ${step.reason}`);
    else if (step.kind === 'skip-mcp') console.log(`  skip     MCP ${step.name}: ${step.reason}`);
  }
  const mcp = steps.filter((s) => s.kind === 'add-mcp');
  if (mcp.length) {
    console.log('\nMCP servers are not added for you, because the manifest holds no key values. Set the variables, then run:');
    for (const step of mcp) console.log(`  ${step.command}${step.needs.length ? `   # needs ${step.needs.join(', ')}` : ''}`);
  }
  if (!installs.length) return 0;
  if (!opts.yes) {
    console.log(`\nDry run. Re-run with --yes to download, audit and install ${installs.length} skill(s).`);
    return 0;
  }
  console.log('');
  const outcomes = await executeApply(steps, inventory, new Quarantine(), opts.force);
  for (const o of outcomes) console.log(`  ${o.ok ? 'ok    ' : 'failed'} ${o.name}: ${o.message}`);
  return outcomes.every((o) => o.ok) ? 0 : 1;
}

async function cmdStop(): Promise<number> {
  const { runningServer } = await import('./server/serve');
  const info = await runningServer();
  if (!info) {
    console.log('Skillhangar is not running.');
    return 0;
  }
  process.kill(info.pid, 'SIGTERM');
  console.log(`Stopped the server on port ${info.port}.`);
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      claude: { type: 'boolean', default: false },
      model: { type: 'string', default: 'sonnet' },
      budget: { type: 'string', default: '0.5' },
      scanner: { type: 'string' },
      yes: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      project: { type: 'string' },
      port: { type: 'string' },
      dev: { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const [command = 'open', arg] = positionals;
  const port = values.port ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    console.error('--port must be a number from 1 to 65535.');
    return 2;
  }
  switch (command) {
    case 'open':
      return cmdOpen(values['no-open']);
    case 'serve':
      return cmdServe(port, values.dev, values['no-open'], values.quiet);
    case 'scan':
      return cmdScan(values.json);
    case 'audit': {
      const budget = Number(values.budget);
      if (!Number.isFinite(budget) || budget <= 0) {
        console.error('--budget must be a positive number of US dollars.');
        return 2;
      }
      return cmdAudit(arg, { json: values.json, claude: values.claude, model: values.model, budget, scanner: values.scanner });
    }
    case 'export':
      return cmdExport(arg);
    case 'apply':
      return cmdApply(arg, { yes: values.yes, force: values.force, project: values.project });
    case 'stop':
      return cmdStop();
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
);
