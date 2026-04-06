const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const config = require('./config');
const storage = require('./lib/storage');
const auth = require('./lib/auth');
const whatsapp = require('./lib/whatsapp');
const holidays = require('./lib/holidays');
const stats = require('./lib/stats');
const { generateSchedule, getShiftsForDate, getWeekDates } = require('./lib/scheduler');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/admin/login.html'));

// --- Init: seed data from defaults if data/ is empty ---
storage.seedFromDefaults();
auth.initAdmin();
storage.read('employees', []);
storage.read('shifts-config', {
  defaultShifts: [
    { id: 'morning', name: 'בוקר', start: '07:00', end: '15:00', requiredEmployees: 4 },
    { id: 'evening', name: 'ערב', start: '15:00', end: '23:00', requiredEmployees: 3 }
  ],
  dayOverrides: {},
  dateOverrides: {},
  roleRequirements: {}
});
storage.read('availability', {});
storage.read('schedules', {});
storage.read('swap-requests', []);

// --- WebSocket ---
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ==================== AUTH ====================
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const token = auth.login(password);
  if (!token) return res.status(401).json({ error: 'סיסמה שגויה' });
  res.json({ token });
});

// ==================== EMPLOYEES ====================
app.get('/api/employees', auth.requireAdmin, (req, res) => {
  const employees = storage.read('employees', []);
  res.json(employees);
});

app.post('/api/employees', auth.requireAdmin, (req, res) => {
  const { name, phone, role, shiftPreference, maxShiftsPerWeek } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'שם וטלפון חובה' });

  const employee = {
    id: uuidv4(),
    name,
    phone,
    token: uuidv4().slice(0, 8),
    role: role || 'general',
    shiftPreference: shiftPreference || 'any',
    maxShiftsPerWeek: maxShiftsPerWeek || config.MAX_SHIFTS_PER_WEEK,
    active: true,
    createdAt: new Date().toISOString()
  };

  storage.update('employees', list => [...list, employee], []);
  broadcast('employee_added', { id: employee.id, name: employee.name });
  res.status(201).json(employee);
});

app.put('/api/employees/:id', auth.requireAdmin, (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const result = storage.update('employees', list => {
    const idx = list.findIndex(e => e.id === id);
    if (idx === -1) return list;
    list[idx] = { ...list[idx], ...updates, id };
    return list;
  }, []);

  const emp = result.find(e => e.id === id);
  if (!emp) return res.status(404).json({ error: 'עובדת לא נמצאה' });
  res.json(emp);
});

app.delete('/api/employees/:id', auth.requireAdmin, (req, res) => {
  const { id } = req.params;
  storage.update('employees', list => list.filter(e => e.id !== id), []);
  res.json({ success: true });
});

app.post('/api/employees/:id/regenerate-token', auth.requireAdmin, (req, res) => {
  const { id } = req.params;
  const newToken = uuidv4().slice(0, 8);
  storage.update('employees', list => {
    const emp = list.find(e => e.id === id);
    if (emp) emp.token = newToken;
    return list;
  }, []);
  res.json({ token: newToken });
});

// ==================== SHIFTS CONFIG ====================
app.get('/api/shifts-config', auth.requireAdmin, (req, res) => {
  res.json(storage.read('shifts-config', {}));
});

app.put('/api/shifts-config', auth.requireAdmin, (req, res) => {
  storage.write('shifts-config', req.body);
  res.json({ success: true });
});

app.get('/api/shifts-config/for-date/:date', auth.requireAdmin, (req, res) => {
  const shiftsConfig = storage.read('shifts-config', {});
  const shifts = getShiftsForDate(req.params.date, shiftsConfig);
  res.json({ date: req.params.date, shifts, closed: shifts === null });
});

// ==================== AVAILABILITY ====================
app.post('/api/availability/:weekKey/open', auth.requireAdmin, (req, res) => {
  const { weekKey } = req.params;
  const { deadline, mandatory } = req.body;

  storage.update('availability', data => {
    data[weekKey] = {
      deadline: deadline || null,
      mandatory: mandatory || false,
      mandatoryDays: req.body.mandatoryDays || [],
      submissions: data[weekKey]?.submissions || {}
    };
    return data;
  }, {});

  broadcast('week_opened', { weekKey });
  res.json({ success: true, weekKey });
});

