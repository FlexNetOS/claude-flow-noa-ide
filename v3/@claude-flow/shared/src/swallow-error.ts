/**
 * swallowError — standard recipient for catch blocks that intentionally
 * absorb errors.
 *
 * Background
 * ----------
 * The codebase has many `} catch { /* best-effort * /  }` patterns where the
 * intent is to skip a non-essential side-effect when it fails. The problem
 * is that these patterns are entirely silent — when something goes wrong in
 * dev or production, there's no breadcrumb. PR-1828 traced 3 of 8 bugs to
 * exactly this class.
 *
 * This helper preserves the silent behavior in production (default log
 * level) but emits a debug line when `RUFLO_LOG_LEVEL=debug` (or `trace`),
 * so silent failures stop being silent during troubleshooting.
 *
 * Use exactly where you'd otherwise write a swallowed `try/catch` — the
 * catch parameter stays so the error type is preserved, and the helper is
 * the single recipient.
 *
 * @module v3/shared/swallow-error
 */

/**
 * Standard recipient for catch blocks that intentionally absorb errors.
 *
 * @param label  Short identifier for grep/triage
 *               (e.g. "memory-bridge.recordTrajectory").
 * @param err    The caught error.
 * @param hint   Optional context for the future-debugger
 *               (e.g. "dim mismatch — using BM25 fallback").
 */
export function swallowError(label: string, err: unknown, hint?: string): void {
  const level = process.env.RUFLO_LOG_LEVEL ?? 'info';
  if (level !== 'debug' && level !== 'trace') return;

  const msg =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err);

  process.stderr.write(`[swallowed:${label}] ${msg}${hint ? ` (${hint})` : ''}\n`);
}
