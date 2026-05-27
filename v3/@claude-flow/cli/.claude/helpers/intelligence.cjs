#!/usr/bin/env node
/**
 * Intelligence Layer Stub (ADR-050)
 * Minimal fallback — full version is copied from package source.
 * Provides: init, getContext, recordEdit, feedback, consolidate
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');


function resolveFlowPath(...segs) {
  // Drop redundant leading '.claude' segment for global-install case so we
  // never produce ~/.claude/.claude/... (mirrors settings-generator #bug8).
  function stripRedundant(home, parts) {
    if (parts.length > 0 && parts[0] === '.claude') return parts.slice(1);
    return parts;
  }

  const cwdPath = path.join(process.cwd(), ...segs);
  try {
    // Prefer cwd if its parent already exists (per-project install) or if
    // we can create it (writable cwd, no global override needed).
    const parent = path.dirname(cwdPath);
    if (fs.existsSync(parent)) return cwdPath;
    fs.mkdirSync(parent, { recursive: true });
    // Probe writability — a successful mkdir is enough on POSIX/Windows.
    return cwdPath;
  } catch {
    // Fall through to global fallback
  }

  const homeBase = path.join(os.homedir(), '.claude');
  return path.join(homeBase, ...stripRedundant(homeBase, segs));
}

const DATA_DIR = resolveFlowPath('.claude-flow', 'data');
const STORE_PATH = path.join(DATA_DIR, 'auto-memory-store.json');
const RANKED_PATH = path.join(DATA_DIR, 'ranked-context.json');
const PENDING_PATH = path.join(DATA_DIR, 'pending-insights.jsonl');
const SESSION_DIR = resolveFlowPath('.claude-flow', 'sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'current.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(p) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null; }
  catch { return null; }
}

function writeJSON(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

// Read session context key
function sessionGet(key) {
  var session = readJSON(SESSION_FILE);
  if (!session) return null;
  return key ? (session.context || {})[key] : session.context;
}

// Write session context key
function sessionSet(key, value) {
  var session = readJSON(SESSION_FILE);
  if (!session) return;
  if (!session.context) session.context = {};
  session.context[key] = value;
  writeJSON(SESSION_FILE, session);
}

// Tokenize text into words
function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(function(w) { return w.length > 2; });
}

<<<<<<< HEAD
// Bootstrap entries from MEMORY.md files when store is empty
=======
function trigrams(words) {
  const t = new Set();
  for (const w of words) {
    for (let i = 0; i <= w.length - 3; i++) t.add(w.slice(i, i + 3));
  }
  return t;
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) { if (setB.has(item)) intersection++; }
  return intersection / (setA.size + setB.size - intersection);
}

// ── Deduplication helper (fixes #1518) ──────────────────────────────────────

function deduplicateById(entries) {
  if (!entries || !Array.isArray(entries)) return entries;
  const seen = new Map();
  for (const entry of entries) {
    const id = entry.id || entry.key;
    if (id) {
      seen.set(id, entry);
    } else {
      seen.set(`__no_id_${seen.size}`, entry);
    }
  }
  return Array.from(seen.values());
}

// ADR-095 G6 — content-hash dedup. The April audit measured 5,706 entries
// in the auto-memory store with only ~20 unique by content; 5,686 dupes
// were the same MEMORY.md sections imported from sibling project dirs
// with different IDs. deduplicateById can't catch these (the IDs really
// are different); we need a content fingerprint.
//
// Fast non-cryptographic fingerprint — collisions on 64-bit FNV-1a are
// vanishingly rare for human prose at the scale of an auto-memory store.
// Whitespace-normalized so trivially-different formatting doesn't bypass dedup.
function fingerprintContent(text) {
  if (typeof text !== 'string' || text.length === 0) return '0';
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
  // FNV-1a 64-bit (split into 32-bit halves to stay within Number safe int)
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
  for (let i = 0; i < norm.length; i++) {
    const c = norm.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c; h2 = Math.imul(h2, 0x100000001b3 & 0xffffffff) >>> 0;
  }
  return `${h1.toString(16)}_${h2.toString(16)}_${norm.length}`;
}

function deduplicateByContent(entries) {
  if (!entries || !Array.isArray(entries)) return entries;
  const seen = new Map();
  for (const entry of entries) {
    const content = entry.content || entry.summary || entry.value || '';
    const fp = fingerprintContent(typeof content === 'string' ? content : JSON.stringify(content));
    if (!seen.has(fp)) {
      seen.set(fp, entry);
    } else {
      // Keep the entry with the higher accessCount or earlier createdAt
      const existing = seen.get(fp);
      const existingAccess = existing.accessCount || 0;
      const candidateAccess = entry.accessCount || 0;
      if (candidateAccess > existingAccess) seen.set(fp, entry);
    }
  }
  return Array.from(seen.values());
}

// ── Session state helpers ────────────────────────────────────────────────────

function sessionGet(key) {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    return key ? (session.context || {})[key] : session.context;
  } catch { return null; }
}

function sessionSet(key, value) {
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    let session = {};
    if (fs.existsSync(SESSION_FILE)) {
      session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    }
    if (!session.context) session.context = {};
    session.context[key] = value;
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), 'utf-8');
  } catch { /* best effort */ }
}

