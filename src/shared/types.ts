// Types shared by the server and the UI. Everything here crosses the HTTP boundary, so it holds
// no secrets: MCP env and header values are reduced to key names and flags before they get here.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Verdict = 'safe' | 'caution' | 'dangerous' | 'unknown';

export type SkillScope = 'managed' | 'personal' | 'project' | 'plugin' | 'synced' | 'legacy-command' | 'agents-store';
export type McpScope = 'managed' | 'user' | 'local' | 'project' | 'plugin' | 'connector';
export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws';
export type SkillOverride = 'on' | 'name-only' | 'user-invocable-only' | 'off';

export interface Profile {
  id: string;
  label: string;
  configDir: string;
  configFile: string;
  isDefault: boolean;
  isActive: boolean;
  skillsDir: string;
  /** Real path of the skills folder; profiles that share one folder share this value. */
  skillsRealDir: string | null;
}

export interface HealthIssue {
  code: string;
  severity: Severity;
  message: string;
}

export interface GitHubRef {
  owner: string;
  repo: string;
}

export type ProvenanceKind = 'vercel-lock' | 'vercel-project-lock' | 'skillhangar' | 'plugin' | 'git' | 'frontmatter';

export interface Provenance {
  kind: ProvenanceKind;
  /** Human-readable source such as `owner/repo` or a marketplace name. */
  source: string;
  github?: GitHubRef;
  ref?: string;
  commit?: string;
  /** Path of SKILL.md (or its folder) inside the source repository. */
  skillPath?: string;
  /** Git tree SHA of the skill folder at install time, when the installer recorded it. */
  treeSha?: string;
  url?: string;
  updatedAt?: string;
}

