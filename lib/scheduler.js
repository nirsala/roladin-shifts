const storage = require('./storage');
const config = require('../config');
const { getFairnessScores } = require('./stats');

function getShiftsForDate(dateStr, shiftsConfig) {
  if (shiftsConfig.dateOverrides?.[dateStr] === null) return null; // closed
  if (shiftsConfig.dateOverrides?.[dateStr]) return shiftsConfig.dateOverrides[dateStr].shifts;

  const dayOfWeek = new Date(dateStr).getDay().toString();
  if (shiftsConfig.dayOverrides?.[dayOfWeek] === null) return null; // closed
  if (shiftsConfig.dayOverrides?.[dayOfWeek]) return shiftsConfig.dayOverrides[dayOfWeek].shifts;

  return shiftsConfig.defaultShifts || [];
}

function getWeekDates(weekKey) {
  const [year, weekNum] = weekKey.split('-W').map(Number);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (weekNum - 1) * 7);

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function generateSchedule(weekKey, options = {}) {
  const { excludeEmployees = [] } = options;
  const shiftsConfig = storage.read('shifts-config', { defaultShifts: [] });
  const employees = storage.read('employees', [])
    .filter(e => e.active && !excludeEmployees.includes(e.id));
  const availability = storage.read('availability', {});
  const weekData = availability[weekKey] || { submissions: {} };

  const dates = getWeekDates(weekKey);
  const fairness = getFairnessScores(4);
  const fairnessMap = {};
  for (const f of fairness) {
    fairnessMap[f.employeeId] = f.priority;
  }

  const schedule = { days: {} };
  const warnings = [];
  const assignmentCount = {};
  const consecutiveDays = {};

  employees.forEach(e => {
    assignmentCount[e.id] = 0;
    consecutiveDays[e.id] = 0;
  });

  // Build all slots: { date, shiftId, requiredCount, roleReqs }
  const slots = [];
  for (const dateStr of dates) {
    const dayShifts = getShiftsForDate(dateStr, shiftsConfig);
    if (!dayShifts) {
      schedule.days[dateStr] = null; // closed
      continue;
    }
    schedule.days[dateStr] = {};
    for (const shift of dayShifts) {
      schedule.days[dateStr][shift.id] = [];
      slots.push({
        date: dateStr,
        shiftId: shift.id,
        shiftName: shift.name,
        required: shift.requiredEmployees || 1,
        roleReqs: shiftsConfig.roleRequirements?.[shift.id] || {}
      });
    }
  }

  // Build availability matrix
  function isAvailable(empId, dateStr, shiftId) {
    const emp = employees.find(e => e.id === empId);
    const submission = weekData.submissions?.[empId];
    if (!submission) return false;

    // Blackout days - absolute block
    if (submission.blackoutDays?.includes(dateStr)) return false;

    // Check if submitted for this shift
    const dayAvail = submission.days?.[dateStr];
    if (!dayAvail || !dayAvail.includes(shiftId)) return false;

    // Shift preference check
    const pref = submission.shiftPreference || emp?.shiftPreference || 'any';
    if (pref === 'morning' && shiftId.includes('evening')) return false;
    if (pref === 'evening' && shiftId.includes('morning')) return false;

    return true;
  }

  // Warn about employees who didn't submit
  const notSubmitted = employees.filter(e => !weekData.submissions?.[e.id]);
  if (notSubmitted.length > 0) {
    warnings.push(`לא הגישו זמינות: ${notSubmitted.map(e => e.name).join(', ')}`);
  }

  // Count available candidates per slot
  for (const slot of slots) {
    slot.candidates = employees.filter(e => isAvailable(e.id, slot.date, slot.shiftId));
    slot.candidateCount = slot.candidates.length;
  }

  // Sort: most-constrained-first (fewer candidates = handle first)
  slots.sort((a, b) => a.candidateCount - b.candidateCount);

  // Assign shifts
  for (const slot of slots) {
    if (!schedule.days[slot.date]) continue;

    const assigned = [];
    const available = slot.candidates
      .filter(e => {
        // Check max shifts per week
        if (assignmentCount[e.id] >= (e.maxShiftsPerWeek || config.MAX_SHIFTS_PER_WEEK)) return false;
        // Check not already assigned to another shift on same day
        const dayShifts = schedule.days[slot.date];
        for (const [sid, empIds] of Object.entries(dayShifts)) {
          if (empIds.includes(e.id)) return false;
        }
        return true;
      })
      .sort((a, b) => (fairnessMap[b.id] || 0) - (fairnessMap[a.id] || 0));

    // First fill required roles
    for (const [role, count] of Object.entries(slot.roleReqs)) {
      let filled = 0;
      for (const emp of available) {
        if (filled >= count) break;
        if (emp.role === role && !assigned.includes(emp.id)) {
          assigned.push(emp.id);
          filled++;
        }
      }
      if (filled < count) {
        warnings.push(`חוסר ${role} במשמרת ${slot.shiftName} ביום ${slot.date} (${filled}/${count})`);
      }
    }

    // Fill remaining spots
    for (const emp of available) {
      if (assigned.length >= slot.required) break;
      if (!assigned.includes(emp.id)) {
        assigned.push(emp.id);
      }
    }

    if (assigned.length < slot.required) {
      warnings.push(`חוסר עובדים במשמרת ${slot.shiftName} ביום ${slot.date} (${assigned.length}/${slot.required})`);
    }

    schedule.days[slot.date][slot.shiftId] = assigned;
    assigned.forEach(id => assignmentCount[id]++);
  }

  // Check consecutive days
  for (const emp of employees) {
    let consecutive = 0;
    let maxConsec = 0;
    for (const dateStr of dates) {
      const dayShifts = schedule.days[dateStr];
      if (!dayShifts) { consecutive = 0; continue; }
      let worksToday = false;
      for (const empIds of Object.values(dayShifts)) {
        if (empIds.includes(emp.id)) { worksToday = true; break; }
      }
      if (worksToday) {
        consecutive++;
        maxConsec = Math.max(maxConsec, consecutive);
      } else {
        consecutive = 0;
      }
    }
    if (maxConsec > config.MAX_CONSECUTIVE_DAYS) {
      warnings.push(`${emp.name} משובצת ${maxConsec} ימים רצופים (מקסימום: ${config.MAX_CONSECUTIVE_DAYS})`);
    }
  }

  return {
    status: 'draft',
    generatedAt: new Date().toISOString(),
    days: schedule.days,
    warnings,
    manualEdits: []
  };
}

module.exports = { generateSchedule, getShiftsForDate, getWeekDates };