app.get('/api/availability/:weekKey/status', auth.requireAdmin, (req, res) => {
  const { weekKey } = req.params;
  const availability = storage.read('availability', {});
  const week = availability[weekKey];
  if (!week) return res.status(404).json({ error: 'שבוע לא נפתח' });

  const employees = storage.read('employees', []).filter(e => e.active);
  const submitted = Object.keys(week.submissions || {});
  const notSubmitted = employees.filter(e => !submitted.includes(e.id));

  res.json({
    weekKey,
    deadline: week.deadline,
    mandatory: week.mandatory,
    mandatoryDays: week.mandatoryDays || [],
    totalEmployees: employees.length,
    submittedCount: submitted.length,
    submitted: employees.filter(e => submitted.includes(e.id)).map(e => ({
      id: e.id, name: e.name, submittedAt: week.submissions[e.id]?.submittedAt
    })),
    notSubmitted: notSubmitted.map(e => ({ id: e.id, name: e.name, phone: e.phone }))
  });
});

// Public - employee availability form data
app.get('/api/availability/form/:token', (req, res) => {
  const emp = auth.validateEmployeeToken(req.params.token);
  if (!emp) return res.status(404).json({ error: 'קישור לא תקין' });

  const weekKey = req.query.week;
  const availability = storage.read('availability', {});
  const week = availability[weekKey];
  if (!week) return res.status(404).json({ error: 'שבוע לא נפתח להגשות' });

  const shiftsConfig = storage.read('shifts-config', {});
  const dates = getWeekDates(weekKey);
  const daysInfo = dates.map(d => ({
    date: d,
    dayName: new Date(d).toLocaleDateString('he-IL', { weekday: 'long' }),
    shifts: getShiftsForDate(d, shiftsConfig),
    holiday: holidays.isHoliday(d)
  }));

  const existing = week.submissions?.[emp.id] || null;

  res.json({
    employee: { id: emp.id, name: emp.name, shiftPreference: emp.shiftPreference },
    weekKey,
    deadline: week.deadline,
    mandatory: week.mandatory,
    mandatoryDays: week.mandatoryDays || [],
    days: daysInfo,
    existing
  });
});

// Public - submit availability
app.post('/api/availability/submit/:token', (req, res) => {
  const emp = auth.validateEmployeeToken(req.params.token);
  if (!emp) return res.status(404).json({ error: 'קישור לא תקין' });

  const { weekKey, days, blackoutDays, shiftPreference, notes } = req.body;

  storage.update('availability', data => {
    if (!data[weekKey]) return data;
    if (!data[weekKey].submissions) data[weekKey].submissions = {};
    data[weekKey].submissions[emp.id] = {
      submittedAt: new Date().toISOString(),
      days: days || {},
      blackoutDays: blackoutDays || [],
      shiftPreference: shiftPreference || emp.shiftPreference || 'any',
      notes: notes || ''
    };
    return data;
  }, {});

  broadcast('availability_submitted', { employeeId: emp.id, name: emp.name, weekKey });
  res.json({ success: true, message: 'הזמינות נשמרה בהצלחה!' });
});

// ==================== SCHEDULES ====================
app.post('/api/schedules/:weekKey/generate', auth.requireAdmin, (req, res) => {
  const { weekKey } = req.params;
  const result = generateSchedule(weekKey);
  if (result.error) return res.status(400).json(result);

  storage.update('schedules', data => {
    data[weekKey] = result;
    return data;
  }, {});

  broadcast('schedule_generated', { weekKey });
  res.json(result);
});

