const storage = require('./storage');
const config = require('../config');
const { getFairnessScores } = require('./stats');

function getShiftsForDate(dateStr, shiftsConfig) {
  if (shiftsConfig.dateOverrides?.[dateStr] === null) return null;
  if (shiftsConfig.dateOverrides?.[dateStr]) return shiftsConfig.dateOverrides[dateStr].shifts;

  const dayOfWeek = new Date(dateStr).getDay().toString();
  if (shiftsConfig.dayOverrides?.[dayOfWeek] === null) return null;
  if (shiftsConfig.dayOverrides?.[dayOfWeek]) return shiftsConfig.dayOverrides[dayOfWeek].shifts;

  return shiftsConfig.defaultShifts || [];
}

function getWeekDates(weekKey) {
  // Israeli work week: Sunday to Friday (6 days)
  const [year, weekNum] = weekKey.split('-W').map(Number);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (weekNum - 1) * 7);

  // Go back 1 day from Monday to get Sunday
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() - 1);

  const dates = [];
  for (let i = 0; i < 6; i++) { // Sun, Mon, Tue, Wed, Thu, Fri
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
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

  // ===== Per-employee tracking for THIS week =====
  const weekCount = {};       // total shifts this week
  const morningCount = {};    // morning shifts this week
  const eveningCount = {};    // evening shifts this week
  employees.forEach(e => {
    weekCount[e.id] = 0;
    morningCount[e.id] = 0;
    eveningCount[e.id] = 0;
  });

  // Build all slots
  const slots = [];
  for (const dateStr of dates) {
    const dayShifts = getShiftsForDate(dateStr, shiftsConfig);
    if (!dayShifts) {
      schedule.days[dateStr] = null;
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

  // Availability check
  function isAvailable(empId, dateStr, shiftId) {
    const emp = employees.find(e => e.id === empId);
    if (!emp) return false;

    const submission = weekData.submissions?.[empId];

    if (submission) {
      if (submission.blackoutDays?.includes(dateStr)) return false;
      const dayAvail = submission.days?.[dateStr];
      if (!dayAvail || !dayAvail.includes(shiftId)) return false;
      const pref = submission.shiftPreference || emp.shiftPreference || 'any';
      if (pref === 'morning' && shiftId.includes('evening')) return false;
      if (pref === 'evening' && shiftId.includes('morning')) return false;
      return true;
    } else {
      const pref = emp.shiftPreference || 'any';
      if (pref === 'morning' && shiftId.includes('evening')) return false;
      if (pref === 'evening' && shiftId.includes('morning')) return false;
      return true;
    }
  }

  // Track submissions
  const notSubmitted = employees.filter(e => !weekData.submissions?.[e.id]);
  const submittedIds = new Set(employees.filter(e => weekData.submissions?.[e.id]).map(e => e.id));
  if (notSubmitted.length > 0) {
    warnings.push(`לא הגישו זמינות (שובצו לפי העדפות מכרטיס): ${notSubmitted.map(e => e.name).join(', ')}`);
  }

  // Calculate ideal shifts per employee for fair distribution
  const totalSlotsNeeded = slots.reduce((sum, s) => sum + s.required, 0);
  const idealPerEmployee = totalSlotsNeeded / employees.length;

  // Count available candidates per slot
  for (const slot of slots) {
    slot.candidates = employees.filter(e => isAvailable(e.id, slot.date, slot.shiftId));
    slot.candidateCount = slot.candidates.length;
  }

  // Sort: most-constrained-first
  slots.sort((a, b) => a.candidateCount - b.candidateCount);

  // ===== IMPROVED ASSIGNMENT =====
  for (const slot of slots) {
    if (!schedule.days[slot.date]) continue;

    const isMorning = slot.shiftId.includes('morning') || slot.shiftId === 'morning';
    const isEvening = slot.shiftId.includes('evening') || slot.shiftId === 'evening';
    const assigned = [];

    // Get candidates who aren't maxed out and not already on this day
    const available = slot.candidates.filter(e => {
      if (weekCount[e.id] >= (e.maxShiftsPerWeek || config.MAX_SHIFTS_PER_WEEK)) return false;
      const dayShifts = schedule.days[slot.date];
      for (const empIds of Object.values(dayShifts)) {
        if (empIds.includes(e.id)) return false;
      }
      return true;
    });

    // Sort by smart priority
    available.sort((a, b) => {
      // 1. Prefer employees who submitted availability
      const aSubmitted = submittedIds.has(a.id) ? 0 : 1;
      const bSubmitted = submittedIds.has(b.id) ? 0 : 1;
      if (aSubmitted !== bSubmitted) return aSubmitted - bSubmitted;

      // 2. PRIMARY: fewer shifts this week = higher priority (equal distribution)
      if (weekCount[a.id] !== weekCount[b.id]) return weekCount[a.id] - weekCount[b.id];

      // 3. Shift variety: prefer employee who did LESS of this shift type
      //    e.g., if assigning morning, prefer someone with fewer mornings
      if (isMorning) {
        const aRatio = weekCount[a.id] > 0 ? morningCount[a.id] / weekCount[a.id] : 0;
        const bRatio = weekCount[b.id] > 0 ? morningCount[b.id] / weekCount[b.id] : 0;
        if (Math.abs(aRatio - bRatio) > 0.1) return aRatio - bRatio;
      }
      if (isEvening) {
        const aRatio = weekCount[a.id] > 0 ? eveningCount[a.id] / weekCount[a.id] : 0;
        const bRatio = weekCount[b.id] > 0 ? eveningCount[b.id] / weekCount[b.id] : 0;
        if (Math.abs(aRatio - bRatio) > 0.1) return aRatio - bRatio;
      }

      // 4. Historical fairness (worked less in past weeks = higher priority)
      return (fairnessMap[b.id] || 0) - (fairnessMap[a.id] || 0);
    });

    // First fill required roles
    for (const [role, count] of Object.entries(slot.roleReqs)) {
      let filled = 0;
      for (const emp of available) {
        if (filled >= count) break;
        const empRoles = emp.roles || (emp.role ? [emp.role] : ['general']);
        if (empRoles.includes(role) && !assigned.includes(emp.id)) {
          assigned.push(emp.id);
          filled++;
        }
      }
      if (filled < count) {
        warnings.push(`חוסר ${role} במשמרת ${slot.shiftName} ביום ${slot.date} (${filled}/${count})`);
      }
    }

    // Fill remaining spots from sorted list
    for (const emp of available) {
      if (assigned.length >= slot.required) break;
      if (!assigned.includes(emp.id)) {
        assigned.push(emp.id);
      }
    }

    if (assigned.length < slot.required) {
      warnings.push(`חוסר עובדים במשמרת ${slot.shiftName} ביום ${slot.date} (${assigned.length}/${slot.required})`);
    }

    // Update tracking
    schedule.days[slot.date][slot.shiftId] = assigned;
    assigned.forEach(id => {
      weekCount[id]++;
      if (isMorning) morningCount[id]++;
      if (isEvening) eveningCount[id]++;
    });
  }

  // ===== POST-PROCESSING: Balance pass =====
  // Try to swap employees between shifts to improve fairness
  const maxCount = Math.max(...Object.values(weekCount));
  const minCount = Math.min(...Object.values(weekCount));

  if (maxCount - minCount > 1) {
    // Find overloaded and underloaded employees
    for (let pass = 0; pass < 3; pass++) {
      let improved = false;
      const overloaded = employees.filter(e => weekCount[e.id] > idealPerEmployee + 0.5);
      const underloaded = employees.filter(e => weekCount[e.id] < idealPerEmployee - 0.5);

      for (const over of overloaded) {
        for (const under of underloaded) {
          if (weekCount[over.id] <= weekCount[under.id] + 1) continue;

          // Try to find a shift where over is assigned and under could replace
          let swapped = false;
          for (const [dateStr, shifts] of Object.entries(schedule.days)) {
            if (!shifts || swapped) continue;
            for (const [shiftId, empIds] of Object.entries(shifts)) {
              if (swapped) break;
              if (empIds.includes(over.id) && !empIds.includes(under.id)) {
                // Check under is available for this slot
                if (isAvailable(under.id, dateStr, shiftId)) {
                  // Check under is not already on this day
                  let alreadyOnDay = false;
                  for (const otherIds of Object.values(shifts)) {
                    if (otherIds.includes(under.id)) { alreadyOnDay = true; break; }
                  }
                  if (!alreadyOnDay) {
                    // Swap!
                    const idx = empIds.indexOf(over.id);
                    empIds[idx] = under.id;
                    weekCount[over.id]--;
                    weekCount[under.id]++;
                    const isMorning = shiftId.includes('morning');
                    const isEvening = shiftId.includes('evening');
                    if (isMorning) { morningCount[over.id]--; morningCount[under.id]++; }
                    if (isEvening) { eveningCount[over.id]--; eveningCount[under.id]++; }
                    swapped = true;
                    improved = true;
                  }
                }
              }
            }
          }
        }
      }
      if (!improved) break;
    }
  }

  // ===== POST-PROCESSING: Variety pass =====
  // For employees with 'any' preference, try to balance morning/evening ratio
  for (const emp of employees) {
    const pref = emp.shiftPreference || 'any';
    if (pref !== 'any' || weekCount[emp.id] < 2) continue;

    const mCount = morningCount[emp.id];
    const eCount = eveningCount[emp.id];
    const total = mCount + eCount;
    if (total < 2) continue;

    // If ratio is too skewed (all morning or all evening), try to swap one
    if (mCount === 0 || eCount === 0) {
      const heavyType = mCount > eCount ? 'morning' : 'evening';
      const lightType = heavyType === 'morning' ? 'evening' : 'morning';

      // Find a day where emp has heavyType and could swap with someone in lightType
      for (const [dateStr, shifts] of Object.entries(schedule.days)) {
        if (!shifts) continue;
        const heavyShifts = Object.entries(shifts).filter(([sid]) => sid.includes(heavyType));
        const lightShifts = Object.entries(shifts).filter(([sid]) => sid.includes(lightType));

        for (const [hShiftId, hEmpIds] of heavyShifts) {
          if (!hEmpIds.includes(emp.id)) continue;

          for (const [lShiftId, lEmpIds] of lightShifts) {
            // Find someone in lightShift who could swap to heavyShift
            for (const otherId of lEmpIds) {
              const other = employees.find(e => e.id === otherId);
              if (!other) continue;
              const otherPref = other.shiftPreference || 'any';
              if (otherPref !== 'any') continue; // only swap with 'any' preference
              if (hEmpIds.includes(otherId)) continue;

              // Check both are available for the swap
              if (isAvailable(emp.id, dateStr, lShiftId) && isAvailable(otherId, dateStr, hShiftId)) {
                // Do the swap
                hEmpIds[hEmpIds.indexOf(emp.id)] = otherId;
                lEmpIds[lEmpIds.indexOf(otherId)] = emp.id;

                if (heavyType === 'morning') {
                  morningCount[emp.id]--; eveningCount[emp.id]++;
                  morningCount[otherId]++; eveningCount[otherId]--;
                } else {
                  eveningCount[emp.id]--; morningCount[emp.id]++;
                  eveningCount[otherId]++; morningCount[otherId]--;
                }
                break;
              }
            }
            // Recheck after potential swap
            if (morningCount[emp.id] > 0 && eveningCount[emp.id] > 0) break;
          }
          if (morningCount[emp.id] > 0 && eveningCount[emp.id] > 0) break;
        }
        if (morningCount[emp.id] > 0 && eveningCount[emp.id] > 0) break;
      }
    }
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
      warnings.push(`${emp.name} משובצ/ת ${maxConsec} ימים רצופים (מקסימום: ${config.MAX_CONSECUTIVE_DAYS})`);
    }
  }

  // Summary stats
  const distribution = employees.map(e => `${e.name}: ${weekCount[e.id]}`).join(', ');
  warnings.push(`חלוקה: ${distribution}`);

  return {
    status: 'draft',
    generatedAt: new Date().toISOString(),
    days: schedule.days,
    warnings,
    manualEdits: []
  };
}

module.exports = { generateSchedule, getShiftsForDate, getWeekDates };
