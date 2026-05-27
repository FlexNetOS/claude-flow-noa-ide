/**
 * Console filter for noisy subsystem init logs (Bugs #35, plus the original
 * `[AgentDB Patch] Controller index not found` filter).
 *
 * This file MUST be imported as the first side-effect import in any entry
 * point so the patches are in place before agentic-flow / agentdb /
 * @ruvector/* (and anything that transitively imports them) load.
 *
 * Two responsibilities:
 *
 * 1. Suppress the cosmetic "[AgentDB Patch] Controller index not found"
 *    warning emitted by agentic-flow's runtime patch (it expects agentdb
 *    v1.x layout but we use v3). Tight match: must include both
 *    "[AgentDB Patch]" AND "Controller index not found". Other [AgentDB
 *    Patch] messages (real issues) flow through. Audit log
 *    audit_1776483149979 flagged the previous broad filter as too
 *    aggressive — this one is tight enough to be safe.
 *
 * 2. (Bug #35) Suppress the 27-line subsystem init banner that drowns
 *    every memory/route/swarm command:
 *      [LearningSystem] Using native …
 *      [GNNService] Using native @ruvector/gnn …
 *      [SonaTrajectoryService] Using native …
 *      [SemanticRouter] Using native @ruvector/router
 *      [MutationGuard] Initialized with native proof engine
 *      [GuardedBackend] Proof engine: …
 *    Default level (warn) sends them to `~/.claude/logs/ruflo.log` only.
 *    `RUFLO_LOG_LEVEL=info` (or higher) lets them through to stderr.
 *
 *    We also drop the harmless ONNX/transformers chatter ("Something went
 *    wrong during model construction (most likely a missing operation).
 *    Using `wasm` as a fallback.") which is just informational.
 */

import { shouldSurfaceSubsystemNoise, fileOnly } from './util/log.js';

const isCosmeticAgentdbPatchNoise = (msg: unknown): boolean => {
  const s = String(msg ?? '');
  return s.includes('[AgentDB Patch]') && s.includes('Controller index not found');
};

// Tightly anchored prefixes — only the ones the audit flagged. We match on
// "starts with prefix" (after optional ✅) so a legitimate error message that
// happens to contain "[GNNService]" mid-sentence still surfaces via the
// underlying console (we route those to file-only too, but at warn rank).
const NOISY_PREFIXES = [
  '[LearningSystem]',
  '[GNNService]',
  '[SonaTrajectoryService]',
  '[SemanticRouter]',
  '[MutationGuard]',
  '[GuardedBackend]',
  '[MoE]',
  '[EWC]',
  '[Flash]',
  '[LoRA]',
  '[RuVector]',
  '[NeuralPackage]',
  '[OllamaEmbedder]',
];

const ONNX_FALLBACK_NOISE_RE =
  /Something went wrong during model construction.*Using.*wasm.*as a fallback/;

// The xenova/transformers fallback path emits TWO console.warn calls back to
// back: (1) the raw onnxruntime Error (whose .message starts with the
// hard-coded `/Users/runner/work/.../onnxruntime/...` build path of their
// CI), and (2) the human "Something went wrong … Using wasm as a fallback."
// We silence both at default level — the user gets correct results either
// way (wasm fallback works), and the raw Error scaring users isn't useful.
const ONNX_BUILD_PATH_NOISE_RE =
  /\/Users\/runner\/work\/.*\/onnxruntime\/.*\bDefaultLogger\b/;

const isSubsystemInitNoise = (msg: unknown): boolean => {
  const s = String(msg ?? '').trimStart();
  // Strip a leading ✅ / ⚠ / ❌ emoji + space, common in upstream banners.
  const stripped = s.replace(/^[✅⚠⚡❌ℹ]\s*/, '');
  for (const prefix of NOISY_PREFIXES) {
    if (stripped.startsWith(prefix)) return true;
  }
  return false;
};

const isOnnxFallbackNoise = (msg: unknown): boolean => {
  const s = String(msg ?? '');
  return ONNX_FALLBACK_NOISE_RE.test(s) || ONNX_BUILD_PATH_NOISE_RE.test(s);
};

const origWarn = console.warn.bind(console);
const origLog = console.log.bind(console);
const origError = console.error.bind(console);

const surface = shouldSurfaceSubsystemNoise();

console.warn = (...args: unknown[]) => {
  if (isCosmeticAgentdbPatchNoise(args[0])) return;
  if (!surface && isSubsystemInitNoise(args[0])) {
    // file-only — bypass the warn() helper because that one writes to
    // stderr at warn rank (which is the default); fileOnly() never does.
    fileOnly('warn', String(args[0] ?? ''));
    return;
  }
  if (!surface && isOnnxFallbackNoise(args[0])) {
    fileOnly('warn', String(args[0] ?? ''));
    return;
  }
  origWarn(...args);
};

console.log = (...args: unknown[]) => {
  if (isCosmeticAgentdbPatchNoise(args[0])) return;
  if (!surface && isSubsystemInitNoise(args[0])) {
    fileOnly('info', String(args[0] ?? ''));
    return;
  }
  origLog(...args);
};

console.error = (...args: unknown[]) => {
  // ONNX backend prints a multi-line stack to stderr that we never want at
  // default level — it's purely informational, and the actual fallback works.
  if (!surface && isOnnxFallbackNoise(args[0])) {
    fileOnly('warn', String(args[0] ?? ''));
    return;
  }
  origError(...args);
};