app.get('/api/schedules/:weekKey', auth.requireAdmin, (req, res) => {
  const schedules = storage.read('schedules', {});
  const schedule = schedules[req.params.weekKey];
  if (!schedule) return res.status(404).json({ error: 'סידור לא נמצא' });

  // Enrich with employee names
  const employees = storage.read('employees', []);
  const empMap = {};
  employees.forEach(e => { empMap[e.id] = e; });

  const enriched = JSON.parse(JSON.stringify(schedule));
  for (const [dateStr, shifts] of Object.entries(enriched.days || {})) {
    if (!shifts) continue;
    for (const [shiftId, empIds] of Object.entries(shifts)) {
      shifts[shiftId] = empIds.map(id => ({
        id,
        name: empMap[id]?.name || 'לא ידוע',
        role: empMap[id]?.role || 'general'
      }));
    }
  }

  res.json(enriched);
});

app.put('/api/schedules/:weekKey', auth.requireAdmin, (req, res) => {
  const { weekKey } = req.params;
  const { days, editNote } = req.body;

  storage.update('schedules', data => {
    if (!data[weekKey]) return data;
    data[weekKey].days = days;
    if (editNote) {
      data[weekKey].manualEdits.push({
        by: 'admin', at: new Date().toISOString(), action: editNote
      });
    }
    return data;
  }, {});

  broadcast('schedule_updated', { weekKey });
  res.json({ success: true });
});

app.post('/api/schedules/:weekKey/publish', auth.requireAdmin, (req, res) => {
  const { weekKey } = req.params;
  storage.update('schedules', data => {
    if (data[weekKey]) {
      data[weekKey].status = 'published';
      data[weekKey].publishedAt = new Date().toISOString();
    }
    return data;
  }, {});

  broadcast('schedule_published', { weekKey });
  res.json({ success: true });
});

// Public - employee schedule view
app.get('/api/my-schedule/:token', (req, res) => {
  const emp = auth.validateEmployeeToken(req.params.token);
  if (!emp) return res.status(404).json({ error: 'קישור לא תקין' });

  const schedules = storage.read('schedules', {});
  const employees = storage.read('employees', []);
  const empMap = {};
  employees.forEach(e => { empMap[e.id] = e; });

  // Get published schedules (last 4 weeks)
  const published = Object.entries(schedules)
    .filter(([k, v]) => v.status === 'published')
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 4);

  const mySchedule = published.map(([weekKey, schedule]) => {
    const myShifts = [];
    for (const [dateStr, shifts] of Object.entries(schedule.days || {})) {
      if (!shifts) continue;
      for (const [shiftId, empIds] of Object.entries(shifts)) {
        if (empIds.includes(emp.id)) {
          myShifts.push({ date: dateStr, shiftId });
        }
      }
    }
    return { weekKey, shifts: myShifts };
  });

  // Also include full current week schedule so employee sees who else works
  const currentWeek = published[0];
  let fullSchedule = null;
  if (currentWeek) {
    fullSchedule = { weekKey: currentWeek[0], days: {} };
    for (const [dateStr, shifts] of Object.entries(currentWeek[1].days || {})) {
      if (!shifts) { fullSchedule.days[dateStr] = null; continue; }
      fullSchedule.days[dateStr] = {};
      for (const [shiftId, empIds] of Object.entries(shifts)) {
        fullSchedule.days[dateStr][shiftId] = empIds.map(id => ({
          name: empMap[id]?.name || '?', role: empMap[id]?.role || 'general'
        }));
      }
    }
  }

  res.json({
    employee: { name: emp.name, role: emp.role },
    mySchedule,
    fullSchedule
  });
});

