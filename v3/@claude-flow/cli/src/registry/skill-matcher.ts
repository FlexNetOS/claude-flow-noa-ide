/**
 * #bug23.0 — Shared keyword-matching utility for scoring user-installed
 * skills/agents (from `claude-code-registry`) against a free-form task
 * description.
 *
 * Originally lived inside `mcp-tools/hooks-tools.ts` (added in #bug22.3).
 * Extracted here so `swarm_init` (#bug23) can reuse the exact same scorer
 * — we want `hooks_route` and `swarm_init` to agree on which user content
 * matches a task, otherwise the swarm orchestration would say one thing
 * and the routing recommendation would say another.
 *
 * MVP keyword approach (intentionally simple — see TODO below). For each
 * user skill we tokenize:
 *   - The skill `name` (e.g. "polymarket-analyzer" → ["polymarket",
 *     "analyzer"]).
 *   - The first ~40 description tokens, filtered to informative tokens
 *     (>= 3 chars, alphanumerics, deduped, no common stopwords).
 *
 * Each task token that overlaps the skill's bag scores +1, with a 2×
 * weight when the hit is on a name-token (the most reliable signal that
 * the user wrote a skill specifically for this).
 *
 * Returns the top-K matches sorted by score (>= 1). Empty array means no
 * user skill should be considered.
 *
 * #bug25.2 — Semantic + hybrid scoring layered on top of the keyword
 * baseline. When a local Ollama daemon is reachable and a known
 * embedding model is pulled (`mxbai-embed-large` preferred, falls back
 * to `nomic-embed-text`), `matchUserSkillsForTaskSemantic` augments the
 * keyword scorer with cosine-similarity matching so paraphrases like
 * "trading bot" can find the user's `polymarket-analyzer` skill even
 * though they share no surface tokens. When Ollama is not available we
 * transparently degrade to the original keyword scorer — the matcher
 * never fails closed.
 */

import type { UserAgent, UserSkill } from './claude-code-registry.js';
import {
  cosineSimilarity,
  embedTexts,
  type EmbedOptions,
} from './ollama-embedder.js';

export interface UserSkillMatch {
  type: 'skill' | 'agent';
  name: string;
  score: number;
  description?: string;
  matchedKeywords: string[];
}

export function tokenizeForSkillMatching(text: string): string[] {
  return text
    .toLowerCase()
    // Split on non-alphanumerics so dashes / underscores yield separate tokens.
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

export const COMMON_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'use', 'when', 'how', 'has',
  'are', 'you', 'can', 'all', 'any', 'should', 'will', 'have', 'been', 'was',
  'were', 'into', 'from', 'about', 'task', 'tasks', 'agent', 'agents', 'skill',
  'skills', 'using', 'used', 'than', 'then', 'their', 'there', 'where',
]);

export function buildSkillKeywordBag(
  skill: UserSkill | UserAgent,
): { tokens: Set<string>; nameTokens: Set<string> } {
  const nameTokens = new Set(tokenizeForSkillMatching(skill.name));
  const bag = new Set<string>(nameTokens);

  // Cap how much we mine from descriptions — long descriptions otherwise
  // drown out the skill-name signal.
  if (skill.description) {
    const descTokens = tokenizeForSkillMatching(skill.description).slice(0, 40);
    for (const t of descTokens) {
      if (!COMMON_STOPWORDS.has(t)) bag.add(t);
    }
  }
  return { tokens: bag, nameTokens };
}

