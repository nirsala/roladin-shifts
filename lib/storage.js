const fs = require('fs');
const path = require('path');
const config = require('../config');

const DEFAULTS_DIR = path.join(__dirname, '..', 'defaults');

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
    // Try loading from defaults first
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
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function update(name, fn, defaultValue = null) {
  const current = read(name, defaultValue);
  const updated = fn(current);
  write(name, updated);
  return updated;
}

// Export backup function for saving current data back to defaults
function backupToDefaults(name) {
  const filePath = getFilePath(name);
  if (!fs.existsSync(filePath)) return false;
  if (!fs.existsSync(DEFAULTS_DIR)) {
    fs.mkdirSync(DEFAULTS_DIR, { recursive: true });
  }
  fs.copyFileSync(filePath, getDefaultPath(name));
  return true;
}

module.exports = { read, write, update, seedFromDefaults, backupToDefaults };
