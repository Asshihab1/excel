const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function getClient() {
  return new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT),
    secure: false, // STARTTLS negotiated in-band; snake-oil cert, not verified
    tls: { rejectUnauthorized: false },
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASSWORD,
    },
    logger: false,
  });
}

async function withClient(fn) {
  const client = getClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

const FOLDER_MAP = {
  inbox: 'INBOX',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
};

async function resolveFolderPath(client, key) {
  const wanted = FOLDER_MAP[key] || key;
  const list = await client.list();
  const match =
    list.find((box) => box.specialUse === `\\${wanted}`) ||
    list.find((box) => box.path.toUpperCase() === wanted.toUpperCase()) ||
    list.find((box) => box.name.toLowerCase() === wanted.toLowerCase());
  return match ? match.path : wanted;
}

async function listFolders() {
  return withClient(async (client) => {
    const list = await client.list();
    return list.map((box) => ({
      key: box.name.toLowerCase(),
      name: box.name,
      path: box.path,
    }));
  });
}

async function getFolderMessages(folderKey) {
  return withClient(async (client) => {
    const path = await resolveFolderPath(client, folderKey);
    const lock = await client.getMailboxLock(path);
    try {
      const messages = [];
      for await (const msg of client.fetch({ all: true }, { envelope: true, source: true })) {
        const parsed = await simpleParser(msg.source);
        messages.push({
          id: `${folderKey}:${msg.uid}`,
          from: parsed.from ? parsed.from.text : '',
          subject: parsed.subject || '',
          date: parsed.date ? parsed.date.toISOString() : '',
          body: parsed.text || '',
        });
      }
      return messages.reverse();
    } finally {
      lock.release();
    }
  });
}

function decodeId(id) {
  const [folderKey, uid] = id.split(':');
  return { folderKey, uid: Number(uid) };
}

async function getMessageById(id) {
  const { folderKey, uid } = decodeId(id);
  return withClient(async (client) => {
    const path = await resolveFolderPath(client, folderKey);
    const lock = await client.getMailboxLock(path);
    try {
      const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
      if (!msg) return null;
      const parsed = await simpleParser(msg.source);
      return {
        id,
        from: parsed.from ? parsed.from.text : '',
        to: parsed.to ? parsed.to.text : '',
        subject: parsed.subject || '',
        date: parsed.date ? parsed.date.toISOString() : '',
        body: parsed.text || '',
        html: parsed.html || null,
        attachments: (parsed.attachments || []).map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
      };
    } finally {
      lock.release();
    }
  });
}

async function deleteMessage(id) {
  const { folderKey, uid } = decodeId(id);
  return withClient(async (client) => {
    const path = await resolveFolderPath(client, folderKey);
    const trashPath = await resolveFolderPath(client, 'trash');
    const lock = await client.getMailboxLock(path);
    try {
      await client.messageMove(uid, trashPath, { uid: true });
      return true;
    } finally {
      lock.release();
    }
  });
}

module.exports = { listFolders, getFolderMessages, getMessageById, deleteMessage };
