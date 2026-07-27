const accountsService = require('../services/accounts.service');

function resolveAccount(req, res, next) {
  const accountId = req.query.accountId || req.headers['x-account-id'];
  if (!accountId) {
    return res.status(400).json({ success: false, error: 'accountId is required' });
  }
  const account = accountsService.getWithPassword(accountId);
  if (!account) {
    return res.status(404).json({ success: false, error: 'Account not found' });
  }
  req.account = account;
  next();
}

module.exports = { resolveAccount };
