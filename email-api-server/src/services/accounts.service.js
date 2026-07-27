const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'accounts.json');

function getKey() {
  const key = Buffer.from(process.env.ACCOUNTS_ENC_KEY, 'hex');
  if (key.length !== 32) throw new Error('ACCOUNTS_ENC_KEY must be a 32-byte hex string');
  return key;
}

function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((b) => b.toString('base64')).join(':');
}

function decrypt(payload) {
  const [ivB64, authTagB64, encryptedB64] = payload.split(':');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getKey(),
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function readAll() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeAll(accounts) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2));
}

function toPublic(account) {
  const { encryptedPassword, ...rest } = account;
  return rest;
}

function list() {
  return readAll().map(toPublic);
}

function getWithPassword(id) {
  const account = readAll().find((a) => a.id === id);
  if (!account) return null;
  return { ...toPublic(account), password: decrypt(account.encryptedPassword) };
}

function add({ label, email, password, imapHost, imapPort, smtpHost, smtpPort }) {
  const accounts = readAll();
  const account = {
    id: crypto.randomUUID(),
    label: label || email,
    email,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    encryptedPassword: encrypt(password),
  };
  accounts.push(account);
  writeAll(accounts);
  return toPublic(account);
}

function remove(id) {
  const accounts = readAll();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  writeAll(next);
  return true;
}

module.exports = { list, getWithPassword, add, remove };
