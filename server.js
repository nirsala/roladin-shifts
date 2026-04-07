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
  dayOverrides: { "6": null },
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

  // Auto-notify all employees to submit availability
  const allEmps2 = storage.read('employees', []).filter(e => e.active);
  const baseUrl2 = whatsapp.getBaseUrl(req);
  storage.update('notifications', list => {
    for (const emp of allEmps2) {
      const link = `${baseUrl2}/employee/availability.html?token=${emp.token}&week=${weekKey}`;
      list.push({
        id: uuidv4(), employeeId: emp.id, employeeName: emp.name,
        message: `נפתח שבוע ${weekKey} להגשת זמינות. הגישי כאן:`,
        link, type: 'availability', read: false, createdAt: new Date().toISOString()
      });
    }
    return list;
  }, []);

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
  const { excludeEmployees } = req.body || {};
  const result = generateSchedule(weekKey, { excludeEmployees: excludeEmployees || [] });
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
        role: empMap[id]?.role || 'general',
        roles: empMap[id]?.roles || [empMap[id]?.role || 'general']
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

  // Auto-notify all employees
  const allEmps = storage.read('employees', []).filter(e => e.active);
  storage.update('notifications', list => {
    for (const emp of allEmps) {
      list.push({
        id: uuidv4(), employeeId: emp.id, employeeName: emp.name,
        message: `סידור העבודה לשבוע ${weekKey} פורסם! היכנס/י לקישור שלך לצפייה.`,
        type: 'schedule', read: false, createdAt: new Date().toISOString()
      });
    }
    return list;
  }, []);

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

  // Build shift config lookup for hours
  const shiftsConfig = storage.read('shifts-config', {});
  const allShiftDefs = [...(shiftsConfig.defaultShifts || [])];
  // Also collect from overrides
  for (const ov of Object.values(shiftsConfig.dayOverrides || {})) {
    if (ov?.shifts) allShiftDefs.push(...ov.shifts);
  }
  for (const ov of Object.values(shiftsConfig.dateOverrides || {})) {
    if (ov?.shifts) allShiftDefs.push(...ov.shifts);
  }
  const shiftDefMap = {};
  allShiftDefs.forEach(s => { shiftDefMap[s.id] = s; });

  const mySchedule = published.map(([weekKey, schedule]) => {
    const myShifts = [];
    for (const [dateStr, shifts] of Object.entries(schedule.days || {})) {
      if (!shifts) continue;
      for (const [shiftId, empIds] of Object.entries(shifts)) {
        if (empIds.includes(emp.id)) {
          const def = shiftDefMap[shiftId] || {};
          myShifts.push({ date: dateStr, shiftId, shiftName: def.name || shiftId, start: def.start || '', end: def.end || '' });
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
        const def = shiftDefMap[shiftId] || {};
        fullSchedule.days[dateStr][shiftId] = {
          shiftName: def.name || shiftId, start: def.start || '', end: def.end || '',
          employees: empIds.map(id => ({
            name: empMap[id]?.name || '?', role: empMap[id]?.role || 'general', roles: empMap[id]?.roles || [empMap[id]?.role || 'general']
          }))
        };
      }
    }
  }

  // Get pending swap requests for this employee
  const swapRequests = storage.read('swap-requests', []);
  const mySwaps = swapRequests.filter(s => s.requesterId === emp.id && s.status === 'pending');
  const incomingSwaps = swapRequests.filter(s =>
    s.targetEmployees?.includes(emp.id) && s.status === 'pending' && !s.responses?.find(r => r.employeeId === emp.id)
  );

  res.json({
    employee: { id: emp.id, name: emp.name, role: emp.role, roles: emp.roles || [emp.role || 'general'], token: emp.token },
    mySchedule,
    fullSchedule,
    mySwaps,
    incomingSwaps
  });
});

