const path = require('path');
const smtpService = require('../services/smtp.service');
const imapService = require('../services/imap.service');

async function sendEmail(req, res) {
  try {
    const { from, to, subject, body } = req.body;
    if (!from || !to || !subject) {
      return res.status(400).json({ success: false, error: 'from, to, subject are required' });
    }

    const attachments = (req.files || []).map((file) => ({
      filename: file.originalname,
      path: path.resolve(file.path),
    }));

    await smtpService.sendMail({ from, to, subject, body, attachments });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getInbox(req, res) {
  try {
    const folderKey = req.query.folder || 'inbox';
    const messages = await imapService.getFolderMessages(folderKey);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getEmail(req, res) {
  try {
    const email = await imapService.getMessageById(req.params.id);
    if (!email) return res.status(404).json({ success: false, error: 'Not found' });
    res.json(email);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getFolders(req, res) {
  try {
    const folders = await imapService.listFolders();
    res.json(folders);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function deleteEmail(req, res) {
  try {
    await imapService.deleteMessage(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { sendEmail, getInbox, getEmail, getFolders, deleteEmail };
