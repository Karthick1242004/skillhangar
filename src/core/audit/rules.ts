import type { FindingCategory, Severity } from '../../shared/types';

/** Bump when a rule changes, so cached static audits are recomputed. */
export const RULESET_VERSION = '2026.11.13-3';

export type FileKind = 'skill-md' | 'markdown' | 'script' | 'other';

export interface FileContext {
  rel: string;
  kind: FileKind;
  text: string;
  lines: string[];
  /** For scripts: the same lines with comment-only lines blanked, so line numbers still match. */
  codeLines: string[];
}

export interface RuleHit {
  line: number;
  evidence: string;
  severity?: Severity;
  reason?: string;
}

export interface Rule {
  id: string;
  category: FindingCategory;
  /** Severity per file kind; a kind left out is not checked by this rule. */
  severity: Partial<Record<FileKind, Severity>>;
  reason: string;
  fix: string;
  pattern?: RegExp;
  /** In scripts, match only code lines: a comment that names ~/.aws/credentials does not read it. */
  codeOnly?: boolean;
  /** Whole-file check for patterns that span lines or need context. */
  check?: (file: FileContext) => RuleHit[];
}

const ALL = (s: Severity): Rule['severity'] => ({ 'skill-md': s, markdown: s, script: s, other: s });
const DOCS_SCRIPTS = (docs: Severity, scripts: Severity): Rule['severity'] => ({ 'skill-md': docs, markdown: docs, script: scripts, other: docs });

