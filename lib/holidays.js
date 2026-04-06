// חגים ישראליים - תאריכים מעודכנים
// הערה: תאריכי החגים משתנים כל שנה לפי הלוח העברי
const holidays = {
  2025: [
    { date: '2025-03-14', name: 'פורים' },
    { date: '2025-04-13', name: 'ערב פסח' },
    { date: '2025-04-14', name: 'פסח' },
    { date: '2025-04-20', name: 'שביעי של פסח' },
    { date: '2025-05-02', name: 'יום הזיכרון' },
    { date: '2025-05-03', name: 'יום העצמאות' },
    { date: '2025-06-02', name: 'שבועות' },
    { date: '2025-09-23', name: 'ראש השנה' },
    { date: '2025-09-24', name: 'ראש השנה ב' },
    { date: '2025-10-02', name: 'יום כיפור' },
    { date: '2025-10-07', name: 'סוכות' },
    { date: '2025-10-14', name: 'שמחת תורה' }
  ],
  2026: [
    { date: '2026-03-04', name: 'פורים' },
    { date: '2026-04-02', name: 'ערב פסח' },
    { date: '2026-04-03', name: 'פסח' },
    { date: '2026-04-09', name: 'שביעי של פסח' },
    { date: '2026-04-22', name: 'יום הזיכרון' },
    { date: '2026-04-23', name: 'יום העצמאות' },
    { date: '2026-05-22', name: 'שבועות' },
    { date: '2026-09-12', name: 'ראש השנה' },
    { date: '2026-09-13', name: 'ראש השנה ב' },
    { date: '2026-09-21', name: 'יום כיפור' },
    { date: '2026-09-26', name: 'סוכות' },
    { date: '2026-10-03', name: 'שמחת תורה' }
  ],
  2027: [
    { date: '2027-03-24', name: 'פורים' },
    { date: '2027-04-22', name: 'ערב פסח' },
    { date: '2027-04-23', name: 'פסח' },
    { date: '2027-04-29', name: 'שביעי של פסח' },
    { date: '2027-05-12', name: 'יום הזיכרון' },
    { date: '2027-05-13', name: 'יום העצמאות' },
    { date: '2027-06-11', name: 'שבועות' },
    { date: '2027-10-02', name: 'ראש השנה' },
    { date: '2027-10-03', name: 'ראש השנה ב' },
    { date: '2027-10-11', name: 'יום כיפור' },
    { date: '2027-10-16', name: 'סוכות' },
    { date: '2027-10-23', name: 'שמחת תורה' }
  ]
};

function getHolidays(year) {
  return holidays[year] || [];
}

function isHoliday(dateStr) {
  const year = parseInt(dateStr.slice(0, 4));
  const list = holidays[year] || [];
  return list.find(h => h.date === dateStr) || null;
}

function getHolidaysInRange(startDate, endDate) {
  const results = [];
  const startYear = parseInt(startDate.slice(0, 4));
  const endYear = parseInt(endDate.slice(0, 4));
  for (let y = startYear; y <= endYear; y++) {
    const list = holidays[y] || [];
    for (const h of list) {
      if (h.date >= startDate && h.date <= endDate) {
        results.push(h);
      }
    }
  }
  return results;
}

module.exports = { getHolidays, isHoliday, getHolidaysInRange };