// Get employees with same roles who work on a specific shift (for swap targeting)
app.get('/api/swap-candidates/:token', (req, res) => {
  const emp = auth.validateEmployeeToken(req.params.token);
  if (!emp) return res.status(404).json({ error: 'קישור לא תקין' });

  const { weekKey, date, shiftId } = req.query;
  const employees = storage.read('employees', []).filter(e => e.active && e.id !== emp.id);
  const empRoles = emp.roles || [emp.role || 'general'];

  // Find employees with at least one matching role
  const candidates = employees.filter(e => {
    const otherRoles = e.roles || [e.role || 'general'];
    return otherRoles.some(r => empRoles.includes(r)) || empRoles.includes('general') || otherRoles.includes('general');
  });

  res.json(candidates.map(e => ({
    id: e.id, name: e.name, phone: e.phone, token: e.token,
    roles: e.roles || [e.role || 'general']
  })));
});

// ==================== SWAP REQUESTS ====================
// Create swap request + get WA links for targets
app.post('/api/swap-request', (req, res) => {
  const { token, weekKey, fromDate, fromShift, targetEmployeeIds, notes } = req.body;
  const emp = auth.validateEmployeeToken(token);
  if (!emp) return res.status(404).json({ error: 'קישור לא תקין' });

  const swap = {
    id: uuidv4(),
    requesterId: emp.id,
    requesterName: emp.name,
    requesterPhone: emp.phone,
    targetEmployees: targetEmployeeIds || [],
    weekKey,
    fromDate, fromShift,
    notes: notes || '',
    status: 'pending',
    responses: [],
    createdAt: new Date().toISOString()
  };

  storage.update('swap-requests', list => [...list, swap], []);
  broadcast('swap_requested', swap);

  // Generate WA links for the requesting employee to send
  const employees = storage.read('employees', []);
  const baseUrl = whatsapp.getBaseUrl(req);
  const waLinks = (targetEmployeeIds || []).map(targetId => {
    const target = employees.find(e => e.id === targetId);
    if (!target) return null;
    const respondUrl = `${baseUrl}/employee/swap-respond.html?swapId=${swap.id}&token=${target.token}`;
    const message = `שלום ${target.name} 👋\n${emp.name} מבקש/ת להחליף משמרת:\n📅 ${fromDate} - ${fromShift}\n${notes ? '💬 ' + notes : ''}\n\nלתגובה:\n${respondUrl}`;
    return {
      id: target.id,
      name: target.name,
      phone: target.phone,
      waLink: whatsapp.buildWhatsAppLink(target.phone, message)
    };
  }).filter(Boolean);

  res.status(201).json({ swap, waLinks });
});

