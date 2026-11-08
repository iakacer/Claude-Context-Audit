import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
};

const entries = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
  { entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js' },
];

if (watch) {
  const contexts = await Promise.all(
    entries.map((entry) => esbuild.context({ ...shared, ...entry })),
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('esbuild: watching extension and cli bundles');
} else {
  await Promise.all(entries.map((entry) => esbuild.build({ ...shared, ...entry })));
}
