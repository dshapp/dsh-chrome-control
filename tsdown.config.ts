import { defineConfig } from 'tsdown'

/**
 * Self-contained build for a git/tarball install: transpiles `src/` directly so
 * pnpm's post-install `prepare` script can produce `lib/` on a clean checkout.
 * Harness packages stay external — a real dsh installation already ships them,
 * and bundling would duplicate their code and strand transitive imports.
 */
export default defineConfig({
  entry: ['src/server.ts', 'src/skills.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: true,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/, /^ws$/],
  },
})
