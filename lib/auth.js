const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const storage = require('./storage');

const tokens = new Map();

function initAdmin() {
  let settings = storage.read('settings');
  if (!settings) {
    const hash = bcrypt.hashSync(config.ADMIN_PASSWORD, 10);
    settings = {
      branchName: config.BRANCH_NAME,
      adminPasswordHash: hash,
      whatsappSendDay: 0,
      whatsappSendHour: 10,
      availabilityDeadlineDay: 3,
      availabilityDeadlineHour: 20
    };
    storage.write('settings', settings);
  }
  return settings;
}

function login(password) {
  const settings = storage.read('settings');
  if (!settings) return null;
  if (!bcrypt.compareSync(password, settings.adminPasswordHash)) return null;
  const token = uuidv4();
  tokens.set(token, { role: 'admin', createdAt: Date.now() });
  return token;
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'נדרשת התחברות' });
  }
  const token = auth.slice(7);
  if (!tokens.has(token)) {
    return res.status(401).json({ error: 'טוקן לא תקין' });
  }
  next();
}

function validateEmployeeToken(token) {
  const employees = storage.read('employees', []);
  return employees.find(e => e.token === token && e.active);
}

module.exports = { initAdmin, login, requireAdmin, validateEmployeeToken };
