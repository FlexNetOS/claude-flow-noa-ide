# Bug 47 Result

## Files modified
- `v3/@claude-flow/cli/src/commands/daemon.ts` — added `detectDaemonPathMismatch()`, `restartBackgroundDaemon()`, `restartCommand` subcommand, stale-daemon warning in `statusCommand` output, and `restart` to subcommand registry / help listing.
- `v3/@claude-flow/cli/src/commands/doctor.ts` — added `checkStaleDaemonPath()` health check, registered in `allChecks` array (after `checkDaemonStatus`) and in `componentMap` under key `daemon-path`.

## Files created
- `v3/@claude-flow/cli/__tests__/daemon-path-mismatch.test.ts` — 13 tests covering detection, restart kill flow, and state-file handling.

## API

### `detectDaemonPathMismatch(opts?: DaemonPathDetectorOptions): Promise<DaemonPathInfo | null>`

Compares the running daemon's binary path (read via `ps -p <pid> -o command=`) to the canonical SwarmOps install path (derived from `daemon.ts`'s own `import.meta.url` — same calculation `startBackgroundDaemon` uses to fork the child, guaranteeing they agree).

```ts
interface DaemonPathInfo {
  runningPath: string;   // path token from ps output (interpreter prefix stripped)
  expectedPath: string;  // resolved bin/cli.js for the current install
  pid: number;
  startedAt: string;     // ISO from daemon-state.json, or 'unknown'
  ageDays: number;       // floor((now - startedAt) / 86400_000), 0 if unknown
}
```

Returns `null` when:
- no `.claude-flow/daemon.pid` exists,
- pid file is malformed (NaN, ≤ 0),
- `ps` reports the PID is gone (caller treats this as "stale state, handled elsewhere"),
- canonicalized paths match.

Injection points (`DaemonPathDetectorOptions`):
- `projectRoot` — defaults to `process.cwd()`.
- `expectedPath` — overrides the derived bin path (used by tests).
- `readRunningCommand(pid) -> string|null` — stub for `ps`.
- `canonicalize(path) -> string` — stub for `realpathSync`.

Defaults use real `execFileSync('ps', ...)` and `fs.realpathSync` (with passthrough fallback when realpath fails — covered by `swallowError`).

### `restartBackgroundDaemon(opts) -> Promise<{killed, pid}>`

Reads PID file, sends SIGTERM, polls every `min(500ms, graceMs/10)` up to `graceMs` (default 5000ms), then SIGKILL if still alive. Always cleans up the PID file. With `clearState:true`, also wipes `daemon-state.json`. Accepts injectable `killer: ProcessKiller` and `sleep` for tests.

### `daemon restart` flags

- `--force-path` — overrides path-mismatch refusal AND wipes `daemon-state.json` so the new daemon starts fresh.
- `--quiet` / `-Q` — suppresses non-error output.

Without `--force-path`, refuses on mismatch with:
```
✗ Existing daemon at <runningPath> doesn't match SwarmOps install (<expectedPath>).
  Use --force-path to override. This will kill PID <pid> (started <ageDays> days ago).
```

After kill (or no daemon), hands off to existing `startBackgroundDaemon(projectRoot, quiet)` — fork-based flow used by `daemon start`.

### Doctor check behaviour

`swarmops doctor` now runs `checkStaleDaemonPath` after `checkDaemonStatus`. When a mismatch is detected:

- Status: `warn` (never `fail` — daemon is functioning, just running wrong code).
- Message: `Stale daemon (PID <pid>, <Nd old>) running from <runningPath> — workers are not running SwarmOps code`.
- Fix suggestion (printed by `--fix` mode): `swarmops daemon restart --force-path`.

`--fix` does NOT auto-restart — too invasive. Doctor only prints the suggested command, per the brief.

### `daemon status` warning surface

After the standard worker table (and verbose section), if `isRunning && detectDaemonPathMismatch()` returns non-null, prints:

```
⚠ STALE DAEMON DETECTED
  Running daemon (PID <pid>, started N days ago) is from:
    <runningPath>
  But your current SwarmOps install is at:
    <expectedPath>
  Background workers are NOT running SwarmOps code.
  Run `swarmops daemon restart --force-path` to fix.
```

Skipped silently when no mismatch or daemon not running.

## Tests

13 tests, all passing.

`__tests__/daemon-path-mismatch.test.ts`:
- `detectDaemonPathMismatch`:
  - returns null when no daemon.pid file exists
  - returns null when paths match (after canonicalization)
  - returns DaemonPathInfo when running path differs from expected (covers age-from-state-file)
  - handles PID-not-found gracefully (ps returns null)
  - returns null when daemon.pid contains a non-numeric value
  - reports startedAt='unknown' and ageDays=0 when no daemon-state.json
  - matches paths after canonicalization even when raw strings differ (symlink case)