export function matchUserSkillsForTask(
  task: string,
  context: string | undefined,
  skills: UserSkill[],
  agents: UserAgent[],
  topK = 5,
): UserSkillMatch[] {
  const taskTokens = new Set([
    ...tokenizeForSkillMatching(task),
    ...(context ? tokenizeForSkillMatching(context) : []),
  ]);
  if (taskTokens.size === 0) return [];

  const candidates: UserSkillMatch[] = [];

  for (const skill of skills) {
    const { tokens, nameTokens } = buildSkillKeywordBag(skill);
    let score = 0;
    const matched: string[] = [];
    for (const t of taskTokens) {
      if (tokens.has(t)) {
        // Name-token match weighted 2× — strongest signal.
        const weight = nameTokens.has(t) ? 2 : 1;
        score += weight;
        matched.push(t);
      }
    }
    if (score >= 1) {
      candidates.push({
        type: 'skill',
        name: skill.name,
        score,
        description: skill.description,
        matchedKeywords: matched,
      });
    }
  }

  // Also consider user agents — many agents (polymarket-analyzer, ceo,
  // polybot-ops) are addressable directly even if there's no skill for them.
  for (const agent of agents) {
    const { tokens, nameTokens } = buildSkillKeywordBag(agent);
    let score = 0;
    const matched: string[] = [];
    for (const t of taskTokens) {
      if (tokens.has(t)) {
        const weight = nameTokens.has(t) ? 2 : 1;
        score += weight;
        matched.push(t);
      }
    }
    if (score >= 1) {
      candidates.push({
        type: 'agent',
        name: agent.name,
        score,
        description: agent.description,
        matchedKeywords: matched,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topK);
}

// ---------------------------------------------------------------------------
// #bug25.2 — Semantic + hybrid scoring (Ollama-backed)
// ---------------------------------------------------------------------------

/**
 * Backend that produced a `MatchResult`. `embedding` means pure cosine
 * similarity on Ollama vectors. `keyword` means we fell back to the
 * original lexical scorer (Ollama unreachable / empty vectors). `hybrid`
 * is the recommended default — we blend `0.7 * semantic + 0.3 * keyword`
 * so name-token hits still help disambiguate semantically-similar skills.
 */
export type SkillMatchBackend = 'embedding' | 'keyword' | 'hybrid';

export interface MatchResult {
  matches: UserSkillMatch[];
  backend: SkillMatchBackend;
  /** Embedding model that fired, if any (e.g. `mxbai-embed-large`). */
  model: string | null;
}

export interface SemanticMatchOptions {
  /** Override embedding model (otherwise uses default fallback chain). */
  embeddingModel?: string;
  /** Cosine-similarity threshold below which a skill is dropped. Default 0.45. */
  threshold?: number;
  /** Top-K cap on the returned matches. Default 5. */
  maxResults?: number;
  /** Pure-semantic mode (skip keyword blend). Default false. */
  pureSemantic?: boolean;
  /**
   * Weight for the semantic component when blending. Default 0.7.
   * Keyword weight = `1 - semanticWeight`.
   */
  semanticWeight?: number;
  /** Forwarded to {@link embedTexts} (test injection points). */
  embedderOptions?: EmbedOptions;
}

/** Default cosine threshold — anything below this is considered noise. */
const DEFAULT_SEMANTIC_THRESHOLD = 0.45;
/** Default semantic weight in the hybrid blend (0.7 sem + 0.3 kw). */
const DEFAULT_SEMANTIC_WEIGHT = 0.7;

/**
 * Build the text we embed for a skill/agent. The skill `name` is
 * surfaced first so it carries weight in the embedding (most embedding
 * models pay extra attention to early tokens), then the description.
 * Names like `polymarket-analyzer` are de-hyphenated so the embedder
 * sees natural-language tokens.
 */
function skillEmbeddingText(skill: UserSkill | UserAgent): string {
  const name = skill.name.replace(/[-_]+/g, ' ');
  const desc = skill.description?.trim() ?? '';
  return desc.length > 0 ? `${name}. ${desc}` : name;
}

/**
 * Normalize the keyword score into [0, 1] for the hybrid blend. Keyword
 * scores are unbounded ints (sum of weighted token hits), but in
 * practice never exceed ~10 for sane skills. We cap at 10 so a single
 * skill with one rare token doesn't dominate via the keyword channel.
 */
function normalizeKeywordScore(score: number): number {
  const capped = Math.min(score, 10);
  return capped / 10;
}

/**
 * Run the existing keyword scorer over a single skill (or agent) and
 * return its raw score + matched tokens. Used internally by the hybrid
 * path so we don't have to call `matchUserSkillsForTask` and re-walk
 * everything — we already know the candidate.
 */
function keywordScoreOne(
  taskTokens: Set<string>,
  skill: UserSkill | UserAgent,
): { score: number; matchedKeywords: string[] } {
  const { tokens, nameTokens } = buildSkillKeywordBag(skill);
  let score = 0;
  const matched: string[] = [];
  for (const t of taskTokens) {
    if (tokens.has(t)) {
      const weight = nameTokens.has(t) ? 2 : 1;
      score += weight;
      matched.push(t);
    }
  }
  return { score, matchedKeywords: matched };
}

/**
 * Semantic + hybrid skill matcher. Embeds the task once, embeds each
 * candidate skill (cached forever via the on-disk embedding cache),
 * computes cosine similarity, and (by default) blends with the keyword
 * scorer for the final ranking.
 *
 * Behavior contract:
 *   - Returns `{ backend: 'keyword', ... }` if Ollama is unreachable
 *     or no model in the fallback chain is pulled. Caller can rely on
 *     getting matches either way.
 *   - Returns `{ backend: 'embedding', ... }` when `pureSemantic` is set.
 *   - Returns `{ backend: 'hybrid', ... }` for the default blended path.
 *   - Threshold filters apply to the *blended* score in hybrid mode and
 *     to raw cosine similarity in pure-semantic mode.
 */
export async function matchUserSkillsForTaskSemantic(
  task: string,
  context: string | undefined,
  skills: UserSkill[],
  agents: UserAgent[],
  opts?: SemanticMatchOptions,
): Promise<MatchResult> {
  const threshold = opts?.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
  const maxResults = opts?.maxResults ?? 5;
  const semanticWeight = opts?.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT;
  const keywordWeight = Math.max(0, 1 - semanticWeight);
  const pureSemantic = opts?.pureSemantic === true;

  const all: Array<UserSkill | UserAgent> = [...skills, ...agents];
  if (all.length === 0) {
    return { matches: [], backend: pureSemantic ? 'embedding' : 'hybrid', model: null };
  }

  // Stitch task + context into the query text the same way `hooks_route`
  // does for its keyword scorer — keeps semantic and keyword channels
  // operating on identical input.
  const queryText = context && context.trim().length > 0 ? `${task}\n${context}` : task;

  // Embed query + every candidate in a single batch (Ollama supports
  // batched inputs). Cached entries short-circuit the HTTP call.
  const embedInputs = [queryText, ...all.map(skillEmbeddingText)];
  const embedResult = await embedTexts(embedInputs, {
    model: opts?.embeddingModel,
    ...opts?.embedderOptions,
  });

  // Graceful fallback: Ollama unavailable → fall back to keyword.
  if (embedResult.backend === null || embedResult.vectors.length !== embedInputs.length) {
    return {
      matches: matchUserSkillsForTask(task, context, skills, agents, maxResults),
      backend: 'keyword',
      model: null,
    };
  }

  const queryVec = embedResult.vectors[0];
  const candidateVecs = embedResult.vectors.slice(1);

  // Pre-compute task tokens once for the keyword channel.
  const taskTokens = new Set([
    ...tokenizeForSkillMatching(task),
    ...(context ? tokenizeForSkillMatching(context) : []),
  ]);

  const candidates: UserSkillMatch[] = [];
  for (let i = 0; i < all.length; i++) {
    const skill = all[i];
    const cosine = cosineSimilarity(queryVec, candidateVecs[i]);
    const isAgent = i >= skills.length;

    if (pureSemantic) {
      if (cosine < threshold) continue;
      const kw = keywordScoreOne(taskTokens, skill);
      candidates.push({
        type: isAgent ? 'agent' : 'skill',
        name: skill.name,
        // Express semantic similarity directly as the score. Multiply
        // by 10 so values land in roughly the same magnitude as the
        // keyword scorer, making downstream callers (which compare to
        // the keyword threshold of 1) Just Work.
        score: cosine * 10,
        description: skill.description,
        matchedKeywords: kw.matchedKeywords,
      });
      continue;
    }

    // Hybrid: blend semantic cosine with normalized keyword score.
    const kw = keywordScoreOne(taskTokens, skill);
    const kwNorm = normalizeKeywordScore(kw.score);
    const blended = semanticWeight * cosine + keywordWeight * kwNorm;
    if (blended < threshold) continue;
    candidates.push({
      type: isAgent ? 'agent' : 'skill',
      name: skill.name,
      // Same magnitude convention as above — caller code that compares
      // `score >= 1` for "decent match" still works.
      score: blended * 10,
      description: skill.description,
      matchedKeywords: kw.matchedKeywords,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    matches: candidates.slice(0, maxResults),
    backend: pureSemantic ? 'embedding' : 'hybrid',
    model: embedResult.model,
  };
}
