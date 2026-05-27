/**
 * Re-export shim so `@claude-flow/swarm/domain` resolves via the package
 * exports pattern `"./*": "./dist/*.js"` -> `./dist/domain.js`.
 */
export * from './domain/index.js';
