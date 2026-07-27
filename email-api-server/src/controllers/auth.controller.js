const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

async function login(req, res) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'username and password required' });
  }

  const validUser = username === process.env.API_LOGIN_USER;
  const validPassword =
    validUser && (await bcrypt.compare(password, process.env.API_LOGIN_PASSWORD_HASH));

  if (!validPassword) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }

  const token = jwt.sign({ sub: username }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ success: true, token });
}

module.exports = { login };
