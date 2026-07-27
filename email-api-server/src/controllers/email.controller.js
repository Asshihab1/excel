const path = require('path');
const smtpService = require('../services/smtp.service');
const imapService = require('../services/imap.service');

async function sendEmail(req, res) {
  try {
    const { from, to, subject, body } = req.body;

    const attachments = (req.files || []).map((file) => ({
      filename: file.originalname,
      path: path.resolve(file.path),
    }));

    await smtpService.sendMail(req.account, { from, to, subject, body, attachments });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getInbox(req, res) {
  try {
    const folderKey = req.query.folder || 'inbox';
    const messages = await imapService.getFolderMessages(req.account, folderKey);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getEmail(req, res) {
  try {
    const email = await imapService.getMessageById(req.account, req.params.id);
    if (!email) return res.status(404).json({ success: false, error: 'Not found' });
    res.json(email);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getFolders(req, res) {
  try {
    const folders = await imapService.listFolders(req.account);
    res.json(folders);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function deleteEmail(req, res) {
  try {
    await imapService.deleteMessage(req.account, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { sendEmail, getInbox, getEmail, getFolders, deleteEmail };
