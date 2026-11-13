// Skillhangar usage hook. Claude Code runs this for PreToolUse (matcher "Skill") and UserPromptSubmit.
// It appends one line to ~/.skillhangar/usage.jsonl and always exits 0 with no output, so it can never
// block or change a session. It imports only Node built-ins because it is copied to a stable path.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface HookPayload {
  tool_input?: { skill?: unknown };
  prompt?: unknown;
}

function skillFrom(payload: HookPayload): { skill: string; via: 'tool' | 'slash' } | null {
  if (typeof payload.tool_input?.skill === 'string') return { skill: payload.tool_input.skill, via: 'tool' };
  if (typeof payload.prompt === 'string') {
    const m = /^\s*\/([\w:.-]{1,80})(?:\s|$)/.exec(payload.prompt);
    if (m) return { skill: m[1]!, via: 'slash' };
  }
  return null;
}

try {
  const hit = skillFrom(JSON.parse(readFileSync(0, 'utf8')) as HookPayload);
  if (hit) {
    const dir = process.env.SKILLHANGAR_HOME ?? join(homedir(), '.skillhangar');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'usage.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), skill: hit.skill.slice(0, 120), via: hit.via })}\n`, { mode: 0o600 });
  }
} catch {
  // never fail a session
}
process.exitCode = 0;
