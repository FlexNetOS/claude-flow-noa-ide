/**
 * Vitest configuration for @claude-flow/shared.
 *
 * The v3-root vitest config drives integration coverage; this per-package
 * config keeps unit tests for shared primitives runnable from the package
 * directory in isolation, without the workspace-level setup file or
 * cross-package include patterns picking up symlinked copies of the same
 * test file via pnpm's nested `node_modules`.
 */
  },
});