export const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-(?:api|admin)\d{0,2}-[\w-]{20,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bgithub_pat_\w{60,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-\d+-[\w-]{10,}/,
  /\bAIza[\w-]{35}\b/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/,
];

const NETWORK = /\b(curl|wget|Invoke-WebRequest|iwr|irm)\b|requests\.(get|post|put|patch)\(|\bfetch\(|https?\.request\(|urllib\.request|http\.client|socket\.(socket|connect)|\bnc\s+-|\baxios\b|XMLHttpRequest|new WebSocket\(/;
const SENSITIVE_READ = /~\/\.ssh|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.netrc\b|\.config\/gh\/hosts|\.credentials\.json|security\s+find-(generic|internet)-password|JSON\.stringify\(\s*process\.env\s*\)|json\.dumps\(\s*(dict\()?os\.environ|\bprintenv\b|Login Data|Cookies\.binarycookies/;

export const RULES: Rule[] = [
  // Hidden instructions
  {
    id: 'bidi-control',
    category: 'hidden-instructions',
    severity: ALL('critical'),
    pattern: /[\u202A-\u202E\u2066-\u2069]/,
    reason: 'Text-direction control characters can make the text a reviewer reads differ from what Claude or a shell receives.',
    fix: 'Delete the direction-control characters; legitimate skills never need them.',
  },
  {
    id: 'unicode-tags',
    category: 'hidden-instructions',
    severity: ALL('critical'),
    pattern: /[\u{E0000}-\u{E007F}]/u,
    reason: 'Unicode tag characters are invisible but readable by a model, the known way to smuggle hidden instructions.',
    fix: 'Delete the tag characters and read the decoded text they carried.',
  },
  {
    id: 'zero-width',
    category: 'hidden-instructions',
    severity: { 'skill-md': 'high', markdown: 'high', script: 'medium', other: 'low' },
    check: (file) => {
      const hits: RuleHit[] = [];
      file.lines.forEach((line, i) => {
        // A zero-width space just before ``` is the usual way to show a literal fence inside a fence.
        const text = (i === 0 ? line.replace(/^\uFEFF/, '') : line).replace(/\u200B(?=`{3})/g, '');
        if (/[\u200B-\u200D\u2060\uFEFF]/.test(text)) hits.push({ line: i + 1, evidence: line });
      });
      return hits;
    },
    reason: 'Zero-width characters hide text from a human reader while a model still reads it.',
    fix: 'Remove the zero-width characters and check what the surrounding text says without them.',
  },
  {
    id: 'html-comment-instruction',
    category: 'hidden-instructions',
    severity: { 'skill-md': 'high', markdown: 'high' },
    check: (file) => {
      const hits: RuleHit[] = [];
      for (const m of file.text.matchAll(/<!--([\s\S]*?)-->/g)) {
        if (/\b(ignore|disregard|you (must|should|are)|do not (tell|mention|reveal)|instruction|system prompt|secretly|always run|execute|curl|send|upload|assistant)\b/i.test(m[1] ?? '')) {
          hits.push({ line: lineOf(file.text, m.index ?? 0), evidence: m[0] });
        }
      }
      return hits;
    },
    reason: 'An HTML comment is invisible when the markdown is rendered but is read by Claude as part of the skill.',
    fix: 'Move any real guidance into visible text, or delete the comment.',
  },
  {
    id: 'hidden-styled-text',
    category: 'hidden-instructions',
    severity: { 'skill-md': 'high', markdown: 'medium' },
    pattern: /<(span|div|p|font)\b[^>]*style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?!\.)|color\s*:\s*(white|#fff\b|#ffffff\b|transparent))/i,
    reason: 'Text styled to be invisible in a rendered view is still read in full by Claude.',
    fix: 'Make the text visible or delete it.',
  },

  // Prompt injection
  {
    id: 'override-instructions',
    category: 'prompt-injection',
    severity: { 'skill-md': 'high', markdown: 'high', other: 'medium' },
    check: (file) => {
      const re = /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(all|any|previous|prior|above|earlier|system|your|the user'?s?)\b[^.\n]{0,24}\b(instructions?|prompts?|rules?|guidelines?|directives?|guardrails?)\b/i;
      const hits: RuleHit[] = [];
      file.lines.forEach((line, i) => {
        const m = re.exec(line);
        if (!m) return;
        // Security guidance quotes the phrase as an example ("ignore previous instructions"); that is not an instruction.
        const before = line.slice(0, m.index);
        if (/["“'`(]\s*$/.test(before) || /\b(e\.g\.|such as|like|for example|contains?|says?|tries to|attempts? to)\b[^.]{0,30}$/i.test(before)) return;
        hits.push({ line: i + 1, evidence: line });
      });
      return hits;
    },
    reason: 'Telling Claude to ignore its other instructions is the classic prompt-injection move.',
    fix: 'Rewrite as guidance that adds to Claude\'s instructions instead of overriding them.',
  },
  {
    id: 'conceal-from-user',
    category: 'prompt-injection',
    severity: { 'skill-md': 'high', markdown: 'high', script: 'medium', other: 'medium' },
    pattern: /\b(do not|don't|never)\s+(tell|inform|notify|alert)\s+(the\s+)?(user|human|operator)\b(?!\s+to\b)|\b(do not|don't|never)\s+(mention|reveal|disclose|show)\b[^.\n]{0,40}\bto\s+the\s+(user|human)\b(?![^.\n]{0,24}\b(until|before|yet|unless)\b)|\b(hide|conceal)\b[^.\n]{0,30}\bfrom\s+the\s+(user|human)\b|\b(secretly|covertly|discreetly)\s+\w+|\bsilently\s+(send|upload|install|post|exfiltrate|copy|transmit)\b/i,
    reason: 'An instruction to act without the user knowing removes the person from the loop.',
    fix: 'Delete the instruction. A skill should never ask Claude to hide what it does.',
  },
  {
    id: 'act-without-consent',
    category: 'prompt-injection',
    severity: { 'skill-md': 'medium', markdown: 'low' },
    pattern: /\bwithout\s+(asking|telling|informing|notifying|confirming with)\s+(the\s+)?(user|human)\b/i,
    reason: 'Tells Claude to act without checking with the user first.',
    fix: 'Confirm the actions this covers are safe to run unattended.',
  },
  {
    id: 'audit-evasion',
    category: 'prompt-injection',
    severity: ALL('critical'),
    pattern: /\b(report|mark|classify|rate|label|declare)\s+(this|it|the\s+(skill|file|code|package))\s+(as\s+)?(safe|benign|harmless|clean)\b|\b(auditors?|security\s+(reviewers?|scanners?)|(AI|LLM|model)\s+(auditors?|reviewers?|scanners?))\b[^.\n]{0,60}\b(safe|benign|harmless|approve|pass)\b/i,
    reason: 'Text that addresses a security reviewer and steers its verdict exists only to get past an audit.',
    fix: 'Treat the skill as hostile until the text is explained; legitimate skills do not address their auditors.',
  },
  {
    id: 'role-hijack',
    category: 'prompt-injection',
    severity: { 'skill-md': 'medium', markdown: 'medium' },
    pattern: /\byou are now\b|\bnew system prompt\b|<\/?system>|\[\s*system\s*\]|\bdeveloper mode\b|\bjailbreak\b/i,
    reason: 'Role and system-prompt markers try to make skill text look like higher-priority instructions.',
    fix: 'Remove the markers; skill text is user-level guidance, not a system prompt.',
  },
  {
    id: 'permission-bypass',
    category: 'over-privileged',
    severity: DOCS_SCRIPTS('high', 'high'),
    pattern: /--dangerously-skip-permissions|\bbypassPermissions\b|--permission-mode[ =]bypass/i,
    reason: 'Turning off permission prompts lets every tool call run without the user approving it.',
    fix: 'Remove the flag and pre-approve the specific commands the skill needs with allowed-tools.',
  },

  // Remote code
  {
    id: 'pipe-to-shell',
    category: 'remote-code',
    severity: DOCS_SCRIPTS('medium', 'critical'),
    codeOnly: true,
    pattern: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)|\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]*\|\s*(iex|Invoke-Expression)|\bbase64\s+(-d|--decode|-D)\b[^|\n]*\|\s*(ba|z)?sh\b/i,
    reason: 'Downloads code and runs it immediately, so what runs is whatever the server returns at that moment.',
    fix: 'Pin the download to a version and checksum, or install through a package manager with a pinned version.',
  },
  {
    id: 'remote-eval',
    category: 'remote-code',
    severity: { script: 'critical', 'skill-md': 'high', markdown: 'high', other: 'high' },
    pattern: /\b(exec|eval)\s*\(\s*(requests\.get|urllib\.request\.urlopen|urlopen|await\s+fetch|fetch)\(|new\s+Function\(\s*await\s+|\bimport\(\s*['"`]https?:/i,
    reason: 'Fetches code over the network and evaluates it in-process.',
    fix: 'Ship the code inside the skill so it can be reviewed and hashed.',
  },
  {
    id: 'download-and-run',
    category: 'remote-code',
    severity: DOCS_SCRIPTS('medium', 'high'),
    pattern: /\b(curl|wget)\b[^\n]*(-o|-O|--output)\s+\S+[^\n]*(&&|;)\s*(chmod\s+\+x|\.\/|sh\s|bash\s|python3?\s)/i,
    reason: 'Downloads a file and executes it in the same command line.',
    fix: 'Verify a checksum before running a downloaded file, or vendor the file into the skill.',
  },

  // Supply chain
  {
    id: 'unpinned-npx',
    category: 'supply-chain',
    severity: { 'skill-md': 'medium', markdown: 'low', script: 'medium', other: 'low' },
    check: (file) => {
      const hits: RuleHit[] = [];
      file.lines.forEach((line, i) => {
        for (const m of line.matchAll(/\b(npx|bunx|pnpm\s+dlx)\s+((?:-{1,2}[\w-]+\s+)*)(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)(@[\w.^~<>=*-]+)?/gi)) {
          const pkg = m[3]!;
          const version = m[4];
          if (pkg.startsWith('-') || /^(tsc|tsx|vite|next|eslint|prettier|vitest|jest)$/.test(pkg)) continue;
          if (!version || /@(latest|next|\*)$/i.test(version)) hits.push({ line: i + 1, evidence: line });
        }
      });
      return hits;
    },
    reason: 'Runs a package from the registry without a pinned version, so a new publish changes what runs.',
    fix: 'Pin the package to an exact version, such as `npx -y package@1.2.3`.',
  },
  {
    id: 'install-from-url',
    category: 'supply-chain',
    severity: DOCS_SCRIPTS('low', 'medium'),
    pattern: /\bpip3?\s+install\s+[^\n]*(git\+https?:|https?:\/\/)|\bnpm\s+(i|install)\s+[^\n]*(https?:\/\/|github:|git\+)|\bgo\s+install\s+\S+@latest\b/i,
    reason: 'Installs a dependency straight from a URL or a moving tag, bypassing registry versioning.',
    fix: 'Install a released, pinned version from the registry.',
  },

  // Credentials and secrets
  {
    id: 'credential-access',
    category: 'credentials',
    severity: DOCS_SCRIPTS('medium', 'high'),
    codeOnly: true,
    pattern: /~\/\.ssh\b|\$HOME\/\.ssh\b|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.netrc\b|\.pypirc\b|\.docker\/config\.json|\.kube\/config|\.config\/gh\/hosts\.yml|\.credentials\.json|login\.keychain|security\s+find-(generic|internet)-password|Library\/Application Support\/(Google\/Chrome|Firefox|BraveSoftware)[^\n]*(Cookies|Login Data)/i,
    reason: 'References a credential store (SSH keys, cloud credentials, keychain, browser logins).',
    fix: 'Confirm the skill truly needs this access; most skills never read credential files.',
  },
  {
    id: 'env-dump',
    category: 'credentials',
    severity: DOCS_SCRIPTS('medium', 'high'),
    codeOnly: true,
    pattern: /JSON\.stringify\(\s*process\.env\s*\)|json\.dumps\(\s*(dict\()?os\.environ|\bprintenv\s*(\||>)|\benv\s*\|\s*(curl|nc|base64|tee)\b|\bset\s*\|\s*(curl|nc)\b/i,
    reason: 'Serializes or sends the whole environment, which usually holds API keys and tokens.',
    fix: 'Read only the specific variables the skill needs.',
  },
  {
    id: 'hardcoded-secret',
    category: 'secrets',
    severity: ALL('high'),
    check: (file) => {
      const hits: RuleHit[] = [];
      file.lines.forEach((line, i) => {
        const keyHeader = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/.test(line);
        if (keyHeader) {
          const following = `${line}\n${file.lines[i + 1] ?? ''}`.replace(/\\n/g, '\n');
          if (/PRIVATE KEY( BLOCK)?-----\s*\n\s*[A-Za-z0-9+/=]{40,}/.test(following)) hits.push({ line: i + 1, evidence: maskSecrets(line) });
          return;
        }
        if (SECRET_PATTERNS.some((re) => re.test(line))) hits.push({ line: i + 1, evidence: maskSecrets(line) });
      });
      return hits;
    },
    reason: 'A live-looking credential is stored in the skill, where anyone who installs it can read it.',
    fix: 'Revoke the credential and load it from an environment variable instead.',
  },

  // Exfiltration
  {
    id: 'exfil-endpoint',
    category: 'exfiltration',
    severity: ALL('critical'),
    codeOnly: true,
    pattern: /webhook\.site|requestbin|pipedream\.net|\bngrok(-free)?\.(io|app|dev)|interact\.sh|\boast\.(fun|me|pro|live|site|online)\b|burpcollaborator|pastebin\.com\/api|transfer\.sh|canarytokens\.(com|org)/i,
    reason: 'Points at a service whose main use is catching data sent to it (request bins, tunnels, paste and file drops).',
    fix: 'Remove the endpoint unless its purpose is documented and expected for this skill.',
  },
  {
    id: 'chat-webhook',
    category: 'exfiltration',
    severity: { script: 'medium', 'skill-md': 'low', markdown: 'low' },
    codeOnly: true,
    pattern: /discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|hooks\.slack\.com\/services/i,
    reason: 'Sends messages to a chat webhook or bot. Legitimate for notification skills, and also a common way to move data out.',
    fix: 'Confirm that posting to chat is what this skill is for, and check what it sends.',
  },
  {
    id: 'secret-plus-network',
    category: 'exfiltration',
    severity: { script: 'high' },
    check: (file) => {
      const code = file.codeLines.join('\n');
      if (!NETWORK.test(code)) return [];
      if (SENSITIVE_READ.test(code)) {
        const index = file.codeLines.findIndex((l) => NETWORK.test(l));
        return [{ line: index + 1, evidence: file.lines[index] ?? '' }];
      }
      // A secret read from the environment whose variable then lands in a request body, not an auth header.
      for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:os\.environ\.get|os\.getenv|os\.environ\[|process\.env\.|process\.env\[)\s*\(?\s*['"]?([A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|APIKEY|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*)/g)) {
        const variable = m[1]!;
        const sink = new RegExp(`\\b(data|json|body|params|form)\\s*[=:][^\\n]*\\b${variable}\\b`);
        const index = file.codeLines.findIndex((l) => sink.test(l));
        if (index >= 0) return [{ line: index + 1, evidence: file.lines[index] ?? '', reason: `${m[2]} is read from the environment and sent in a request body.` }];
      }
      return [];
    },
    reason: 'The same script reads secrets or credentials and makes network requests, the shape of an exfiltration.',
    fix: 'Check where the network call sends data and that no secret reaches it.',
  },

  // Obfuscation
  {
    id: 'eval-decoded',
    category: 'obfuscation',
    severity: ALL('high'),
    pattern: /\b(eval|exec)\s*\(\s*(base64\.b64decode|atob|codecs\.decode|bytes\.fromhex|zlib\.decompress|Buffer\.from\()|\bmarshal\.loads\(|\bpickle\.loads\(\s*(base64|requests|urllib)/i,
    reason: 'Decodes data at run time and executes it, hiding the real code from review.',
    fix: 'Replace the encoded payload with readable source.',
  },
  {
    id: 'base64-blob',
    category: 'obfuscation',
    severity: ALL('medium'),
    check: (file) => {
      const hits: RuleHit[] = [];
      file.lines.forEach((line, i) => {
        for (const m of line.matchAll(/[A-Za-z0-9+/]{240,}={0,2}/g)) {
          const before = line.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
          if (/data:(image|font|audio|video)\/|base64,$/.test(before)) continue;
          const decoded = Buffer.from(m[0].slice(0, 2000), 'base64').toString('utf8');
          const printable = decoded.replace(/[^\x20-\x7E\n\t]/g, '').length / Math.max(1, decoded.length);
          const codeLike = printable > 0.9 && /\b(curl|wget|bash|eval|exec|import|require|http|subprocess|powershell)\b/.test(decoded);
          hits.push({
            line: i + 1,
            evidence: `${m[0].slice(0, 60)}... (${m[0].length} chars)`,
            severity: codeLike ? 'high' : undefined,
            reason: codeLike ? `A base64 blob that decodes to code: "${decoded.slice(0, 80).replace(/\s+/g, ' ')}"` : undefined,
          });
        }
      });
      return hits;
    },
    reason: 'A long base64 string can carry hidden code or instructions.',
    fix: 'Decode it and confirm what it is; ship readable files instead of encoded ones.',
  },
  {
    id: 'escape-dense',
    category: 'obfuscation',
    severity: { script: 'medium', other: 'low' },
    check: (file) => {
      const hits: RuleHit[] = [];
      file.lines.forEach((line, i) => {
        const escapes = line.match(/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|\\[0-7]{3}/gi)?.length ?? 0;
        const charCodes = line.match(/(fromCharCode|chr)\(\s*\d+/g)?.length ?? 0;
        if (escapes >= 24 || charCodes >= 8) hits.push({ line: i + 1, evidence: line });
      });
      return hits;
    },
    reason: 'Dense character escapes or char-code chains are a common way to hide strings from review.',
    fix: 'Write the strings out plainly.',
  },

  // Persistence and tampering
  {
    id: 'agent-config-write',
    category: 'persistence',
    severity: DOCS_SCRIPTS('medium', 'high'),
    pattern: /(>>?|\btee\b|writeFile|write_text|appendFile|open\([^)]*['"][wa]['"]|\bcp\b|\bmv\b|\bln\s+-s)[^\n]{0,100}(\.claude\/settings(\.local)?\.json|\.claude\.json|\bCLAUDE\.md|\bAGENTS\.md|\.mcp\.json|\.claude\/hooks|\.claude\/(skills|agents|commands)\/)/i,
    reason: 'Writes to Claude Code configuration, instructions, hooks or other skills, which changes how every later session behaves.',
    fix: 'A skill should ask the user to make such changes, not write them itself.',
  },
  {
    id: 'shell-profile-write',
    category: 'persistence',
    severity: DOCS_SCRIPTS('medium', 'high'),
    pattern: /(>>|\btee\s+-a|appendFile|write_text|open\([^)]*['"]a['"])[^\n]{0,80}(\.bashrc|\.zshrc|\.bash_profile|\.zprofile|\.profile\b|config\.fish|Microsoft\.PowerShell_profile)/i,
    reason: 'Appends to a shell start-up file, so code runs in every new terminal.',
    fix: 'Print the line for the user to add instead of writing it.',
  },
  {
    id: 'scheduled-task',
    category: 'persistence',
    severity: DOCS_SCRIPTS('medium', 'high'),
    pattern: /\bcrontab\s+(-[a-z]\s+)*-?\s*\S|\bLaunch(Agents|Daemons)\b|\blaunchctl\s+(load|bootstrap|submit)|\bsystemctl\s+(--user\s+)?enable\b|\bschtasks\s+\/create\b|CurrentVersion\\Run\b/i,
    reason: 'Registers a scheduled or start-up task that keeps running after the session ends.',
    fix: 'Confirm the skill is meant to install a background service and that the user is told.',
  },

  // Destructive
  {
    id: 'destructive-delete',
    category: 'destructive',
    severity: ALL('critical'),
    pattern: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*["']?(\/|~\/?|\$HOME\/?|\$\{HOME\}\/?)\*?["']?(\s|;|&|\||$)|\bmkfs\.\w+|\bdd\s+[^\n]*of=\/dev\/(disk|sd|nvme|rdisk)|\bdiskutil\s+(eraseDisk|zeroDisk|secureErase)|\bshred\s+[^\n]*\/dev\//i,
    reason: 'Deletes the home folder, the root filesystem or a whole disk.',
    fix: 'Remove the command.',
  },

  // Execution surface in SKILL.md
  {
    id: 'inline-shell',
    category: 'execution-surface',
    severity: { 'skill-md': 'medium', markdown: 'medium' },
    check: (file) => {
      if (file.kind === 'markdown' && !/\.claude\/commands\//.test(file.rel) && file.rel !== 'SKILL.md') return [];
      const hits: RuleHit[] = [];
      file.lines.forEach((line, i) => {
        const inline = /(^|\s)!`([^`]+)`/.exec(line);
        const block = /^\s*```!/.test(line);
        if (!inline && !block) return;
        const command = inline?.[2] ?? file.lines[i + 1] ?? '';
        const risky = NETWORK.test(command) || /\b(rm|sudo|chmod|eval)\b/.test(command);
        hits.push({
          line: i + 1,
          evidence: line,
          severity: risky ? 'high' : undefined,
          reason: risky ? `Runs "${command.trim().slice(0, 80)}" in a shell when the skill loads, before Claude or the user sees the output.` : undefined,
        });
      });
      return hits;
    },
    reason: 'Shell command that Claude Code runs as the skill loads, before Claude reads the result.',
    fix: 'Check the command is read-only and expected; it runs with the user\'s permissions.',
  },
];

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function maskSecrets(line: string): string {
  let out = line;
  for (const re of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), (m) => `${m.slice(0, 6)}…[redacted]`);
  return out;
}

/** Makes invisible and control characters visible in evidence, so a reviewer can see what is hidden. */
export function revealHidden(text: string): string {
  return text.replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|[\u{E0000}-\u{E007F}]/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0020 && cp <= 0xe007e) return `[TAG ${String.fromCharCode(cp - 0xe0000)}]`;
    return `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`;
  });
}
