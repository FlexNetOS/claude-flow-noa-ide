```markdown
# ruflo Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill introduces the core development patterns, coding conventions, and workflows used in the `ruflo` TypeScript monorepo, which is built on the Hono framework. It covers how to add new plugins, agents, skills, tests, documentation, and manage package versions. The guide is designed for contributors to quickly onboard and maintain consistency across the codebase.

## Coding Conventions

- **Language:** TypeScript
- **Framework:** Hono
- **File Naming:** Use `camelCase` for files (e.g., `memoryPlugin.ts`)
- **Import Style:** Use aliases for imports

  ```typescript
  import { MemoryService } from '@/services/memoryService';
  ```

- **Export Style:** Prefer named exports

  ```typescript
  // Good
  export function createAgent() { ... }
  export const AGENT_KEY = 'agent-key';

  // Avoid default exports
  ```

- **Commit Messages:** Follow [Conventional Commits](https://www.conventionalcommits.org/)  
  Prefixes: `feat`, `chore`, `fix`, `merge`, `docs`  
  Example:  
  ```
  feat(memory): add short-term memory plugin integration
  ```

- **Barrel Files:** Use `index.ts` to re-export modules for cleaner imports.

  ```typescript
  // index.ts
  export * from './memoryPlugin';
  export * from './securityPlugin';
  ```

## Workflows

### Add Domain Plugin Adapter
**Trigger:** When exposing a new domain/service as a plugin for kernel integration  
**Command:** `/new-domain-plugin`

1. Create a thin `ClaudeFlowPlugin` wrapper in the domain's `src/` directory (e.g., `memoryPlugin.ts`).
2. Register the service in the service container with a unique key.
3. Re-export necessary modules via `index.ts` (barrel file) if needed.
4. Verify with TypeScript:  
   ```
   tsc --noEmit --skipLibCheck
   ```
5. Ensure zero errors before committing.

**Example:**
```typescript
// src/memoryPlugin.ts
import { MemoryService } from './memoryService';
export const memoryPlugin = new ClaudeFlowPlugin(MemoryService);
```

### Batch Integration Merge
**Trigger:** When merging multiple PRs/features in a major release or integration sweep  
**Command:** `/batch-integration`

1. Collect PRs/features for integration.
2. Merge or cherry-pick changes, resolving conflicts.
3. Update `CHANGELOG.md`, `README.md`, and other documentation.
4. Commit with a summary of included PRs and resolutions.

**Example Commit Message:**
```
merge: batch integration of #42, #47, #51; resolve plugin conflicts
```

### Add or Update Skill or Agent
**Trigger:** When introducing or updating agent/skill definitions  
**Command:** `/new-skill`

1. Create or update `SKILL.md` or agent YAML/MD files in the appropriate skills/agents directory.
2. Optionally update related `plugin.json` or `hooks.json`.
3. Update documentation or ADRs if significant.
4. Commit with a message referencing the new/updated skill/agent.

**Example:**
```
feat(agent): add summarizer agent for document processing
```

### Add or Update Plugin Metadata
**Trigger:** When registering/updating plugin metadata for discoverability/integration  
**Command:** `/new-plugin`

1. Create or update `plugin.json`, `hooks.json`, or `marketplace.json` in the plugin directory.
2. Optionally add a `src/*-plugin.ts` adapter for meta-plugins.
3. Update `README.md` or ADRs for the plugin.
4. Commit changes.

**Example:**
```json
// plugins/ruflo-memory/.claude-plugin/plugin.json
{
  "name": "ruflo-memory",
  "description": "Memory domain plugin for ClaudeFlow",
  "version": "1.2.0"
}
```

### Add or Update Test and Implementation
**Trigger:** When implementing a new feature or bugfix with corresponding tests  
**Command:** `/feature-with-test`

1. Modify or add implementation code in `src/` directories.
2. Add or update corresponding test files in `__tests__/` or `tests/` directories.
3. Commit both implementation and test changes together.

**Example:**
```typescript
// src/taskService.ts
export function executeTask() { ... }

// __tests__/taskService.test.ts
import { executeTask } from '../src/taskService';
import { describe, it, expect } from 'vitest';

describe('executeTask', () => {
  it('should execute a task', () => {
    expect(executeTask()).toBeTruthy();
  });
});
```

### Documentation and ADR Update
**Trigger:** When documenting new features, workflows, or architectural decisions  
**Command:** `/doc-update`

1. Create or update `.md` files in `docs/`, `v3/docs/`, or `plugins/*/docs/`.
2. Update `README.md`, ADRs (`ADR-xxx-*.md`), or roadmap files as needed.
3. Commit documentation changes, referencing related features or PRs.

**Example:**
```
docs: update roadmap and add ADR for plugin architecture
```

### Monorepo Package Version Bump
**Trigger:** When synchronizing or bumping package versions across the monorepo  
**Command:** `/bump-versions`

1. Update `version` fields in `package.json` files across packages.
2. Optionally update lockfiles (`package-lock.json`, `pnpm-lock.yaml`).
3. Commit all `package.json` and lockfile changes together.

**Example:**
```
chore: bump all packages to v1.3.0
```

## Testing Patterns

- **Framework:** [vitest](https://vitest.dev/)
- **Test File Pattern:** `*.test.ts`
- **Test Directory:** Place tests in `__tests__/` or `tests/` directories alongside or near the code under test.

**Example Test:**
```typescript
// __tests__/memoryPlugin.test.ts
import { memoryPlugin } from '../src/memoryPlugin';
import { describe, it, expect } from 'vitest';

describe('memoryPlugin', () => {
  it('should register successfully', () => {
    expect(memoryPlugin).toBeDefined();
  });
});
```

- **Run tests:**  
  ```
  npx vitest run
  ```

## Commands

| Command              | Purpose                                                            |
|----------------------|--------------------------------------------------------------------|
| /new-domain-plugin   | Scaffold and register a new domain plugin adapter                  |
| /batch-integration   | Merge multiple PRs/features in a single batch commit               |
| /new-skill           | Add or update a skill or agent definition                          |
| /new-plugin          | Add or update plugin metadata and adapters                         |
| /feature-with-test   | Implement a new feature/bugfix along with corresponding tests      |
| /doc-update          | Update documentation, ADRs, or roadmap files                       |
| /bump-versions       | Synchronize or bump package versions across the monorepo           |
```
