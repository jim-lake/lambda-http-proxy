import { builtinModules } from 'node:module';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import esbuild from 'rollup-plugin-esbuild';
import dts from 'rollup-plugin-dts';
import { incrementBuildNumber } from './scripts/rollup-increment-build-number.mjs';

// Bump package.json's version once at config load (before either bundle), so a
// single bump covers the whole build. `incrementBuildNumber` only bumps when
// `BUILD_BUMP` is set — `npm run build` sets it; `build:bundle` (used by the
// test scripts) does not, so the suite never churns the version.
//
// The resolved version is baked into both bundles as a compile-time constant
// (`__BUILD_VERSION__`) via esbuild's `define`. That guarantees the output
// bytes change whenever the version changes, so a version bump always churns
// the artifacts.
const BUILD_VERSION = incrementBuildNumber();

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

const RUNTIME_PROVIDED_SCOPES = ['@aws-sdk/', '@smithy/', 'aws-sdk'];

function isExternal(id) {
  if (nodeBuiltins.has(id)) return true;
  if (RUNTIME_PROVIDED_SCOPES.some((s) => id === s || id.startsWith(s)))
    return true;
  return false;
}

const esbuildPlugin = () =>
  esbuild({
    target: 'node24',
    minify: false,
    sourceMap: true,
    tsconfig: 'tsconfig.json',
    define: { __BUILD_VERSION__: JSON.stringify(BUILD_VERSION) },
  });

export default [
  {
    input: 'src/lambda-outbound-proxy.ts',
    external: isExternal,
    output: {
      file: 'dist/lambda-outbound-proxy.mjs',
      format: 'esm',
      sourcemap: true,
      exports: 'named',
    },
    plugins: [
      nodeResolve({ exportConditions: ['node'], preferBuiltins: true }),
      esbuildPlugin(),
    ],
  },
  {
    input: 'src/lambda-outbound-proxy.ts',
    external: isExternal,
    output: { file: 'dist/lambda-outbound-proxy.d.ts', format: 'es' },
    plugins: [dts()],
  },
  {
    input: 'src/lambda-outbound-proxy.ts',
    external: isExternal,
    output: { file: 'dist/lambda-outbound-proxy.d.mts', format: 'es' },
    plugins: [dts()],
  },
  {
    input: 'src/proxy-request-handler.ts',
    external: isExternal,
    output: {
      file: 'dist/proxy-request-handler.mjs',
      format: 'esm',
      sourcemap: true,
      exports: 'named',
    },
    plugins: [
      nodeResolve({ exportConditions: ['node'], preferBuiltins: true }),
      esbuildPlugin(),
    ],
  },
  {
    input: 'src/proxy-request-handler.ts',
    external: isExternal,
    output: { file: 'dist/proxy-request-handler.d.ts', format: 'es' },
    plugins: [dts()],
  },
  {
    input: 'src/proxy-request-handler.ts',
    external: isExternal,
    output: { file: 'dist/proxy-request-handler.d.mts', format: 'es' },
    plugins: [dts()],
  },
  {
    input: 'src/fetch-proxy.ts',
    external: isExternal,
    output: {
      file: 'dist/fetch-proxy.js',
      format: 'esm',
      sourcemap: true,
      exports: 'named',
    },
    plugins: [
      nodeResolve({ exportConditions: ['node'], preferBuiltins: true }),
      esbuildPlugin(),
    ],
  },
  {
    input: 'src/fetch-proxy.ts',
    external: isExternal,
    output: { file: 'dist/fetch-proxy.d.ts', format: 'es' },
    plugins: [dts()],
  },
  {
    input: 'src/fetch-proxy.ts',
    external: isExternal,
    output: { file: 'dist/fetch-proxy.d.mts', format: 'es' },
    plugins: [dts()],
  },
];
