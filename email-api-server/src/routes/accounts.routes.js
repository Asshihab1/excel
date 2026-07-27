const express = require('express');
const { z } = require('zod');
const controller = require('../controllers/accounts.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { validateBody } = require('../middleware/validate');

const router = express.Router();

const addAccountSchema = z.object({
  label: z.string().max(100).optional(),
  email: z.email(),
  password: z.string().min(1).max(500),
  imapHost: z.string().min(1),
  imapPort: z.coerce.number().int().min(1).max(65535),
  smtpHost: z.string().min(1),
  smtpPort: z.coerce.number().int().min(1).max(65535),
});

router.use(requireAuth);

router.get('/defaults', (req, res) => {
  res.json({
    imapHost: process.env.DEFAULT_IMAP_HOST || 'localhost',
    imapPort: Number(process.env.DEFAULT_IMAP_PORT) || 1143,
    smtpHost: process.env.DEFAULT_SMTP_HOST || 'localhost',
    smtpPort: Number(process.env.DEFAULT_SMTP_PORT) || 1587,
  });
});

router.get('/', controller.listAccounts);
router.post('/', validateBody(addAccountSchema), controller.addAccount);
router.delete('/:id', controller.deleteAccount);

module.exports = router;
