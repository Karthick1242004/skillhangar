import { memo, type ReactNode } from 'react';

const HIDDEN = /([\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}])/u;
const HIDDEN_SPLIT = /([\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}])/gu;

/** Renders a hidden character as a visible red marker, so what a model reads is what the reviewer sees. */
function reveal(line: string): ReactNode {
  if (!HIDDEN.test(line)) return line || ' ';
  return line.split(HIDDEN_SPLIT).map((part, i) => {
    if (!part) return null;
    if (!HIDDEN.test(part)) return part;
    const cp = part.codePointAt(0)!;
    const label = cp >= 0xe0020 && cp <= 0xe007e ? `TAG ${String.fromCharCode(cp - 0xe0000)}` : `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    return (
      <mark key={i} className="hidden-char" title="Invisible character">
        {label}
      </mark>
    );
  });
}

/** Plain-text viewer with line numbers. Text is never parsed as HTML or markdown. */
export const CodeView = memo(function CodeView({ text, flagged, label, maxLines = 4000 }: { text: string; flagged?: Set<number>; label: string; maxLines?: number }) {
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, maxLines);
  return (
    <pre className="code" aria-label={label} tabIndex={0}>
      {shown.map((line, i) => (
        <span key={i} className={`line${flagged?.has(i + 1) ? ' flag' : ''}`}>
          {reveal(line)}
          {'\n'}
        </span>
      ))}
      {lines.length > maxLines ? <span className="line faint">… {lines.length - maxLines} more lines</span> : null}
    </pre>
  );
});

/** A unified diff, coloured by line type. */
export function PatchView({ patch }: { patch: string }) {
  const lines = patch.split('\n').filter((l, i) => i > 1 || !l.startsWith('==='));
  return (
    <pre className="code diff" tabIndex={0}>
      {lines.map((line, i) => (
        <span key={i} className={`line ${line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}`}>
          {reveal(line)}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
