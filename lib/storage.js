const fs = require('fs');
const path = require('path');
const config = require('../config');
const githubSync = require('./github-sync');

const DEFAULTS_DIR = path.join(__dirname, '..', 'defaults');

// Files that should auto-persist so they survive redeploys
const PERSIST_FILES = ['employees', 'shifts-config', 'settings', 'availability', 'schedules', 'swap-requests'];

function getFilePath(name) {
  return path.join(config.DATA_DIR, `${name}.json`);
}

function getDefaultPath(name) {
  return path.join(DEFAULTS_DIR, `${name}.json`);
}

function ensureDataDir() {
  if (!fs.existsSync(config.DATA_DIR)) {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
  }
}

function ensureDefaultsDir() {
  if (!fs.existsSync(DEFAULTS_DIR)) {
    fs.mkdirSync(DEFAULTS_DIR, { recursive: true });
  }
}

function seedFromDefaults() {
  ensureDataDir();
  if (!fs.existsSync(DEFAULTS_DIR)) return;

  const files = fs.readdirSync(DEFAULTS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const name = file.replace('.json', '');
    const dataPath = getFilePath(name);
    if (!fs.existsSync(dataPath)) {
      const defaultPath = getDefaultPath(name);
      fs.copyFileSync(defaultPath, dataPath);
      console.log(`[storage] Seeded ${name} from defaults`);
    }
  }
}

function read(name, defaultValue = null) {
  ensureDataDir();
  const filePath = getFilePath(name);
  if (!fs.existsSync(filePath)) {
    const defaultPath = getDefaultPath(name);
    if (fs.existsSync(defaultPath)) {
      fs.copyFileSync(defaultPath, filePath);
      console.log(`[storage] Loaded ${name} from defaults`);
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }
    if (defaultValue !== null) {
      write(name, defaultValue);
      return defaultValue;
    }
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function write(name, data) {
  ensureDataDir();
  const filePath = getFilePath(name);
  const tmpPath = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, json, 'utf8');
  fs.renameSync(tmpPath, filePath);

  // Persist: save to defaults/ locally AND sync to GitHub
  if (PERSIST_FILES.includes(name)) {
    // Local defaults (works when running locally)
    try {
      ensureDefaultsDir();
      const defaultTmp = getDefaultPath(name) + '.tmp';
      fs.writeFileSync(defaultTmp, json, 'utf8');
      fs.renameSync(defaultTmp, getDefaultPath(name));
    } catch {}

    // GitHub sync (works on Render - pushes to repo so next deploy has data)
    githubSync.queueSync(name, json);
  }
}

function update(name, fn, defaultValue = null) {
  const current = read(name, defaultValue);
  const updated = fn(current);
  write(name, updated);
  return updated;
}

module.exports = { read, write, update, seedFromDefaults };