// ==================== SWAP REQUESTS ====================
app.post('/api/swap-request', (req, res) => {
  const { token, weekKey, fromDate, fromShift, toDate, toShift, targetEmployeeId, notes } = req.body;
  const emp = auth.validateEmployeeToken(token);
  if (!emp) return res.status(404).json({ error: 'קישור לא תקין' });

  const swap = {
    id: uuidv4(),
    requesterId: emp.id,
    requesterName: emp.name,
    targetEmployeeId,
    weekKey,
    fromDate, fromShift,
    toDate, toShift,
    notes: notes || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  storage.update('swap-requests', list => [...list, swap], []);
  broadcast('swap_requested', swap);
  res.status(201).json(swap);
});

app.get('/api/swap-requests', auth.requireAdmin, (req, res) => {
  const swaps = storage.read('swap-requests', []);
  const employees = storage.read('employees', []);
  const empMap = {};
  employees.forEach(e => { empMap[e.id] = e; });

  const enriched = swaps.map(s => ({
    ...s,
    requesterName: empMap[s.requesterId]?.name || '?',
    targetName: empMap[s.targetEmployeeId]?.name || '?'
  }));

  res.json(enriched);
});

app.put('/api/swap-requests/:id', auth.requireAdmin, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  let swap = null;
  storage.update('swap-requests', list => {
    const s = list.find(r => r.id === id);
    if (s) {
      s.status = status;
      s.resolvedAt = new Date().toISOString();
      swap = s;

      // If approved, swap in the schedule
      if (status === 'approved') {
        const schedules = storage.read('schedules', {});
        const sched = schedules[s.weekKey];
        if (sched) {
          const fromDay = sched.days[s.fromDate];
          const toDay = sched.days[s.toDate];
          if (fromDay?.[s.fromShift] && toDay?.[s.toShift]) {
            const fromIdx = fromDay[s.fromShift].indexOf(s.requesterId);
            const toIdx = toDay[s.toShift].indexOf(s.targetEmployeeId);
            if (fromIdx !== -1 && toIdx !== -1) {
              fromDay[s.fromShift][fromIdx] = s.targetEmployeeId;
              toDay[s.toShift][toIdx] = s.requesterId;
              storage.write('schedules', schedules);
            }
          }
        }
      }
    }
    return list;
  }, []);

  if (!swap) return res.status(404).json({ error: 'בקשה לא נמצאה' });
  broadcast('swap_resolved', swap);
  res.json(swap);
});

// ==================== WHATSAPP ====================
app.get('/api/whatsapp/links/:weekKey', auth.requireAdmin, (req, res) => {
  res.json(whatsapp.getAvailabilityLinks(req.params.weekKey, req));
});

app.get('/api/whatsapp/reminders/:weekKey', auth.requireAdmin, (req, res) => {
  res.json(whatsapp.getReminderLinks(req.params.weekKey, req));
});

app.get('/api/whatsapp/schedule-links/:weekKey', auth.requireAdmin, (req, res) => {
  res.json(whatsapp.getSchedulePublishedLinks(req.params.weekKey, req));
});

// ==================== DASHBOARD ====================
app.get('/api/dashboard/:weekKey', auth.requireAdmin, (req, res) => {
  const { weekKey } = req.params;
  const availability = storage.read('availability', {});
  const schedules = storage.read('schedules', {});
  const employees = storage.read('employees', []).filter(e => e.active);
  const week = availability[weekKey];
  const schedule = schedules[weekKey];

  const submitted = week ? Object.keys(week.submissions || {}) : [];
  const notSubmitted = employees.filter(e => !submitted.includes(e.id));

  const shiftsConfig = storage.read('shifts-config', {});
  const dates = getWeekDates(weekKey);
  const coverageGaps = [];

  if (schedule) {
    for (const dateStr of dates) {
      const dayShifts = getShiftsForDate(dateStr, shiftsConfig);
      if (!dayShifts) continue;
      for (const shift of dayShifts) {
        const assigned = schedule.days?.[dateStr]?.[shift.id]?.length || 0;
        if (assigned < shift.requiredEmployees) {
          coverageGaps.push({
            date: dateStr,
            shift: shift.name,
            assigned,
            required: shift.requiredEmployees,
            missing: shift.requiredEmployees - assigned
          });
        }
      }
    }
  }

  res.json({
    weekKey,
    totalEmployees: employees.length,
    submittedCount: submitted.length,
    notSubmitted: notSubmitted.map(e => ({ id: e.id, name: e.name })),
    hasSchedule: !!schedule,
    scheduleStatus: schedule?.status || 'none',
    warnings: schedule?.warnings || [],
    coverageGaps
  });
});

