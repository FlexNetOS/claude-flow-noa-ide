import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['node'],
  },
  plugins: [
    {
      name: 'externalize-optional-deps',
      enforce: 'pre',
      resolveId(source) {
        // Don't let Vite resolve optional deps that may have missing subpath exports
        if (source.startsWith('agentic-flow')) return { id: source, external: true };
        if (source.startsWith('agentdb')) return { id: source, external: true };
        if (source.startsWith('@ruvector/')) return { id: source, external: true };
        if (source.startsWith('@huggingface/transformers')) return { id: source, external: true };
        if (source.startsWith('@xenova/transformers')) return { id: source, external: true };
        if (source.startsWith('@noble/ed25519')) return { id: source, external: true };
        // #1987: sql.js is dynamically imported by memory-initializer; the
        // CLI package resolves it via the workspace hoist at runtime, but
        // Vite tries to transform it at test load and fails. Externalize
        // so Node's resolver handles it like in production. Same for the
        // node:sqlite builtin used by the #1987 regression test.
        if (source === 'sql.js') return { id: source, external: true };
        if (source === 'node:sqlite' || source === 'sqlite') return { id: source, external: true };
        return null;
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    globals: true,
    coverage: {
      enabled: false,
    },
    // #1987: sql.js is dynamically imported via `await import('sql.js')` in
    // memory-initializer; mark it external for the vitest deps optimizer so
    // Node resolves it from the workspace hoist (same as production).
    server: {
      deps: {
        external: [/sql\.js/],
      },
    },
  },
});
