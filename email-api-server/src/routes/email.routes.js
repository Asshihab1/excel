const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const controller = require('../controllers/email.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { resolveAccount } = require('../middleware/resolveAccount');
const { validateBody } = require('../middleware/validate');

const router = express.Router();

const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 5,
  },
});

const sendEmailSchema = z.object({
  from: z.email(),
  to: z.email(),
  subject: z.string().min(1).max(500),
  body: z.string().max(200_000).optional().default(''),
});

router.use(requireAuth);
router.use(resolveAccount);

// specific routes first, /:id must come last
router.post('/send', upload.array('attachments'), validateBody(sendEmailSchema), controller.sendEmail);
router.get('/inbox', controller.getInbox);
router.get('/folders', controller.getFolders);
router.get('/:id', controller.getEmail);
router.delete('/:id', controller.deleteEmail);

module.exports = router;
