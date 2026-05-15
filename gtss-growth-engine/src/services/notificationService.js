const nodemailer = require('nodemailer');
const { getDb } = require('../db/database');
const logger = require('../utils/logger');

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getMailConfig() {
  return {
    user: getSetting('gmail_user') || process.env.GMAIL_USER,
    pass: getSetting('gmail_app_password') || process.env.GMAIL_APP_PASSWORD
  };
}

async function sendNotification(subject, text) {
  const { user, pass } = getMailConfig();
  if (!user || !pass) {
    logger.debug('NOTIFY', 'Email notification skipped; Gmail is not configured');
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass }
    });
    await transporter.sendMail({ from: user, to: user, subject, text });
    return true;
  } catch (error) {
    logger.error('NOTIFY', 'Email notification failed', { error: error.message });
    return false;
  }
}

module.exports = {
  sendNotification
};
