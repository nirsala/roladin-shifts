const config = require('../config');
const storage = require('./storage');

function formatPhone(phone) {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) {
    digits = '972' + digits.slice(1);
  }
  if (!digits.startsWith('972')) {
    digits = '972' + digits;
  }
  return digits;
}

function buildAvailabilityLink(employee, weekKey) {
  return `${config.BASE_URL}/employee/availability.html?token=${employee.token}&week=${weekKey}`;
}

function buildScheduleLink(employee) {
  return `${config.BASE_URL}/employee/my-schedule.html?token=${employee.token}`;
}

function generateAvailabilityMessage(employee, weekKey, deadline) {
  const link = buildAvailabilityLink(employee, weekKey);
  const deadlineStr = new Date(deadline).toLocaleDateString('he-IL', {
    weekday: 'long', day: 'numeric', month: 'numeric'
  });

  return `שלום ${employee.name} 👋\n\nנפתח שבוע ${weekKey} להגשת זמינות.\nנא להגיש עד ${deadlineStr}.\n\n${link}`;
}

function generateReminderMessage(employee, weekKey, deadline) {
  const link = buildAvailabilityLink(employee, weekKey);
  return `היי ${employee.name},\nעדיין לא הגשת זמינות לשבוע ${weekKey}.\nנא להגיש בהקדם! ⏰\n\n${link}`;
}

function generateSchedulePublishedMessage(employee, weekKey) {
  const link = buildScheduleLink(employee);
  return `שלום ${employee.name} 📋\n\nסידור העבודה לשבוע ${weekKey} פורסם.\nלצפייה:\n\n${link}`;
}

function buildWhatsAppLink(phone, message) {
  const formattedPhone = formatPhone(phone);
  const encoded = encodeURIComponent(message);
  return `https://wa.me/${formattedPhone}?text=${encoded}`;
}

function getAvailabilityLinks(weekKey) {
  const employees = storage.read('employees', []);
  const availability = storage.read('availability', {});
  const week = availability[weekKey];

  return employees
    .filter(e => e.active)
    .map(e => {
      const submitted = week?.submissions?.[e.id] ? true : false;
      const message = generateAvailabilityMessage(e, weekKey, week?.deadline);
      return {
        employeeId: e.id,
        name: e.name,
        phone: e.phone,
        submitted,
        waLink: buildWhatsAppLink(e.phone, message)
      };
    });
}

function getReminderLinks(weekKey) {
  return getAvailabilityLinks(weekKey).filter(l => !l.submitted);
}

function getSchedulePublishedLinks(weekKey) {
  const employees = storage.read('employees', []);
  return employees
    .filter(e => e.active)
    .map(e => {
      const message = generateSchedulePublishedMessage(e, weekKey);
      return {
        employeeId: e.id,
        name: e.name,
        phone: e.phone,
        waLink: buildWhatsAppLink(e.phone, message)
      };
    });
}

module.exports = {
  formatPhone,
  buildWhatsAppLink,
  getAvailabilityLinks,
  getReminderLinks,
  getSchedulePublishedLinks,
  buildAvailabilityLink,
  buildScheduleLink
};
