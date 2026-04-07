// Auth helpers
function getToken() {
  return localStorage.getItem('roladin_token');
}

function setToken(token) {
  localStorage.setItem('roladin_token', token);
}

function clearToken() {
  localStorage.removeItem('roladin_token');
}

function requireAuth() {
  if (!getToken()) {
    window.location.href = '/admin/login.html';
    return false;
  }
  return true;
}

// API helper
async function api(url, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.href = '/admin/login.html';
    return null;
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'שגיאה');
  return data;
}

// Toast
function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// Date helpers
function getCurrentWeekKey() {
  const now = new Date();
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 86400000) + 1;
  const weekNum = Math.ceil((dayOfYear + jan4.getDay() - 1) / 7);
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function getNextWeekKey() {
  const current = getCurrentWeekKey();
  const [year, week] = current.split('-W').map(Number);
  const nextWeek = week + 1;
  if (nextWeek > 52) return `${year + 1}-W01`;
  return `${year}-W${String(nextWeek).padStart(2, '0')}`;
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('he-IL', {
    weekday: 'short', day: 'numeric', month: 'numeric'
  });
}

function formatDateTime(isoStr) {
  if (!isoStr) return '-';
  return new Date(isoStr).toLocaleString('he-IL', {
    day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

// Role names in Hebrew
const roleNames = {
  shift_manager: 'אחמ"ש',
  manager: 'מנהל',
  barista: 'בריסטה',
  baker: 'אופה',
  cashier: 'קופאי',
  kitchen: 'מטבח',
  general: 'כללי'
};

const allRoleKeys = ['shift_manager', 'manager', 'barista', 'baker', 'cashier', 'kitchen', 'general'];

const prefNames = {
  morning: 'בוקר בלבד',
  evening: 'ערב בלבד',
  any: 'גם וגם'
};

const roleColors = {
  shift_manager: '#e74c3c',
  manager: '#8e44ad',
  barista: '#3498db',
  baker: '#e67e22',
  cashier: '#2ecc71',
  kitchen: '#f39c12',
  general: '#95a5a6'
};

// Helper: get roles array from employee (backward compatible with old single-role)
function getEmployeeRoles(emp) {
  if (emp.roles && Array.isArray(emp.roles)) return emp.roles;
  if (emp.role && emp.role !== 'general') return [emp.role];
  return ['general'];
}

// Helper: render role badges HTML
function renderRoleBadges(emp) {
  const roles = getEmployeeRoles(emp);
  return roles.map(r =>
    `<span class="role-badge role-${r}">${roleNames[r] || r}</span>`
  ).join(' ');
}

// Helper: check if employee has a specific role
function hasRole(emp, role) {
  return getEmployeeRoles(emp).includes(role);
}

// WebSocket
function connectWS(onMessage) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch {}
  };
  ws.onclose = () => setTimeout(() => connectWS(onMessage), 2000);
  return ws;
}

// Modal helpers
function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

// Create a popup modal with close X button + click-outside-to-close
function showModal(title, bodyHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.innerHTML = `<div class="modal">
    <button class="modal-close" onclick="this.closest('.modal-overlay').remove()" title="סגור">✕</button>
    <h3>${title}</h3>
    ${bodyHtml}
  </div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  return overlay;
}

// Show WA links modal with "send to all" button
// links = [{ name, phone?, waLink, submitted? }]
function showWaLinksModal(title, links) {
  // Build individual links HTML
  const linksHtml = links.map(l => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px;background:var(--bg-input);border-radius:8px">
      <span style="flex:1">${l.name} ${l.submitted === true ? '<span style="color:var(--success);font-size:0.8em">✓</span>' : l.submitted === false ? '' : ''}</span>
      <a href="${l.waLink}" target="_blank" class="wa-link">📱 שלח</a>
    </div>
  `).join('');

  // "Send to all" opens all WA links one after another
  const allLinksJson = JSON.stringify(links.map(l => l.waLink));

  const html = `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <button class="btn btn-success" onclick='sendAllWa(${allLinksJson.replace(/'/g,"&#39;")})'>📱 שלח לכולם (${links.length})</button>
      <button class="btn btn-outline" onclick="copyAllMessages(this)" data-links='${allLinksJson.replace(/'/g,"&#39;")}'>📋 העתק הודעות</button>
    </div>
    ${linksHtml}
  `;

  showModal(title, html);
}

// Open all WA links with delay between each
function sendAllWa(links) {
  if (!confirm('לפתוח וואטסאפ ל-' + links.length + ' עובדים? (יפתח חלון לכל אחד)')) return;
  let i = 0;
  function openNext() {
    if (i >= links.length) return;
    window.open(links[i], '_blank');
    i++;
    if (i < links.length) setTimeout(openNext, 1500);
  }
  openNext();
}

// Copy all messages text for pasting in WA group
function copyAllMessages(btn) {
  const links = JSON.parse(btn.dataset.links);
  // Extract messages from wa.me links
  const messages = links.map(l => {
    try { return decodeURIComponent(new URL(l).searchParams.get('text')); } catch { return ''; }
  }).filter(Boolean);
  const combined = messages[0] || ''; // Usually same message, just take first
  navigator.clipboard.writeText(combined).then(() => {
    btn.textContent = '✓ הועתק!';
    setTimeout(() => btn.textContent = '📋 העתק הודעות', 2000);
  });
}
