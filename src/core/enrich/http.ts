const USER_AGENT = `skillhangar/${typeof __SKILLHANGAR_VERSION__ === 'string' ? __SKILLHANGAR_VERSION__ : 'dev'}`;

declare const __SKILLHANGAR_VERSION__: string;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(message);
  }
}

export interface FetchJsonOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * JSON fetch with a timeout and a generic User-Agent (never the user's identity).
 * Returns null on 404 so "not covered" is not an error; throws HttpError on other failures.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<{ data: T | null; headers: Headers }> {
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 15_000)];
  if (options.signal) signals.push(options.signal);
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.any(signals),
    redirect: 'follow',
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return { data: null, headers: response.headers };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new HttpError(response.status, url, `${response.status} from ${new URL(url).host}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  return { data: (await response.json()) as T, headers: response.headers };
}

export function userAgent(): string {
  return USER_AGENT;
}
