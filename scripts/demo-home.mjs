// Builds a throwaway home folder for screenshots and demos, so no real machine's skills, paths or
// servers ever appear in published images. Usage: node scripts/demo-home.mjs <empty folder>
// Then: SKILLHANGAR_TEST_HOME=<folder> SKILLHANGAR_HOME=<folder>/.skillhangar SKILLHANGAR_MANAGED_DIR=<folder>/managed node dist/cli.js serve
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const home = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('Usage: node scripts/demo-home.mjs <empty folder>');
  process.exit(2);
}
const corpus = new URL('../fixtures/corpus/', import.meta.url).pathname;
const skills = join(home, '.claude', 'skills');
await mkdir(skills, { recursive: true });

// The audit corpus doubles as a believable mix: most skills clean, a few flagged.
const keep = ['ok-plain', 'ok-script', 'ok-pinned', 'ok-data-uri', 'mal-pipe-shell', 'mal-unpinned', 'mal-allowed-bash', 'mal-hooks', 'mal-tags', 'mal-exfil-endpoint'];
for (const name of keep) await cp(join(corpus, name), join(skills, name), { recursive: true, verbatimSymlinks: true });

const plain = [
  ['commit-writer', 'Writes a conventional commit message from the staged diff.'],
  ['changelog', 'Drafts release notes from merged pull requests since the last tag.'],
  ['sql-explain', 'Explains a slow SQL query plan and suggests an index.'],
  ['api-review', 'Reviews a REST endpoint for naming, errors and pagination.'],
  ['test-gaps', 'Finds untested branches in the files you changed.'],
  ['a11y-check', 'Checks a component for keyboard access, labels and contrast.'],
  ['dep-upgrade', 'Plans a dependency upgrade and lists breaking changes.'],
  ['incident-notes', 'Turns a debugging session into a short incident write-up.'],
  ['regex-explain', 'Explains a regular expression part by part.'],
  ['pr-summary', 'Summarises a pull request for reviewers in five lines.'],
  ['schema-diff', 'Compares two database schemas and writes the migration.'],
  ['log-triage', 'Groups error logs by cause and ranks them by frequency.'],
];
for (const [name, description] of plain) {
  await mkdir(join(skills, name), { recursive: true });
  await writeFile(join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`);
}

await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { 'incident-notes': 'name-only' } }, null, 2));
await writeFile(
  join(home, '.claude.json'),
  JSON.stringify(
    {
      mcpServers: {
        docs: { type: 'http', url: 'https://mcp.context7.com/mcp' },
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' } },
        browser: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      },
    },
    null,
    2,
  ),
);
console.log(`Demo home ready at ${home} with ${(await readdir(skills)).length} skills.`);
