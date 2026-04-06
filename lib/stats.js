const storage = require('./storage');

function getEmployeeStats(employeeId, weeksBack = 8) {
  const schedules = storage.read('schedules', {});
  const weekKeys = Object.keys(schedules)
    .filter(k => schedules[k].status === 'published')
    .sort()
    .slice(-weeksBack);

  let totalShifts = 0;
  let morningShifts = 0;
  let eveningShifts = 0;
  let weekendShifts = 0;
  const weeklyBreakdown = [];

  for (const weekKey of weekKeys) {
    const schedule = schedules[weekKey];
    let weekCount = 0;

    for (const [dateStr, shifts] of Object.entries(schedule.days || {})) {
      const dayOfWeek = new Date(dateStr).getDay();
      for (const [shiftId, employeeIds] of Object.entries(shifts)) {
        if (employeeIds.includes(employeeId)) {
          totalShifts++;
          weekCount++;
          if (shiftId.includes('morning') || shiftId === 'morning') morningShifts++;
          if (shiftId.includes('evening') || shiftId === 'evening') eveningShifts++;
          if (dayOfWeek === 5 || dayOfWeek === 6) weekendShifts++;
        }
      }
    }

    weeklyBreakdown.push({ week: weekKey, shifts: weekCount });
  }

  return {
    employeeId,
    weeksAnalyzed: weekKeys.length,
    totalShifts,
    morningShifts,
    eveningShifts,
    weekendShifts,
    avgPerWeek: weekKeys.length > 0 ? (totalShifts / weekKeys.length).toFixed(1) : 0,
    weeklyBreakdown
  };
}

function getAllEmployeeStats(weeksBack = 8) {
  const employees = storage.read('employees', []);
  return employees
    .filter(e => e.active)
    .map(e => ({
      ...e,
      stats: getEmployeeStats(e.id, weeksBack)
    }));
}

function getFairnessScores(weeksBack = 4) {
  const stats = getAllEmployeeStats(weeksBack);
  if (stats.length === 0) return [];

  const avgShifts = stats.reduce((sum, e) => sum + e.stats.totalShifts, 0) / stats.length;

  return stats.map(e => ({
    employeeId: e.id,
    name: e.name,
    totalShifts: e.stats.totalShifts,
    deviation: e.stats.totalShifts - avgShifts,
    priority: avgShifts - e.stats.totalShifts
  })).sort((a, b) => b.priority - a.priority);
}

module.exports = { getEmployeeStats, getAllEmployeeStats, getFairnessScores };
