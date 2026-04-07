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

function getBaseUrl(req) {
  if (config.BASE_URL) {
    return config.BASE_URL.replace(/\/$/, '');
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${protocol}://${host}`;
}

function buildAvailabilityLink(baseUrl, employee, weekKey) {
  return `${baseUrl}/employee/availability.html?token=${employee.token}&week=${weekKey}`;
}

function buildScheduleLink(baseUrl, employee) {
  return `${baseUrl}/employee/?token=${employee.token}`;
}

function generateAvailabilityMessage(baseUrl, employee, weekKey, deadline) {
  const link = buildAvailabilityLink(baseUrl, employee, weekKey);
  const deadlineStr = deadline ? new Date(deadline).toLocaleDateString('he-IL', {
    weekday: 'long', day: 'numeric', month: 'numeric'
  }) : '';

  return `שלום ${employee.name} 👋\n\nנפתח שבוע ${weekKey} להגשת זמינות.${deadlineStr ? '\nנא להגיש עד ' + deadlineStr + '.' : ''}\n\n${link}`;
}

function generateReminderMessage(baseUrl, employee, weekKey) {
  const link = buildAvailabilityLink(baseUrl, employee, weekKey);
  return `היי ${employee.name},\nעדיין לא הגשת זמינות לשבוע ${weekKey}.\nנא להגיש בהקדם! ⏰\n\n${link}`;
}

function generateSchedulePublishedMessage(baseUrl, employee, weekKey) {
  const link = buildScheduleLink(baseUrl, employee);
  return `שלום ${employee.name} 📋\n\nסידור העבודה לשבוע ${weekKey} פורסם.\nלצפייה:\n\n${link}`;
}

function buildWhatsAppLink(phone, message) {
  const formattedPhone = formatPhone(phone);
  const encoded = encodeURIComponent(message);
  return `https://wa.me/${formattedPhone}?text=${encoded}`;
}

function getAvailabilityLinks(weekKey, req) {
  const baseUrl = getBaseUrl(req);
  const employees = storage.read('employees', []);
  const availability = storage.read('availability', {});
  const week = availability[weekKey];

  return employees
    .filter(e => e.active)
    .map(e => {
      const submitted = week?.submissions?.[e.id] ? true : false;
      const message = generateAvailabilityMessage(baseUrl, e, weekKey, week?.deadline);
      return {
        employeeId: e.id,
        name: e.name,
        phone: e.phone,
        submitted,
        waLink: buildWhatsAppLink(e.phone, message)
      };
    });
}

function getReminderLinks(weekKey, req) {
  return getAvailabilityLinks(weekKey, req).filter(l => !l.submitted);
}

function getSchedulePublishedLinks(weekKey, req) {
  const baseUrl = getBaseUrl(req);
  const employees = storage.read('employees', []);
  return employees
    .filter(e => e.active)
    .map(e => {
      const message = generateSchedulePublishedMessage(baseUrl, e, weekKey);
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
  getBaseUrl
};
