import { useEffect, useRef } from 'react';
import { BRAND, CLAUDE_SYMBOL_PATH, NEUTRAL_MARK_PATH } from '../brand';

export type LogoState = 'idle' | 'scanning' | 'auditing' | 'settled';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The animated mark. Web Animations on transform only, so it runs on the compositor and never causes
 * layout. Scanning turns the spark slowly; auditing breathes; settled plays one short spring when work ends.
 */
export function Logo({ size = 22, state = 'idle', label }: { size?: number; state?: LogoState; label?: string }) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    let animation: Animation | null = null;
    if (state === 'scanning') {
      animation = el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 2400, iterations: Infinity, easing: 'linear' });
    } else if (state === 'auditing') {
      animation = el.animate(
        [
          { transform: 'scale(1) rotate(0deg)' },
          { transform: 'scale(0.82) rotate(30deg)', offset: 0.5 },
          { transform: 'scale(1) rotate(60deg)' },
        ],
        { duration: 1300, iterations: Infinity, easing: 'cubic-bezier(0.45, 0, 0.55, 1)' },
      );
    } else if (state === 'settled') {
      animation = el.animate(
        [
          { transform: 'scale(0.84) rotate(-20deg)' },
          { transform: 'scale(1.08) rotate(6deg)', offset: 0.6 },
          { transform: 'scale(1) rotate(0deg)' },
        ],
        { duration: 620, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      );
    }
    return () => animation?.cancel();
  }, [state]);

  return (
    <svg
      ref={ref}
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ transformOrigin: '50% 50%' }}
    >
      <path d={BRAND === 'claude' ? CLAUDE_SYMBOL_PATH : NEUTRAL_MARK_PATH} />
    </svg>
  );
}
