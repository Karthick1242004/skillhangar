import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { Enrichment, Inventory, JobInfo, ServerEvent, SkillRecord, SkillsShInfo, UpdateInfo, Verdict, RepoInfo } from '@shared/types';

export const keys = {
  inventory: ['inventory'] as const,
  enrichment: ['enrichment'] as const,
  settings: ['settings'] as const,
  jobs: ['jobs'] as const,
  skill: (id: string) => ['skill', id] as const,
  activity: ['activity'] as const,
  trash: ['trash'] as const,
  audits: ['audits'] as const,
  usage: ['usage'] as const,
};

export const useInventory = () => useQuery({ queryKey: keys.inventory, queryFn: () => api.inventory(), staleTime: Infinity });
export const useEnrichment = () => useQuery({ queryKey: keys.enrichment, queryFn: api.enrichment, staleTime: Infinity });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.settings, staleTime: Infinity });
export const useJobs = () => useQuery({ queryKey: keys.jobs, queryFn: async () => (await api.jobs()).jobs, staleTime: Infinity });

/**
 * One event stream per tab. The server pushes changes (a rescan, a job's progress, new enrichment), and
 * each event invalidates or patches exactly the queries it affects, so nothing polls.
 */
export function useServerEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    const source = new EventSource('/api/events', { withCredentials: true });
    source.onmessage = (message) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(message.data) as ServerEvent;
      } catch {
        return;
      }
      handleEvent(client, event);
    };
    // EventSource reconnects by itself; after a reconnect, refetch what may have changed meanwhile.
    source.onopen = () => void client.invalidateQueries({ queryKey: keys.jobs });
    return () => source.close();
  }, [client]);
}

function handleEvent(client: QueryClient, event: ServerEvent): void {
  switch (event.type) {
    case 'inventory':
      void client.invalidateQueries({ queryKey: keys.inventory });
      void client.invalidateQueries({ queryKey: ['skill'] });
      break;
    case 'enrichment':
      void client.invalidateQueries({ queryKey: keys.enrichment });
      break;
    case 'activity':
      void client.invalidateQueries({ queryKey: keys.activity });
      void client.invalidateQueries({ queryKey: keys.trash });
      break;
    case 'job': {
      client.setQueryData<JobInfo[]>(keys.jobs, (jobs = []) => {
        const rest = jobs.filter((j) => j.id !== event.job.id);
        return [event.job, ...rest].slice(0, 60);
      });
      if (event.job.state === 'done' || event.job.state === 'failed') {
        if (event.job.kind === 'claude-audit' || event.job.kind === 'scanner') {
          void client.invalidateQueries({ queryKey: keys.audits });
          if (event.job.targetId) void client.invalidateQueries({ queryKey: keys.skill(event.job.targetId) });
          void client.invalidateQueries({ queryKey: ['audit-hash'] });
        }
        if (event.job.kind === 'enrichment' || event.job.kind === 'trending-index') void client.invalidateQueries({ queryKey: keys.enrichment });
        if (event.job.kind === 'mcp-probe') void client.invalidateQueries({ queryKey: keys.inventory });
      }
      break;
    }
    case 'fs-change':
      break;
  }
}

/** A skill joined with everything known about its source. Computed once per inventory or enrichment change. */
export interface SkillView extends SkillRecord {
  repoKey: string | null;
  repo: RepoInfo | null;
  trendingDays: string[];
  skillsSh: SkillsShInfo | null;
  update: UpdateInfo | null;
  verdict: Verdict;
  needsReview: boolean;
}

export function effectiveVerdict(skill: SkillRecord): Verdict {
  if (!skill.audit) return 'unknown';
  const order: Verdict[] = ['unknown', 'safe', 'caution', 'dangerous'];
  const claude = skill.audit.claude && skill.audit.claude.contentHash === skill.contentHash ? skill.audit.claude.verdict : 'unknown';
  const scanners = skill.audit.scanners?.verdict ?? 'unknown';
  return order[Math.max(order.indexOf(skill.audit.verdict), order.indexOf(claude), order.indexOf(scanners))]!;
}

export function joinSkills(inventory: Inventory | undefined, enrichment: Enrichment | undefined): SkillView[] {
  if (!inventory) return [];
  return inventory.skills.map((skill) => {
    const gh = skill.provenance?.github;
    const repoKey = gh ? `${gh.owner}/${gh.repo}`.toLowerCase() : null;
    const verdict = effectiveVerdict(skill);
    const reviewed = !!skill.review && !skill.review.changedSince;
    return {
      ...skill,
      repoKey,
      repo: repoKey ? (enrichment?.repos[repoKey] ?? null) : null,
      trendingDays: repoKey ? (enrichment?.trending[repoKey] ?? []) : [],
      skillsSh: repoKey ? (enrichment?.skillsSh[`${repoKey}/${skill.folderName.toLowerCase()}`] ?? null) : null,
      update: enrichment?.updates[skill.id] ?? null,
      verdict,
      needsReview: (verdict === 'caution' || verdict === 'dangerous') && !reviewed && !skill.shadowedBy && skill.scope !== 'agents-store',
    };
  });
}

export function useSkillViews(): { skills: SkillView[]; inventory: Inventory | undefined; enrichment: Enrichment | undefined; isLoading: boolean; error: Error | null } {
  const inventory = useInventory();
  const enrichment = useEnrichment();
  const skills = useMemo(() => joinSkills(inventory.data, enrichment.data), [inventory.data, enrichment.data]);
  return { skills, inventory: inventory.data, enrichment: enrichment.data, isLoading: inventory.isLoading, error: inventory.error };
}