// ── PageRank ─────────────────────────────────────────────────────────────────

function computePageRank(nodes, edges, damping, maxIter) {
  damping = damping || 0.85;
  maxIter = maxIter || 30;

  const ids = Object.keys(nodes);
  const n = ids.length;
  if (n === 0) return {};

  // Build adjacency: outgoing edges per node
  const outLinks = {};
  const inLinks = {};
  for (const id of ids) { outLinks[id] = []; inLinks[id] = []; }
  for (const edge of edges) {
    if (outLinks[edge.sourceId]) outLinks[edge.sourceId].push(edge.targetId);
    if (inLinks[edge.targetId]) inLinks[edge.targetId].push(edge.sourceId);
  }

  // Initialize ranks
  const ranks = {};
  for (const id of ids) ranks[id] = 1 / n;

  // Power iteration (with dangling node redistribution)
  for (let iter = 0; iter < maxIter; iter++) {
    const newRanks = {};
    let diff = 0;

    // Collect rank from dangling nodes (no outgoing edges)
    let danglingSum = 0;
    for (const id of ids) {
      if (outLinks[id].length === 0) danglingSum += ranks[id];
    }

    for (const id of ids) {
      let sum = 0;
      for (const src of inLinks[id]) {
        const outCount = outLinks[src].length;
        if (outCount > 0) sum += ranks[src] / outCount;
      }
      // Dangling rank distributed evenly + teleport
      newRanks[id] = (1 - damping) / n + damping * (sum + danglingSum / n);
      diff += Math.abs(newRanks[id] - ranks[id]);
    }

    for (const id of ids) ranks[id] = newRanks[id];
    if (diff < 1e-6) break; // converged
  }

  return ranks;
}

// ── Edge building ────────────────────────────────────────────────────────────

function buildEdges(entries) {
  const edges = [];
  const byCategory = {};

  for (const entry of entries) {
    const cat = entry.category || entry.namespace || 'default';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(entry);
  }

  // Temporal edges: entries from same sourceFile
  const byFile = {};
  for (const entry of entries) {
    const file = (entry.metadata && entry.metadata.sourceFile) || null;
    if (file) {
      if (!byFile[file]) byFile[file] = [];
      byFile[file].push(entry);
    }
  }
  for (const file of Object.keys(byFile)) {
    const group = byFile[file];
    for (let i = 0; i < group.length - 1; i++) {
      edges.push({
        sourceId: group[i].id,
        targetId: group[i + 1].id,
        type: 'temporal',
        weight: 0.5,
      });
    }
  }

  // Similarity edges within categories (Jaccard > 0.3).
  // ADR-095 G6 perf: hoist the trigram computation outside the inner
  // loop. Previously we re-tokenized + re-trigrammed group[j] for every
  // i — O(n²) extra work for nothing. Now compute once per entry.
  for (const cat of Object.keys(byCategory)) {
    const group = byCategory[cat];
    if (group.length < 2) continue;

    // Cache trigram sets for every entry in the group.
    const triCache = new Array(group.length);
    for (let i = 0; i < group.length; i++) {
      triCache[i] = trigrams(tokenize(group[i].content || group[i].summary || ''));
    }

    for (let i = 0; i < group.length; i++) {
      const triA = triCache[i];
      for (let j = i + 1; j < group.length; j++) {
        const sim = jaccardSimilarity(triA, triCache[j]);
        if (sim > 0.3) {
          edges.push({
            sourceId: group[i].id,
            targetId: group[j].id,
            type: 'similar',
            weight: sim,
          });
        }
      }
    }
  }

  return edges;
}

