const express = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/auth.controller');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/login', loginLimiter, controller.login);

module.exports = router;
