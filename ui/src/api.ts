import type {
  ActivityEntry,
  ClaudeAudit,
  Enrichment,
  InstallDestination,
  Inventory,
  JobInfo,
  QuarantineItem,
  ScannerInfo,
  Settings,
  SkillDetail,
  SkillOverride,
  TrashItem,
  UpdatePreview,
  UsageReport,
} from '@shared/types';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let csrf = '';

/**
 * Exchanges the one-time launch token in the URL fragment for a session cookie, then removes the token
 * from the address bar and history. On a reload (no token) the cookie is reused.
 */
export async function startSession(): Promise<void> {
  const match = /[#&]token=([\w-]+)/.exec(location.hash);
  if (match) {
    history.replaceState(null, '', `${location.pathname}#/`);
    const response = await fetch('/api/session', { method: 'POST', headers: { 'x-skillhangar-token': match[1]! }, credentials: 'same-origin' });
    if (!response.ok) throw new ApiError('UNAUTHORIZED', 'This link has expired. Run skillhangar again to get a new one.', response.status);
    csrf = ((await response.json()) as { csrf: string }).csrf;
    return;
  }
  const response = await fetch('/api/csrf', { credentials: 'same-origin' });
  if (!response.ok) throw new ApiError('UNAUTHORIZED', 'Open Skillhangar with the link it printed in your terminal.', response.status);
  csrf = ((await response.json()) as { csrf: string }).csrf;
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-skillhangar-csrf': csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new ApiError(payload?.error?.code ?? 'HTTP', payload?.error?.message ?? `Request failed (${response.status})`, response.status);
  }
  return (await response.json()) as T;
}

export interface OriginCandidate {
  owner: string;
  repo: string;
  skillPath: string;
  installs: number | null;
  match: 'exact' | 'similar' | 'different';
  similarity: number;
}

export interface AuditOptions {
  model: string;
  budgetUsd: number;
  maxTurns: number;
}

export const api = {
  inventory: (refresh = false) => request<Inventory>('GET', `/inventory${refresh ? '?refresh=1' : ''}`),
  enrichment: () => request<Enrichment>('GET', '/enrichment'),
  refreshEnrichment: () => request<{ job: JobInfo }>('POST', '/enrichment/refresh', {}),
  buildTrending: () => request<{ job: JobInfo }>('POST', '/trending/build', {}),
  skill: (id: string) => request<SkillDetail>('GET', `/skills/${id}`),
  file: (id: string, path: string) => request<{ path: string; text: string; truncated: boolean }>('GET', `/skills/${id}/file?path=${encodeURIComponent(path)}`),
  audit: (id: string, options: AuditOptions) => request<{ job: JobInfo }>('POST', `/skills/${id}/audit`, options),
  review: (id: string) => request<{ ok: true }>('POST', `/skills/${id}/review`, {}),
  override: (id: string, value: SkillOverride) => request<{ ok: true }>('POST', `/skills/${id}/override`, { value }),
  remove: (id: string) => request<{ ok: true; trashId: string }>('POST', `/skills/${id}/remove`, {}),
  checkUpdate: (id: string) => request<UpdatePreview>('POST', `/skills/${id}/update/check`, {}),
  applyUpdate: (id: string, acknowledgeRisk: boolean) => request<{ ok: true; warning: string | null }>('POST', `/skills/${id}/update/apply`, { acknowledgeRisk }),
  trace: (id: string) => request<{ candidates: OriginCandidate[] }>('POST', `/skills/${id}/trace`, {}),
  linkOrigin: (id: string, origin: { owner: string; repo: string; skillPath: string }) => request<unknown>('POST', `/skills/${id}/link-origin`, origin),
  copy: (id: string, destination: InstallDestination, mode: 'copy' | 'symlink') => request<{ ok: true }>('POST', `/skills/${id}/copy`, { destination, mode }),
  fetchSource: (source: string) => request<QuarantineItem>('POST', '/install/fetch', { source }),
  auditQuarantine: (qid: string, relPath: string, options: AuditOptions) => request<{ job: JobInfo }>('POST', `/install/${qid}/audit`, { ...options, relPath }),
  install: (input: { quarantineId: string; relPath: string; destination: InstallDestination; mode: 'copy' | 'symlink'; acknowledgeRisk: boolean }) =>
    request<{ ok: true; path: string }>('POST', '/install/apply', input),
  discard: (qid: string) => request<{ ok: true }>('DELETE', `/install/${qid}`),
  auditsByHash: (hash: string) => request<{ audits: ClaudeAudit[] }>('GET', `/audits/hash/${hash}`),
  audits: () => request<{ audits: ClaudeAudit[]; jobs: JobInfo[] }>('GET', '/audits'),
  scanners: () => request<{ scanners: ScannerInfo[] }>('GET', '/scanners'),
  runScanner: (id: string, scanner: string) => request<{ job: JobInfo }>('POST', `/skills/${id}/scan`, { scanner }),
  jobs: () => request<{ jobs: JobInfo[] }>('GET', '/jobs'),
  cancelJob: (id: string) => request<{ ok: boolean }>('POST', `/jobs/${id}/cancel`, {}),
  probe: (profileId: string, cwd?: string) => request<{ job: JobInfo }>('POST', '/mcp/probe', { profileId, cwd }),
  addMcp: (input: { profileId: string; name: string; scope: 'user' | 'project' | 'local'; projectPath?: string; config: Record<string, unknown> }) => request<{ ok: true }>('POST', '/mcp', input),
  removeMcp: (id: string) => request<{ ok: true }>('DELETE', `/mcp/${id}`),
  pluginAction: (id: string, action: 'enable' | 'disable' | 'update' | 'uninstall', profileId: string) => request<{ ok: true }>('POST', `/plugins/${encodeURIComponent(id)}/action`, { action, profileId }),
  activity: () => request<{ entries: ActivityEntry[] }>('GET', '/activity'),
  undo: (id: string) => request<{ ok: true }>('POST', `/activity/${id}/undo`, {}),
  trash: () => request<{ items: TrashItem[] }>('GET', '/trash'),
  restoreTrash: (id: string) => request<{ ok: true }>('POST', `/trash/${id}/restore`, {}),
  restoreSnapshot: (id: string) => request<{ ok: true }>('POST', `/snapshots/${id}/restore`, {}),
  settings: () => request<Settings>('GET', '/settings'),
  saveSettings: (patch: Partial<Pick<Settings, 'theme' | 'projects'>> & { network?: { enabled: boolean }; audit?: Partial<Settings['audit']> }) => request<Settings>('PUT', '/settings', patch),
  usage: (transcripts = false) => request<UsageReport>('GET', `/usage${transcripts ? '?transcripts=1' : ''}`),
  usageHook: (profileId: string, enabled: boolean) => request<{ ok: true }>('POST', '/usage/hook', { profileId, enabled }),
};
