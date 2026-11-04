const nodemailer = require('nodemailer');
function configured() { return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.MAIL_FROM && process.env.APP_ORIGIN); }
async function sendReset(email, token) {
  if (!configured()) { const e = new Error('Password recovery email is not configured. Contact your administrator.'); e.status = 503; throw e; }
  const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: (process.env.SMTP_PORT || '465') === '465', requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    tls: { rejectUnauthorized: true } });
  // Fragment is never sent in HTTP request URLs or referrers. UI clears it immediately.
  const link = `${process.env.APP_ORIGIN}/reset-password.html#${token}`;
  await transport.sendMail({ from: process.env.MAIL_FROM, to: email, subject: 'FWA Timesheet password setup or reset', text: `Choose a new password using this one-time link within 30 minutes:\n${link}\nIf you did not request this, ignore this message. No password has changed.` });
}
module.exports = { configured, sendReset };
