const nodemailer = require('nodemailer');

function getTransporter(account) {
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: Number(account.smtpPort),
    secure: false, // STARTTLS on the submission port
    requireTLS: true,
    tls: { rejectUnauthorized: false }, // snake-oil cert on local mailcow instance
    auth: {
      user: account.email,
      pass: account.password,
    },
  });
}

async function sendMail(account, { from, to, subject, body, attachments }) {
  const transporter = getTransporter(account);
  return transporter.sendMail({ from, to, subject, text: body, attachments });
}

module.exports = { sendMail };
