import { builtinModules } from 'node:module';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import esbuild from 'rollup-plugin-esbuild';
import dts from 'rollup-plugin-dts';

/**
 * Build the single-file Lambda artifact: dist/lambda-http-proxy.mjs
 *
 * - esbuild transpiles TypeScript (fast). tsc is NEVER used to emit — only as a
 *   type-checker via `npm run ts:check`.
 * - A second pass with rollup-plugin-dts emits the bundled type declarations
 *   (dist/lambda-http-proxy.d.ts), also without tsc emit.
 * - Rollup bundles the ESM output into one file.
 * - The AWS SDK (and its @smithy/* internals) are marked EXTERNAL because the
 *   managed nodejs24.x runtime already ships them. Bundling them would bloat
 *   the artifact and risk version drift from what the runtime loads.
 *
 * Note: the proxy itself imports zero @aws-sdk/* modules at runtime (it uses
 * only Node builtins). These externals exist so that any future SDK use — or
 * transitively pulled SDK code — resolves to the runtime-provided copy rather
 * than being bundled.
 */

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

/** Treat anything under these scopes as runtime-provided. */
const RUNTIME_PROVIDED_SCOPES = ['@aws-sdk/', '@smithy/', 'aws-sdk'];

function isExternal(id) {
  if (nodeBuiltins.has(id)) return true;
  if (RUNTIME_PROVIDED_SCOPES.some((s) => id === s || id.startsWith(s)))
    return true;
  return false;
}

export default [
  {
    input: 'src/index.ts',
    external: isExternal,
    output: {
      file: 'dist/lambda-http-proxy.mjs',
      format: 'esm',
      sourcemap: true,
      // Lambda handler is `lambda-http-proxy.handler`; keep the named export.
      exports: 'named',
    },
    plugins: [
      nodeResolve({ exportConditions: ['node'], preferBuiltins: true }),
      esbuild({
        target: 'node24',
        minify: false,
        sourceMap: true,
        tsconfig: 'tsconfig.json',
      }),
    ],
  },
  {
    input: 'src/index.ts',
    external: isExternal,
    output: { file: 'dist/lambda-http-proxy.d.ts', format: 'es' },
    plugins: [dts()],
  },
];
