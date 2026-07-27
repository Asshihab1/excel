const accountsService = require('../services/accounts.service');

function listAccounts(req, res) {
  res.json(accountsService.list());
}

function addAccount(req, res) {
  const account = accountsService.add(req.body);
  res.status(201).json(account);
}

function deleteAccount(req, res) {
  const removed = accountsService.remove(req.params.id);
  if (!removed) return res.status(404).json({ success: false, error: 'Account not found' });
  res.json({ success: true });
}

module.exports = { listAccounts, addAccount, deleteAccount };