// ── Bootstrap from MEMORY.md files ───────────────────────────────────────────

/**
 * If auto-memory-store.json is empty, bootstrap by parsing MEMORY.md and
 * topic files from the auto-memory directory. This removes the dependency
 * on @claude-flow/memory for the initial seed.
 */
>>>>>>> pr-1936-head
function bootstrapFromMemoryFiles() {
  var entries = [];
  var candidates = [
    path.join(os.homedir(), ".claude", "projects"),
    resolveFlowPath(".claude-flow", "memory"),
    resolveFlowPath(".claude", "memory"),
  ];
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (!fs.existsSync(candidates[i])) continue;
      var files = [];
      try {
        var items = fs.readdirSync(candidates[i], { withFileTypes: true, recursive: true });
        for (var j = 0; j < items.length; j++) {
          if (items[j].name === "MEMORY.md") {
            var parentDir = items[j].parentPath || items[j].path || candidates[i];
            var fp = path.join(parentDir, items[j].name);
            files.push(fp);
          }
        }
      } catch (e) { continue; }
      for (var k = 0; k < files.length; k++) {
        try {
          var content = fs.readFileSync(files[k], "utf-8");
          var sections = content.split(/^##\s+/m).filter(function(s) { return s.trim().length > 20; });
          for (var s = 0; s < sections.length; s++) {
            var lines2 = sections[s].split("\n");
            var title = lines2[0] ? lines2[0].trim() : "section-" + s;
            entries.push({
              id: "mem-" + entries.length,
              content: sections[s].substring(0, 500),
              summary: title.substring(0, 100),
              category: "memory",
              confidence: 0.5,
              sourceFile: files[k],
              words: tokenize(sections[s].substring(0, 500)),
            });
          }
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* skip */ }
  }
  return entries;
}

// Load entries from auto-memory-store or bootstrap from MEMORY.md
function loadEntries() {
  var store = readJSON(STORE_PATH);
  // Support both formats: flat array or { entries: [...] }
  var entries = null;
  if (store) {
    if (Array.isArray(store) && store.length > 0) {
      entries = store;
    } else if (store.entries && store.entries.length > 0) {
      entries = store.entries;
    }
  }
<<<<<<< HEAD
  if (entries) {
    return entries.map(function(e, i) {
=======

  // Deduplicate store entries by ID (fixes #1518 — 194MB → ~79KB)
  let deduped = deduplicateById(store);
  // ADR-095 G6: also dedupe by content fingerprint. The April audit
  // measured 5,706 entries with only ~20 unique by content because the
  // same MEMORY.md sections get imported from sibling project dirs with
  // different IDs. deduplicateById can't catch that; deduplicateByContent
  // can. Cuts the graph from O(n²) over near-identical duplicates down
  // to O(unique²), which is the difference between a 100MB graph-state
  // and a kilobytes-scale one for typical workloads.
  const beforeContentDedup = deduped.length;
  deduped = deduplicateByContent(deduped);
  if (deduped.length < store.length) {
    process.stderr.write(
      `[INTELLIGENCE] Deduped store: ${store.length} -> ${deduped.length} entries ` +
      `(by-id: ${store.length - beforeContentDedup} dropped, by-content: ${beforeContentDedup - deduped.length} dropped)\n`
    );
    writeJSON(STORE_PATH, deduped);
  }

  // Skip rebuild if graph is fresh and store hasn't changed
  if (graphState && graphState.nodeCount === deduped.length) {
    const age = Date.now() - (graphState.updatedAt || 0);
    if (age < 60000) {
>>>>>>> pr-1936-head
      return {
        id: e.id || ("entry-" + i),
        content: e.content || e.value || "",
        summary: e.summary || e.key || "",
        category: e.category || e.namespace || "default",
        confidence: e.confidence || 0.5,
        sourceFile: e.sourceFile || (e.metadata && e.metadata.sourceFile) || "",
        words: tokenize((e.content || e.value || "") + " " + (e.summary || e.key || "")),
      };
    });
  }
  return bootstrapFromMemoryFiles();
}

// Simple keyword match score
function matchScore(promptWords, entryWords) {
  if (!promptWords.length || !entryWords.length) return 0;
  var entrySet = {};
  for (var i = 0; i < entryWords.length; i++) entrySet[entryWords[i]] = true;
  var overlap = 0;
  for (var j = 0; j < promptWords.length; j++) {
    if (entrySet[promptWords[j]]) overlap++;
  }
  var union = Object.keys(entrySet).length + promptWords.length - overlap;
  return union > 0 ? overlap / union : 0;
}

var cachedEntries = null;

module.exports = {
  init: function() {
    cachedEntries = loadEntries();
    var ranked = cachedEntries.map(function(e) {
      return { id: e.id, content: e.content, summary: e.summary, category: e.category, confidence: e.confidence, words: e.words };
    });
    writeJSON(RANKED_PATH, { version: 1, computedAt: Date.now(), entries: ranked });
    return { nodes: cachedEntries.length, edges: 0 };
  },

  getContext: function(prompt) {
    if (!prompt) return null;
    var ranked = readJSON(RANKED_PATH);
    var entries = (ranked && ranked.entries) || (cachedEntries || []);
    if (!entries.length) return null;
    var promptWords = tokenize(prompt);
    if (!promptWords.length) return null;
    var scored = entries.map(function(e) {
      return { entry: e, score: matchScore(promptWords, e.words || tokenize(e.content + " " + e.summary)) };
    }).filter(function(s) { return s.score > 0.05; });
    scored.sort(function(a, b) { return b.score - a.score; });
    var top = scored.slice(0, 5);
    if (!top.length) return null;
    var prevMatched = sessionGet("lastMatchedPatterns");
    var matchedIds = top.map(function(s) { return s.entry.id; });
    sessionSet("lastMatchedPatterns", matchedIds);
    if (prevMatched && Array.isArray(prevMatched)) {
      var newSet = {};
      for (var i = 0; i < matchedIds.length; i++) newSet[matchedIds[i]] = true;
    }
    var lines2 = ["[INTELLIGENCE] Relevant patterns for this task:"];
    for (var j = 0; j < top.length; j++) {
      var e = top[j];
      var conf = e.entry.confidence || 0.5;
      var summary = (e.entry.summary || e.entry.content || "").substring(0, 80);
      lines2.push("  * (" + conf.toFixed(2) + ") " + summary);
    }
    return lines2.join("\n");
  },

  recordEdit: function(file) {
    if (!file) return;
    ensureDir(DATA_DIR);
    var line = JSON.stringify({ type: "edit", file: file, timestamp: Date.now() }) + "\n";
    fs.appendFileSync(PENDING_PATH, line, "utf-8");
  },

  feedback: function(success) {
    // Stub: no-op in minimal version
  },

  consolidate: function() {
    var count = 0;
    if (fs.existsSync(PENDING_PATH)) {
      try {
        var content = fs.readFileSync(PENDING_PATH, "utf-8").trim();
        count = content ? content.split("\n").length : 0;
        fs.writeFileSync(PENDING_PATH, "", "utf-8");
      } catch (e) { /* skip */ }
    }
    return { entries: count, edges: 0, newEntries: 0 };
  },
};
