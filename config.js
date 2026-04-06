module.exports = {
  PORT: process.env.PORT || 3000,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'roladin2024',
  BRANCH_NAME: process.env.BRANCH_NAME || 'רולדין - סניף ראשי',
  DATA_DIR: process.env.DATA_DIR || './data',
  MAX_SHIFTS_PER_WEEK: parseInt(process.env.MAX_SHIFTS_PER_WEEK) || 6,
  MAX_CONSECUTIVE_DAYS: parseInt(process.env.MAX_CONSECUTIVE_DAYS) || 6,
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000'
};
