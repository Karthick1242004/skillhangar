import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  signal?: AbortSignal;
  /** Bytes kept from each of stdout and stderr; the rest is dropped. */
  maxOutput?: number;
  /** Called for each stdout chunk; return true to stop the process early. */
  onStdout?: (chunk: string) => boolean | void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  stoppedEarly: boolean;
}

/**
 * Runs a program with an argument array. Never uses a shell, so arguments are never re-parsed.
 * Resolves (does not reject) on a non-zero exit; rejects only when the program cannot start.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const maxOutput = options.maxOutput ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let stoppedEarly = false;

    const kill = () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2000).unref();
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : null;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < maxOutput) stdout += chunk.slice(0, maxOutput - stdout.length);
      if (options.onStdout?.(chunk) && !stoppedEarly) {
        stoppedEarly = true;
        kill();
      }
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < maxOutput) stderr += chunk.slice(0, maxOutput - stderr.length);
    });
    if (options.input !== undefined) child.stdin!.end(options.input);

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, stoppedEarly });
    });
  });
}

const whichCache = new Map<string, string | null>();

/** Finds an executable on PATH (or checks an absolute path). Cached for the process lifetime. */
export async function which(command: string): Promise<string | null> {
  if (whichCache.has(command)) return whichCache.get(command)!;
  const found = await resolveExecutable(command);
  whichCache.set(command, found);
  return found;
}

async function resolveExecutable(command: string): Promise<string | null> {
  const mode = process.platform === 'win32' ? constants.F_OK : constants.X_OK;
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    try {
      await access(command, mode);
      return command;
    } catch {
      return null;
    }
  }
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      try {
        await access(candidate, mode);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}
