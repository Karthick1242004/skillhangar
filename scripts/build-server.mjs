// Bundles the CLI, server and usage hook into dist/ as ESM. Runtime dependencies stay external
// (they install with the package); code splitting keeps `skillhangar scan` from loading the server.
import { build, context } from 'esbuild';
import { chmod, readdir, readFile, rm } from 'node:fs/promises';

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

// esbuild never deletes old output, and chunk names carry a content hash, so stale chunks pile up and
// would ship in the package. Clear everything in dist/ except the UI build before each build.
for (const entry of await readdir('dist').catch(() => [])) {
  if (entry !== 'ui') await rm(`dist/${entry}`, { recursive: true, force: true });
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
  await chmod('dist/cli.js', 0o755);
}
