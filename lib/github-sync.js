/**
 * GitHub Sync - automatically pushes data changes back to the repo's defaults/ directory.
 * This ensures data survives Render redeploys.
 *
 * Requires env vars: GITHUB_TOKEN, GITHUB_REPO (e.g. "nirsala/roladin-shifts")
 * Uses the GitHub Contents API to update files in the defaults/ folder.
 */

const https = require('https');
const config = require('../config');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'nirsala/roladin-shifts';
const BRANCH = process.env.GITHUB_BRANCH || 'main';

let syncQueue = new Map(); // name -> json string
let syncTimer = null;
const DEBOUNCE_MS = 5000; // wait 5 seconds after last change before syncing

function isEnabled() {
  return !!GITHUB_TOKEN;
}

function githubApi(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'roladin-shifts',
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getFileSha(filePath) {
  try {
    const res = await githubApi('GET', `/contents/${filePath}?ref=${BRANCH}`);
    if (res.status === 200 && res.data.sha) {
      return res.data.sha;
    }
  } catch {}
  return null;
}

async function pushFile(name, jsonContent) {
  const filePath = `defaults/${name}.json`;
  const content = Buffer.from(jsonContent, 'utf8').toString('base64');

  // Get current SHA (needed for update, not for create)
  const sha = await getFileSha(filePath);

  const body = {
    message: `auto-sync: update ${name}`,
    content,
    branch: BRANCH
  };
  if (sha) body.sha = sha;

  const res = await githubApi('PUT', `/contents/${filePath}`, body);
  return res.status === 200 || res.status === 201;
}

function queueSync(name, json) {
  if (!isEnabled()) return;

  syncQueue.set(name, json);

  // Debounce: wait for more changes before syncing
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(flushSync, DEBOUNCE_MS);
}

async function flushSync() {
  if (syncQueue.size === 0) return;

  const items = new Map(syncQueue);
  syncQueue.clear();
  syncTimer = null;

  console.log(`[github-sync] Syncing ${items.size} files...`);

  for (const [name, json] of items) {
    try {
      const ok = await pushFile(name, json);
      if (ok) {
        console.log(`[github-sync] ✓ ${name}`);
      } else {
        console.log(`[github-sync] ✗ ${name} failed`);
      }
    } catch (err) {
      console.error(`[github-sync] ✗ ${name} error:`, err.message);
    }
  }
}

module.exports = { queueSync, isEnabled, flushSync };