export interface SkillMeta {
  allowedTools: string[];
  disallowedTools: string[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
  model?: string;
  effort?: string;
  context?: string;
  agent?: string;
  paths: string[];
  shell?: string;
  hasHooks: boolean;
  argumentHint?: string;
  license?: string;
  version?: string;
  unknownKeys: string[];
}

export interface SkillFiles {
  count: number;
  bytes: number;
  scripts: number;
  binaries: number;
  vendored: { dirs: string[]; files: number };
}

export interface SkillRecord {
  id: string;
  name: string;
  folderName: string;
  description: string;
  whenToUse?: string;
  scope: SkillScope;
  /** Profiles that load this skill (several when profiles share a skills folder). */
  profileIds: string[];
  projectPath?: string;
  pluginId?: string;
  path: string;
  realPath: string;
  isSymlink: boolean;
  meta: SkillMeta;
  files: SkillFiles;
  contentHash: string;
  installedAt: string | null;
  installedAtSource: 'lock' | 'skillhangar' | 'plugin' | 'git' | 'first-seen' | null;
  provenance: Provenance | null;
  contextChars: number;
  override: SkillOverride;
  shadowedBy?: string;
  health: HealthIssue[];
  /** Static audit summary; full findings come from the detail endpoint. */
  audit: AuditSummary | null;
  review: ReviewState | null;
}

export interface AuditSummary {
  verdict: Verdict;
  counts: Record<Severity, number>;
  contentHash: string;
  claude?: { verdict: Verdict; model: string; at: string; contentHash: string };
  /** Worst verdict of external scanners run on this exact content. */
  scanners?: { verdict: Verdict; names: string[] };
}

export interface ReviewState {
  reviewedAt: string;
  contentHash: string;
  changedSince: boolean;
}

export interface McpEnvKey {
  key: string;
  set: boolean;
  plaintextSecret: boolean;
}

export interface McpPackage {
  ecosystem: 'npm' | 'pypi' | 'docker';
  name: string;
  version?: string;
  pinned: boolean;
}

export type McpAuthState = 'needs-auth' | 'connected' | 'failed' | 'pending' | 'unknown' | 'not-required';

export interface McpServerRecord {
  id: string;
  name: string;
  profileIds: string[];
  scope: McpScope;
  projectPath?: string;
  pluginId?: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  host?: string;
  env: McpEnvKey[];
  headers: McpEnvKey[];
  package?: McpPackage;
  auth: { state: McpAuthState; checkedAt?: string; source: 'cache' | 'probe' | 'config' };
  health: HealthIssue[];
}

export interface PluginRecord {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  scope: string;
  enabled: boolean | null;
  installPath: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
  projectPath?: string;
  profileIds: string[];
  skillCount: number;
  marketplaceRepo?: string;
}

export interface PolicyRestrictions {
  source: string;
  keys: string[];
  strictKnownMarketplaces: boolean;
  allowedMcpServers: string[] | null;
  deniedMcpServers: string[];
}

export interface Inventory {
  generatedAt: string;
  durationMs: number;
  profiles: Profile[];
  skills: SkillRecord[];
  mcp: McpServerRecord[];
  plugins: PluginRecord[];
  projects: string[];
  policy: PolicyRestrictions[];
  context: ContextBudget;
  warnings: string[];
}

export interface ContextBudget {
  /** Characters of skill descriptions Claude sees at the start of every session. */
  totalChars: number;
  perSkillCap: number;
  overCap: number;
  /** Skills listed to Claude (not off, not user-invocable-only, not shadowed). */
  listed: number;
}

export interface Finding {
  ruleId: string;
  category: FindingCategory;
  severity: Severity;
  file: string;
  line?: number;
  evidence?: string;
  reason: string;
  fix?: string;
  source: 'static' | 'claude' | `scanner:${string}`;
}

export type FindingCategory =
  | 'hidden-instructions'
  | 'prompt-injection'
  | 'exfiltration'
  | 'credentials'
  | 'remote-code'
  | 'obfuscation'
  | 'persistence'
  | 'destructive'
  | 'over-privileged'
  | 'execution-surface'
  | 'supply-chain'
  | 'secrets'
  | 'mismatch'
  | 'hygiene';

export interface StaticAudit {
  contentHash: string;
  ruleset: string;
  at: string;
  verdict: Verdict;
  counts: Record<Severity, number>;
  findings: Finding[];
  scannedFiles: number;
  skipped: { vendoredFiles: number; largeFiles: number; binaryFiles: number };
}

export interface ClaudeAudit {
  contentHash: string;
  model: string;
  at: string;
  durationMs: number;
  costUsd: number | null;
  verdict: Verdict;
  summary: string;
  capabilities: { network: boolean; fileWrites: boolean; shell: boolean; credentials: boolean };
  descriptionMatchesBehaviour: boolean;
  findings: Finding[];
  /** Final verdict after merging with the static pass; never better than the static verdict. */
  combinedVerdict: Verdict;
}

export interface ScannerResult {
  scanner: string;
  at: string;
  ok: boolean;
  error?: string;
  findings: Finding[];
}

export interface ScannerInfo {
  id: string;
  label: string;
  homepage: string;
  available: boolean;
}

export interface SkillFileEntry {
  path: string;
  size: number;
  kind: 'text' | 'binary' | 'vendored' | 'symlink';
}

export interface SkillDetail {
  skill: SkillRecord;
  skillMd: string;
  files: SkillFileEntry[];
  staticAudit: StaticAudit;
  claudeAudits: ClaudeAudit[];
  scanners: ScannerResult[];
  snapshots: SnapshotInfo[];
  usage: SkillUsage | null;
}

export interface SnapshotInfo {
  id: string;
  skillPath: string;
  name: string;
  reason: string;
  createdAt: string;
  contentHash: string;
}

export interface TrashItem {
  id: string;
  originalPath: string;
  name: string;
  kind: 'skill' | 'snapshot-replaced';
  trashedAt: string;
}

export interface SkillUsage {
  name: string;
  count: number;
  lastUsed: string | null;
  source: 'hook' | 'transcripts';
}

export interface UsageReport {
  hookInstalled: Record<string, boolean>;
  since: string | null;
  skills: SkillUsage[];
  estimatedFromTranscripts: boolean;
}

export interface RepoInfo {
  key: string;
  stars: number;
  pushedAt: string | null;
  license: string | null;
  archived: boolean;
  description: string | null;
  defaultBranch: string | null;
  url: string;
  fetchedAt: string;
}

export interface SkillsShInfo {
  installs: number | null;
  /** When the install count was last fetched; counts are re-fetched after a week. */
  fetchedAt?: string;
  partners: Record<string, { risk: string; score?: number; alerts?: number; analyzedAt?: string }>;
}

export interface UpdateInfo {
  skillId: string;
  state: 'up-to-date' | 'available' | 'unknown' | 'untracked';
  /** Tree SHA or commit upstream, when known. */
  latest?: string;
  latestDate?: string;
  latestMessage?: string;
  reason?: string;
}

export interface PackageInfo {
  key: string;
  latest: string | null;
  vulns: { id: string; summary: string }[];
  fetchedAt: string;
}

export interface Enrichment {
  enabled: boolean;
  fetchedAt: string | null;
  repos: Record<string, RepoInfo>;
  trending: Record<string, string[]>;
  trendingIndexedThrough: string | null;
  skillsSh: Record<string, SkillsShInfo>;
  scorecards: Record<string, { score: number; date: string } | null>;
  updates: Record<string, UpdateInfo>;
  packages: Record<string, PackageInfo>;
  errors: string[];
  rateLimit: { remaining: number; limit: number; resetAt: string } | null;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'removed' | 'modified';
  binary: boolean;
  /** Unified diff for text files, truncated when large. */
  patch?: string;
  truncated?: boolean;
}

export interface QuarantineSkill {
  relPath: string;
  name: string;
  description: string;
  contentHash: string;
  audit: StaticAudit;
}

export interface QuarantineItem {
  id: string;
  createdAt: string;
  source: SourceSpec;
  commit?: string;
  skills: QuarantineSkill[];
}

export type SourceSpec =
  | { kind: 'github'; owner: string; repo: string; ref?: string; subpath?: string; skill?: string }
  | { kind: 'local'; path: string };

export interface UpdatePreview {
  skillId: string;
  quarantineId: string;
  method: 'vercel-cli' | 'skillhangar' | 'git';
  fromHash: string;
  toHash: string;
  diff: DiffFile[];
  auditBefore: StaticAudit;
  auditAfter: StaticAudit;
  /** Findings at critical or high severity that the new version adds. */
  newSerious: Finding[];
}

export type InstallDestination =
  | { kind: 'profile'; profileId: string }
  | { kind: 'project'; path: string };

export interface ActivityEntry {
  id: string;
  at: string;
  action: string;
  target: string;
  detail?: string;
  undo?: { kind: 'trash-restore' | 'snapshot-restore' | 'override-restore' | 'remove-install'; ref: string };
  undone?: boolean;
}

export interface JobInfo {
  id: string;
  kind: 'claude-audit' | 'trending-index' | 'enrichment' | 'scan' | 'mcp-probe' | 'scanner';
  label: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress?: { done: number; total: number };
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  targetId?: string;
}

export interface Settings {
  network: { enabled: boolean; decidedAt: string | null };
  audit: { defaultModel: string; budgetUsd: number; maxTurns: number };
  projects: string[];
  theme: 'system' | 'light' | 'dark';
}

export type ServerEvent =
  | { type: 'inventory'; generatedAt: string }
  | { type: 'job'; job: JobInfo }
  | { type: 'enrichment'; fetchedAt: string }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'fs-change'; paths: string[] };

export const MODEL_CHOICES = [
  { id: 'haiku', label: 'Haiku', note: 'Fastest, lowest cost' },
  { id: 'sonnet', label: 'Sonnet', note: 'Balanced' },
  { id: 'opus', label: 'Opus', note: 'Most thorough' },
  { id: 'fable', label: 'Fable', note: 'Highest capability' },
] as const;

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const VERDICT_RANK: Record<Verdict, number> = { unknown: 0, safe: 1, caution: 2, dangerous: 3 };
export const DESCRIPTION_CAP = 1536;
