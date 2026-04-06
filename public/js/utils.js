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
  barista: 'בריסטה',
  cashier: 'קופאית',
  kitchen: 'מטבח',
  general: 'כללי'
};

const prefNames = {
  morning: 'בוקר בלבד',
  evening: 'ערב בלבד',
  any: 'גם וגם'
};

const roleColors = {
  shift_manager: '#e74c3c',
  barista: '#3498db',
  cashier: '#2ecc71',
  kitchen: '#f39c12',
  general: '#95a5a6'
};

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