// Employee responds to swap: accept or decline
app.post('/api/swap-request/:id/respond', (req, res) => {
  const { token, action, offerShiftDate, offerShiftId } = req.body;
  const emp = auth.validateEmployeeToken(token);
  if (!emp) return res.status(404).json({ error: 'קישור לא תקין' });

  let swap = null;
  storage.update('swap-requests', list => {
    const s = list.find(x => x.id === req.params.id);
    if (!s) return list;
    if (!s.responses) s.responses = [];
    // Prevent duplicate responses
    if (s.responses.find(r => r.employeeId === emp.id)) return list;
    s.responses.push({
      employeeId: emp.id,
      employeeName: emp.name,
      employeePhone: emp.phone,
      action, // 'accept' or 'decline'
      offerShiftDate: offerShiftDate || null,
      offerShiftId: offerShiftId || null,
      respondedAt: new Date().toISOString()
    });
    swap = { ...s };
    return list;
  }, []);

  if (!swap) return res.status(404).json({ error: 'בקשה לא נמצאה' });

  broadcast('swap_response', { swapId: swap.id, employeeName: emp.name, action });

  // If accepted → notify requester via WA link + notify manager
  const baseUrl = whatsapp.getBaseUrl(req);
  const result = { success: true };

  if (action === 'accept') {
    // WA link for requester to know someone accepted
    const requester = storage.read('employees', []).find(e => e.id === swap.requesterId);
    if (requester) {
      const msg = `שלום ${requester.name} 👋\n${emp.name} הסכימ/ה להחליף איתך משמרת!\n📅 ${swap.fromDate} - ${swap.fromShift}\nממתין לאישור מנהל.`;
      result.requesterWaLink = whatsapp.buildWhatsAppLink(requester.phone, msg);
    }
    // WA link for manager
    const settings = storage.read('settings');
    result.managerMessage = `בקשת החלפה חדשה ממתינה לאישור:\n${swap.requesterName} ↔ ${emp.name}\n📅 ${swap.fromDate} - ${swap.fromShift}\n\nכנס למערכת לאשר:\n${baseUrl}/admin/messages.html`;
    result.message = 'הבקשה נשלחה! ממתין לאישור מנהל.';
  } else {
    // Notify requester of decline
    const requester = storage.read('employees', []).find(e => e.id === swap.requesterId);
    if (requester) {
      const msg = `שלום ${requester.name},\n${emp.name} לא יכול/ה להחליף משמרת ב-${swap.fromDate}. נסה/י עובד/ת אחר/ת.`;
      result.requesterWaLink = whatsapp.buildWhatsAppLink(requester.phone, msg);
    }
    result.message = 'התגובה נשלחה.';
  }

  res.json(result);
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

// ==================== EMPLOYEE MESSAGES ====================
app.post('/api/messages', (req, res) => {
  const { token, message } = req.body;
  const emp = auth.validateEmployeeToken(token);
  if (!emp) return res.status(404).json({ error: 'קישור לא תקין' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'הודעה ריקה' });

  const msg = {
    id: uuidv4(),
    employeeId: emp.id,
    employeeName: emp.name,
    message: message.trim(),
    read: false,
    createdAt: new Date().toISOString()
  };

  storage.update('messages', list => [...list, msg], []);
  broadcast('new_message', msg);
  res.status(201).json(msg);
});

app.get('/api/messages', auth.requireAdmin, (req, res) => {
  const messages = storage.read('messages', []);
  res.json(messages.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.put('/api/messages/:id/read', auth.requireAdmin, (req, res) => {
  storage.update('messages', list => {
    const m = list.find(x => x.id === req.params.id);
    if (m) m.read = true;
    return list;
  }, []);
  res.json({ success: true });
});

app.delete('/api/messages/:id', auth.requireAdmin, (req, res) => {
  storage.update('messages', list => list.filter(x => x.id !== req.params.id), []);
  res.json({ success: true });
});

// ==================== SWAP REQUESTS (FULL FLOW) ====================
// Employee offers a shift for swap/take - generates WA links for other employees
app.get('/api/swap-request/:id/wa-links', auth.requireAdmin, (req, res) => {
  const swaps = storage.read('swap-requests', []);
  const swap = swaps.find(s => s.id === req.params.id);
  if (!swap) return res.status(404).json({ error: 'בקשה לא נמצאה' });

  const employees = storage.read('employees', []).filter(e => e.active && e.id !== swap.requesterId);
  const baseUrl = whatsapp.getBaseUrl(req);

  const links = employees.map(e => {
    const acceptUrl = `${baseUrl}/employee/swap-respond.html?swapId=${swap.id}&token=${e.token}&action=accept`;
    const message = `שלום ${e.name},\n${swap.requesterName} מחפשת מישהי להחליף/לקחת משמרת:\n📅 ${swap.fromDate} - ${swap.fromShift}\n${swap.notes ? '💬 ' + swap.notes : ''}\n\nאם את/ה מעוניין/ת:\n${acceptUrl}`;
    return {
      employeeId: e.id,
      name: e.name,
      phone: e.phone,
      waLink: whatsapp.buildWhatsAppLink(e.phone, message)
    };
  });

  res.json(links);
});

// Employee responds to swap offer
app.post('/api/swap-request/:id/respond', (req, res) => {
  const { token, action, offerShiftDate, offerShiftId } = req.body;
  const emp = auth.validateEmployeeToken(token);
  if (!emp) return res.status(404).json({ error: 'קישור לא תקין' });

  const result = storage.update('swap-requests', list => {
    const swap = list.find(s => s.id === req.params.id);
    if (!swap) return list;
    if (!swap.responses) swap.responses = [];
    swap.responses.push({
      employeeId: emp.id,
      employeeName: emp.name,
      action, // 'take' (take the shift) or 'swap' (swap with own shift)
      offerShiftDate: offerShiftDate || null,
      offerShiftId: offerShiftId || null,
      respondedAt: new Date().toISOString()
    });
    return list;
  }, []);

  broadcast('swap_response', { swapId: req.params.id, employeeName: emp.name, action });
  res.json({ success: true, message: 'התגובה נשמרה! המנהל יאשר בקרוב.' });
});

// Manager approves - either a specific response OR manual replacement
app.put('/api/swap-requests/:id/approve', auth.requireAdmin, (req, res) => {
  const { responseIndex, managerNote, manualReplacementId, manualReplacementName } = req.body;
  let swap = null;
  let acceptedEmployee = null;

  storage.update('swap-requests', list => {
    const s = list.find(r => r.id === req.params.id);
    if (!s) return list;

    // Manual replacement (manager picks who replaces, no response needed)
    if (manualReplacementId) {
      s.status = 'approved';
      s.managerNote = managerNote || '';
      s.resolvedAt = new Date().toISOString();
      acceptedEmployee = { employeeId: manualReplacementId, employeeName: manualReplacementName || '?', action: 'take' };
      swap = s;
    } else if (s.responses?.[responseIndex]) {
      // Approve a specific employee response
      const response = s.responses[responseIndex];
      s.status = 'approved';
      s.approvedResponseIndex = responseIndex;
      s.managerNote = managerNote || '';
      s.resolvedAt = new Date().toISOString();
      acceptedEmployee = response;
      swap = s;
    } else {
      return list;
    }

    // Update the schedule
    const schedules = storage.read('schedules', {});
    const sched = schedules[s.weekKey];
    if (sched && acceptedEmployee) {
      const day = sched.days[s.fromDate];
      if (day?.[s.fromShift]) {
        // Remove requester, add replacement
        const idx = day[s.fromShift].indexOf(s.requesterId);
        if (idx !== -1) day[s.fromShift][idx] = acceptedEmployee.employeeId;

        // If it's a swap (not just take), also swap the other shift
        if (acceptedEmployee.action === 'swap' && acceptedEmployee.offerShiftDate && acceptedEmployee.offerShiftId) {
          const otherDay = sched.days[acceptedEmployee.offerShiftDate];
          if (otherDay?.[acceptedEmployee.offerShiftId]) {
            const idx2 = otherDay[acceptedEmployee.offerShiftId].indexOf(acceptedEmployee.employeeId);
            if (idx2 !== -1) otherDay[acceptedEmployee.offerShiftId][idx2] = s.requesterId;
          }
        }
      }
      storage.write('schedules', schedules);
    }
    return list;
  }, []);

  if (!swap) return res.status(404).json({ error: 'בקשה לא נמצאה' });

  // Notify both employees
  const noteText = swap.managerNote ? `\nהודעת מנהל: ${swap.managerNote}` : '';
  storage.update('notifications', list => {
    list.push({
      id: uuidv4(), employeeId: swap.requesterId, employeeName: swap.requesterName,
      message: `בקשת ההחלפה שלך אושרה ✅ ${acceptedEmployee.employeeName} מחליפ/ה את המשמרת.${noteText}`,
      type: 'swap', read: false, createdAt: new Date().toISOString()
    });
    list.push({
      id: uuidv4(), employeeId: acceptedEmployee.employeeId, employeeName: acceptedEmployee.employeeName,
      message: `ההחלפה עם ${swap.requesterName} אושרה ✅ על ידי המנהל.${noteText}`,
      type: 'swap', read: false, createdAt: new Date().toISOString()
    });
    return list;
  }, []);

  broadcast('swap_approved', { swap, acceptedEmployee });
  res.json({ success: true, swap });
});

// Manager rejects swap
app.put('/api/swap-requests/:id/reject', auth.requireAdmin, (req, res) => {
  const { managerNote } = req.body || {};

  let swap = null;
  storage.update('swap-requests', list => {
    const s = list.find(r => r.id === req.params.id);
    if (s) {
      s.status = 'rejected'; s.managerNote = managerNote || ''; s.resolvedAt = new Date().toISOString();
      swap = s;
    }
    return list;
  }, []);

  // Notify requester
  if (swap) {
    const noteText = swap.managerNote ? `\nהודעת מנהל: ${swap.managerNote}` : '';
    storage.update('notifications', list => {
      list.push({
        id: uuidv4(), employeeId: swap.requesterId, employeeName: swap.requesterName,
        message: `בקשת ההחלפה שלך נדחתה ❌${noteText}`,
        type: 'swap', read: false, createdAt: new Date().toISOString()
      });
      return list;
    }, []);
  }

  broadcast('swap_rejected', { id: req.params.id });
  res.json({ success: true });
});

// Get WA notification links after approval/rejection
app.get('/api/swap-requests/:id/notify-links', auth.requireAdmin, (req, res) => {
  const swaps = storage.read('swap-requests', []);
  const swap = swaps.find(s => s.id === req.params.id);
  if (!swap) return res.status(404).json({ error: 'בקשה לא נמצאה' });

  const employees = storage.read('employees', []);
  const empMap = {};
  employees.forEach(e => { empMap[e.id] = e; });

  const links = [];
  const requester = empMap[swap.requesterId];
  const statusText = swap.status === 'approved' ? 'אושרה ✅' : 'נדחתה ❌';
  const approvedResp = swap.status === 'approved' && swap.responses?.[swap.approvedResponseIndex];

  const noteText = swap.managerNote ? `\n💬 הודעת מנהל: ${swap.managerNote}` : '';

  if (requester) {
    let msg = `שלום ${requester.name},\nבקשת ההחלפה שלך ${statusText}`;
    if (approvedResp) msg += `\n${approvedResp.employeeName} ${approvedResp.action === 'take' ? 'לוקח/ת' : 'מחליפ/ה'} את המשמרת.`;
    msg += noteText;
    links.push({ name: requester.name, phone: requester.phone, waLink: whatsapp.buildWhatsAppLink(requester.phone, msg), role: 'מבקש/ת' });
  }
  if (approvedResp) {
    const respEmp = empMap[approvedResp.employeeId];
    if (respEmp) {
      let msg = `שלום ${respEmp.name},\nההחלפה עם ${swap.requesterName} אושרה ✅ על ידי המנהל.`;
      msg += noteText;
      links.push({ name: respEmp.name, phone: respEmp.phone, waLink: whatsapp.buildWhatsAppLink(respEmp.phone, msg), role: 'מחליפ/ה' });
    }
  }
  res.json(links);
});

// ==================== NOTIFICATIONS (in-app for employees) ====================
// Get notifications for an employee
app.get('/api/notifications/:token', (req, res) => {
  const emp = auth.validateEmployeeToken(req.params.token);
  if (!emp) return res.status(404).json({ error: 'קישור לא תקין' });
  const notifications = storage.read('notifications', []);
  const mine = notifications
    .filter(n => n.employeeId === emp.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(mine);
});

// Mark notification as read
app.put('/api/notifications/:token/:id/read', (req, res) => {
  const emp = auth.validateEmployeeToken(req.params.token);
  if (!emp) return res.status(404).json({ error: 'קישור לא תקין' });
  storage.update('notifications', list => {
    const n = list.find(x => x.id === req.params.id && x.employeeId === emp.id);
    if (n) n.read = true;
    return list;
  }, []);
  res.json({ success: true });
});

// Manager sends notification to employees
app.post('/api/notifications/send', auth.requireAdmin, (req, res) => {
  const { employeeIds, message, type } = req.body;
  if (!employeeIds?.length || !message) return res.status(400).json({ error: 'חובה לציין עובדים והודעה' });

  const employees = storage.read('employees', []);
  const created = [];
  storage.update('notifications', list => {
    for (const empId of employeeIds) {
      const emp = employees.find(e => e.id === empId);
      if (!emp) continue;
      const notif = {
        id: uuidv4(),
        employeeId: empId,
        employeeName: emp.name,
        message,
        type: type || 'general', // general, schedule, swap, reminder
        read: false,
        createdAt: new Date().toISOString()
      };
      list.push(notif);
      created.push(notif);
    }
    return list;
  }, []);

  broadcast('notifications_sent', { count: created.length });
  res.json({ success: true, sent: created.length });
});

// Manager sends notification to ALL active employees
app.post('/api/notifications/broadcast', auth.requireAdmin, (req, res) => {
  const { message, type } = req.body;
  if (!message) return res.status(400).json({ error: 'חובה לציין הודעה' });

  const employees = storage.read('employees', []).filter(e => e.active);
  const created = [];
  storage.update('notifications', list => {
    for (const emp of employees) {
      const notif = {
        id: uuidv4(),
        employeeId: emp.id,
        employeeName: emp.name,
        message,
        type: type || 'general',
        read: false,
        createdAt: new Date().toISOString()
      };
      list.push(notif);
      created.push(notif);
    }
    return list;
  }, []);

  broadcast('notifications_sent', { count: created.length });
  res.json({ success: true, sent: created.length });
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

// ==================== SCHEDULE HISTORY ====================
app.get('/api/schedules', auth.requireAdmin, (req, res) => {
  const schedules = storage.read('schedules', {});
  const list = Object.entries(schedules)
    .map(([weekKey, s]) => ({
      weekKey,
      status: s.status,
      generatedAt: s.generatedAt,
      publishedAt: s.publishedAt || null
    }))
    .sort((a, b) => b.weekKey.localeCompare(a.weekKey));
  res.json(list);
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

// ==================== EXPORT / IMPORT ====================
app.get('/api/backup/export', auth.requireAdmin, (req, res) => {
  const backup = {
    exportedAt: new Date().toISOString(),
    employees: storage.read('employees', []),
    shiftsConfig: storage.read('shifts-config', {}),
    settings: (() => { const s = storage.read('settings'); return s ? { ...s, adminPasswordHash: undefined } : {}; })(),
    availability: storage.read('availability', {}),
    schedules: storage.read('schedules', {}),
    swapRequests: storage.read('swap-requests', [])
  };
  res.setHeader('Content-Disposition', `attachment; filename=roladin-backup-${new Date().toISOString().slice(0,10)}.json`);
  res.json(backup);
});

app.post('/api/backup/import', auth.requireAdmin, (req, res) => {
  const backup = req.body;
  if (!backup || !backup.employees) {
    return res.status(400).json({ error: 'קובץ גיבוי לא תקין' });
  }
  let count = 0;
  if (backup.employees) { storage.write('employees', backup.employees); count++; }
  if (backup.shiftsConfig) { storage.write('shifts-config', backup.shiftsConfig); count++; }
  if (backup.availability) { storage.write('availability', backup.availability); count++; }
  if (backup.schedules) { storage.write('schedules', backup.schedules); count++; }
  if (backup.swapRequests) { storage.write('swap-requests', backup.swapRequests); count++; }
  broadcast('data_imported', { count });
  res.json({ success: true, filesRestored: count });
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
    shift_manager: '#e74c3c', manager: '#8e44ad', barista: '#3498db',
    baker: '#e67e22', cashier: '#2ecc71', kitchen: '#f39c12', general: '#95a5a6'
  };

  let rows = '';
  for (const dateStr of dates) {
    const dayShifts = schedule.days[dateStr];
    if (!dayShifts) continue;
    const dayName = new Date(dateStr).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });

    for (const [shiftId, empIds] of Object.entries(dayShifts)) {
      const names = empIds.map(id => {
        const e = empMap[id];
        const primaryRole = (e?.roles || [e?.role])[0] || 'general';
        const color = roleColors[primaryRole] || '#95a5a6';
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
const githubSync = require('./lib/github-sync');
server.listen(config.PORT, () => {
  console.log(`🟢 Roladin Shifts running on port ${config.PORT}`);
  console.log(`📋 Admin: http://localhost:${config.PORT}/admin/`);
  console.log(`💾 GitHub sync: ${githubSync.isEnabled() ? '✓ enabled' : '✗ disabled (set GITHUB_TOKEN)'}`);
});