// ==================== HOLIDAYS ====================
app.get('/api/holidays', (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  res.json(holidays.getHolidays(year));
});

// ==================== STATS ====================
app.get('/api/stats/employees', auth.requireAdmin, (req, res) => {
  const weeksBack = parseInt(req.query.weeks) || 8;
  res.json(stats.getAllEmployeeStats(weeksBack));
});

app.get('/api/stats/fairness', auth.requireAdmin, (req, res) => {
  res.json(stats.getFairnessScores());
});

// ==================== SETTINGS ====================
app.get('/api/settings', auth.requireAdmin, (req, res) => {
  const settings = storage.read('settings');
  res.json({ ...settings, adminPasswordHash: undefined });
});

app.put('/api/settings', auth.requireAdmin, (req, res) => {
  const current = storage.read('settings');
  const updates = { ...req.body };

  if (updates.newPassword) {
    const bcrypt = require('bcryptjs');
    updates.adminPasswordHash = bcrypt.hashSync(updates.newPassword, 10);
    delete updates.newPassword;
  }
  delete updates.adminPasswordHash;

  storage.write('settings', { ...current, ...updates });
  res.json({ success: true });
});

// ==================== PRINT ====================
app.get('/api/schedules/:weekKey/print', (req, res) => {
  const { weekKey } = req.params;
  const schedules = storage.read('schedules', {});
  const schedule = schedules[weekKey];
  if (!schedule) return res.status(404).send('סידור לא נמצא');

  const employees = storage.read('employees', []);
  const empMap = {};
  employees.forEach(e => { empMap[e.id] = e; });
  const shiftsConfig = storage.read('shifts-config', {});
  const settings = storage.read('settings');
  const dates = getWeekDates(weekKey);

  const roleColors = {
    shift_manager: '#e74c3c', barista: '#3498db', cashier: '#2ecc71',
    kitchen: '#f39c12', general: '#95a5a6'
  };

  let rows = '';
  for (const dateStr of dates) {
    const dayShifts = schedule.days[dateStr];
    if (!dayShifts) continue;
    const dayName = new Date(dateStr).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });

    for (const [shiftId, empIds] of Object.entries(dayShifts)) {
      const names = empIds.map(id => {
        const e = empMap[id];
        const color = roleColors[e?.role] || '#95a5a6';
        return `<span style="color:${color};font-weight:bold">${e?.name || '?'}</span>`;
      }).join(', ');

      const shiftConfig = shiftsConfig.defaultShifts?.find(s => s.id === shiftId);
      rows += `<tr><td>${dayName}</td><td>${shiftConfig?.name || shiftId}</td><td>${shiftConfig?.start || ''}-${shiftConfig?.end || ''}</td><td>${names}</td></tr>`;
    }
  }

  res.send(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8">
<title>סידור עבודה - ${weekKey}</title>
<style>body{font-family:Arial,sans-serif;margin:20px;direction:rtl}
h1{text-align:center;color:#8B1A2B}
h2{text-align:center;color:#666}
table{width:100%;border-collapse:collapse;margin-top:20px}
th{background:#8B1A2B;color:white;padding:10px;text-align:right}
td{border:1px solid #ddd;padding:8px;text-align:right}
tr:nth-child(even){background:#f9f9f9}
@media print{body{margin:0}}</style></head>
<body><h1>${settings?.branchName || 'רולדין'}</h1><h2>סידור עבודה - שבוע ${weekKey}</h2>
<table><thead><tr><th>יום</th><th>משמרת</th><th>שעות</th><th>עובדים</th></tr></thead>
<tbody>${rows}</tbody></table>
<p style="text-align:center;color:#999;margin-top:30px">נוצר: ${new Date().toLocaleDateString('he-IL')}</p>
</body></html>`);
});

// --- Start server ---
server.listen(config.PORT, () => {
  console.log(`🟢 Roladin Shifts running on port ${config.PORT}`);
  console.log(`📋 Admin: http://localhost:${config.PORT}/admin/`);
});
