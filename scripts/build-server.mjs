// Bundles the CLI, server and usage hook into dist/ as ESM. Runtime dependencies stay external
// (they install with the package); code splitting keeps `skillhangar scan` from loading the server.
import { build, context } from 'esbuild';
import { readFile, chmod } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: { cli: 'src/cli.ts', hook: 'src/hook.ts' },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  external: Object.keys(pkg.dependencies),
  define: { __SKILLHANGAR_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
  await chmod('dist/cli.js', 0o755);
}
