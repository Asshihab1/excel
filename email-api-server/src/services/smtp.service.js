const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false, // STARTTLS on the submission port
  requireTLS: true,
  tls: { rejectUnauthorized: false }, // snake-oil cert on local mailcow instance
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

async function sendMail({ from, to, subject, body, attachments }) {
  return transporter.sendMail({ from, to, subject, text: body, attachments });
}

module.exports = { sendMail };