- `restartBackgroundDaemon`:
  - returns {killed:false, pid:null} when no daemon.pid exists
  - sends SIGTERM and exits early when process dies during grace period (no SIGKILL)
  - escalates to SIGKILL when SIGTERM does not kill within grace period
  - clears daemon-state.json when clearState=true (--force-path semantics)
  - preserves daemon-state.json when clearState=false
  - handles dead-PID + present-pidfile (cleans up state without raising signals)

```
Test Files  1 passed (1)
     Tests  13 passed (13)
  Duration  ~234ms
```

Validation:
- `npx tsc --noEmit -p .` exits 0 except the pre-existing `@ruvector/sona` error (`src/memory/sona-optimizer.ts:250` — unrelated, baseline before changes).
- Existing related tests still green: `worker-daemon-resource-thresholds` (40), `doctor-hooks-perms-bug38-42` (14), `doctor-encryption` (5), `commands.test.ts` (32 passed / 16 skipped).

## Manual verification step for the lead

The user's stale daemon is PID 64888, started 2026-05-04 from `/Users/h4ckm1n/.npm/_npx/2ed56890c96f58f7/node_modules/@claude-flow/cli/bin/cli.js`. To restart against the SwarmOps install:

1. From the SwarmOps repo root (so `process.cwd()` is `/Users/h4ckm1n/dev/SwarmOps`):
   ```
   cd /Users/h4ckm1n/dev/SwarmOps
   node v3/@claude-flow/cli/bin/cli.js daemon status
   ```
   Expect to see the new `⚠ STALE DAEMON DETECTED` block flagging PID 64888.

2. Restart with the new flag:
   ```
   node v3/@claude-flow/cli/bin/cli.js daemon restart --force-path
   ```
   This should:
   - SIGTERM PID 64888,
   - wait up to 5s,
   - SIGKILL if still alive,
   - delete `~/.claude-flow/daemon.pid` AND `~/.claude-flow/daemon-state.json`,
   - fork a fresh detached daemon from `v3/@claude-flow/cli/bin/cli.js`.

3. Verify with `daemon status` — the new PID should appear and the warning section should be absent.

NOTE: depending on which `.claude-flow/` dir the existing PID file lives in (the running daemon was started from `~`, not the repo), you may need to run from `~` instead. The detection helper uses `process.cwd()` so:
   ```
   cd ~ && node /Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/bin/cli.js daemon status
   ```
   Then:
   ```
   cd ~ && node /Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/bin/cli.js daemon restart --force-path
   ```
   The lead should pick the cwd that matches where the existing daemon-state.json lives (currently at `/Users/h4ckm1n/.claude/.claude-flow/daemon-state.json` — so `cd ~/.claude` is the right one).

## Notes

- The brief mentions `daemon-state.json` storing the PID directly. It actually stores `running`, `startedAt`, `workers`, `config`, but NOT the PID — so the helper reads `daemon.pid` for the PID and `daemon-state.json` for the `startedAt` (with graceful 'unknown' fallback when the state file is missing or malformed).
- The brief's `packageRoot + '../../../../bin/cli.js'` calculation is incorrect for SwarmOps's layout — `resolveInstallContext().packageRoot` resolves to `v3/@claude-flow/shared` (the location of `install-context.js`), not `v3/@claude-flow/cli`. I instead used the daemon.ts file's own `import.meta.url` going up `../../../bin/cli.js`, which is identical to the calculation already used in `startBackgroundDaemon`. This guarantees the comparison path is exactly the path that would be forked, so a "no mismatch" result really means "if you ran daemon start now, you'd fork the same binary".
- `ps` output stripping: when invoked as `node /path/to/cli.js daemon start --foreground …`, ps emits the interpreter as the first token. The helper detects `node`/`nodeNN` interpreters and takes the next token as the script path. This means if a daemon was started with a different node version (say `/usr/local/bin/node` vs `/opt/homebrew/bin/node`), we don't false-flag a mismatch — we compare the script paths.
- I added `restart` to `subcommands` array AFTER `stop` (natural grouping) and to the help text. The example list mentions `restart --force-path` as the canonical Bug-47 incantation.
- `swallowError` is wired in for every catchable failure path (realpath, ps, pid-read, state-read, sigterm, sigkill, unlink-pid, unlink-state) so silent failures show up in debug builds.
- I exported `DaemonPathInfo`, `DaemonPathDetectorOptions`, `ProcessKiller`, `detectDaemonPathMismatch`, and `restartBackgroundDaemon` from `daemon.ts` so doctor.ts and tests can import them. None of these expand the surface a user would discover via `swarmops --help`.
- Tests use injection (passing fake `readRunningCommand` / `killer` / `sleep` / `canonicalize`) rather than `vi.mock('node:child_process')`. This avoids the pitfall noted in the existing `commands-trace.test.ts` (`resetAllMocks` wiping mock implementations) and keeps the helpers honest about their dependencies.
- No real processes were touched. The user's running daemon (PID 64888) was not stopped, restarted, or signalled during implementation or testing.
