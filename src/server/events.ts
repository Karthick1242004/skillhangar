import { newId } from '../core/util/ids';
import { pLimit } from '../core/util/limit';
import type { JobInfo, ServerEvent } from '../shared/types';

export class EventBus {
  private listeners = new Set<(event: ServerEvent) => void>();

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }
}

export interface JobContext {
  signal: AbortSignal;
  progress: (done: number, total: number) => void;
}

/**
 * Background work with progress and cancellation. Each kind has its own concurrency limit, so a queue of
 * Claude audits never blocks a scan, and two audits run at most at once.
 */
export class JobManager {
  private jobs = new Map<string, JobInfo>();
  private controllers = new Map<string, AbortController>();
  private limits: Record<JobInfo['kind'], ReturnType<typeof pLimit>> = {
    'claude-audit': pLimit(2),
    'trending-index': pLimit(1),
    enrichment: pLimit(1),
    scan: pLimit(1),
    'mcp-probe': pLimit(2),
    scanner: pLimit(2),
  };

  constructor(private readonly events: EventBus) {}

  list(): JobInfo[] {
    return [...this.jobs.values()].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  }

  active(kind: JobInfo['kind'], targetId?: string): JobInfo | undefined {
    return [...this.jobs.values()].find((j) => j.kind === kind && j.targetId === targetId && (j.state === 'queued' || j.state === 'running'));
  }

  start<T>(kind: JobInfo['kind'], label: string, task: (ctx: JobContext) => Promise<T>, targetId?: string): { job: JobInfo; done: Promise<T> } {
    const job: JobInfo = { id: newId('j_'), kind, label, state: 'queued', targetId, startedAt: new Date().toISOString() };
    const controller = new AbortController();
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, controller);
    this.trim();
    this.publish(job);

    let lastPublish = 0;
    const done = this.limits[kind](async () => {
      if (controller.signal.aborted) throw new Error('Cancelled');
      job.state = 'running';
      this.publish(job);
      return task({
        signal: controller.signal,
        progress: (d, total) => {
          job.progress = { done: d, total };
          // Progress events are throttled so a 1,800-step job does not flood the stream.
          if (Date.now() - lastPublish > 250 || d === total) {
            lastPublish = Date.now();
            this.publish(job);
          }
        },
      });
    });
    done.then(
      () => {
        job.state = 'done';
      },
      (error: Error) => {
        job.state = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = error.message;
      },
    ).finally(() => {
      job.finishedAt = new Date().toISOString();
      this.controllers.delete(job.id);
      this.publish(job);
    });
    return { job, done };
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private publish(job: JobInfo): void {
    this.events.emit({ type: 'job', job: { ...job } });
  }

  private trim(): void {
    const finished = this.list().filter((j) => j.state !== 'queued' && j.state !== 'running');
    for (const job of finished.slice(50)) this.jobs.delete(job.id);
  }
}
