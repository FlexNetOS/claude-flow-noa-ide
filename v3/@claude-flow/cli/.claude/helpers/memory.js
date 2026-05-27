#!/usr/bin/env node
/**
 * Ruflo Memory Helper
 * Simple key-value memory for cross-session context
 */

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

const MEMORY_DIR = resolveFlowPath('.claude-flow', 'data');
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    }
  } catch (e) {
    // Ignore
  }
  return {};
}

function saveMemory(memory) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

const commands = {
  get: (key) => {
    const memory = loadMemory();
    const value = key ? memory[key] : memory;
    console.log(JSON.stringify(value, null, 2));
    return value;
  },

  set: (key, value) => {
    if (!key) {
      console.error('Key required');
      return;
    }
    const memory = loadMemory();
    memory[key] = value;
    memory._updated = new Date().toISOString();
    saveMemory(memory);
    console.log(`Set: ${key}`);
  },

  delete: (key) => {
    if (!key) {
      console.error('Key required');
      return;
    }
    const memory = loadMemory();
    delete memory[key];
    saveMemory(memory);
    console.log(`Deleted: ${key}`);
  },

  clear: () => {
    saveMemory({});
    console.log('Memory cleared');
  },

  keys: () => {
    const memory = loadMemory();
    const keys = Object.keys(memory).filter(k => !k.startsWith('_'));
    console.log(keys.join('\n'));
    return keys;
  },
};

// CLI
const [,, command, key, ...valueParts] = process.argv;
const value = valueParts.join(' ');

if (command && commands[command]) {
  commands[command](key, value);
} else {
  console.log('Usage: memory.js <get|set|delete|clear|keys> [key] [value]');
}

module.exports = commands;
