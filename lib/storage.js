const fs = require('fs');
const path = require('path');
const config = require('../config');

const locks = {};

function getFilePath(name) {
  return path.join(config.DATA_DIR, `${name}.json`);
}

function ensureDataDir() {
  if (!fs.existsSync(config.DATA_DIR)) {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
  }
}

function read(name, defaultValue = null) {
  ensureDataDir();
  const filePath = getFilePath(name);
  if (!fs.existsSync(filePath)) {
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

module.exports = { read, write, update };
