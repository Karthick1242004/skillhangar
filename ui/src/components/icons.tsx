import type { SVGProps } from 'react';

// One outline icon set: 16px, 1.5px stroke, round joins. Drawn here so the UI loads no icon font.
const paths = {
  overview: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  library: 'M3 2.5h2.5v11H3zM6.5 2.5H9v11H6.5zM10.2 3.1l2.4-.6 2.6 10.6-2.4.6z',
  mcp: 'M6 1.5v3M10 1.5v3M4 4.5h8v3a4 4 0 0 1-8 0zM8 11.5v3',
  plugins: 'M6.5 2.5a1.5 1.5 0 0 1 3 0V4H13v3.5h-1.5a1.5 1.5 0 0 0 0 3H13V14H9.5v-1.5a1.5 1.5 0 0 0-3 0V14H3V4h3.5z',
  audits: 'M8 1.5 13.5 3.5v4c0 3.4-2.3 5.9-5.5 7-3.2-1.1-5.5-3.6-5.5-7v-4zM5.5 8l1.8 1.8L10.8 6.3',
  updates: 'M8 13.5V4M4.5 7.5 8 4l3.5 3.5M3 2.5h10',
  add: 'M8 3v10M3 8h10',
  activity: 'M8 2.5a5.5 5.5 0 1 1-5.5 5.5M8 5v3l2 1.5M2.5 3v2.5H5',
  settings: 'M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  search: 'M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.3 10.3 13.5 13.5',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3',
  close: 'M4 4l8 8M12 4l-8 8',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  external: 'M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4',
  alert: 'M8 2 14.5 13.5h-13zM8 6.5v3M8 11.5v.01',
  check: 'M3 8.5 6.5 12 13 4.5',
  undo: 'M5.5 4 2.5 7l3 3M2.5 7h7a4 4 0 0 1 0 8h-2',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  trash: 'M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4',
  more: 'M8 3.5v.01M8 8v.01M8 12.5v.01',
  chevron: 'M6 3.5 10.5 8 6 12.5',
  sun: 'M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1',
  moon: 'M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z',
  git: 'M5 2.5v7M5 9.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM11 4.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM11 8c0 2-2.5 2-6 2.5',
  star: 'M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, ...props }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d={paths[name]} />
    </svg>
  );
}
