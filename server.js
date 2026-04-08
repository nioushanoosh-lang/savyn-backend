TextDecoderStream.html
<!DOCTYPE html>
<html>
<head>
  <title>FinAdvisor — Plaid Test</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #f5f0e8; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    p { color: #7a6e5f; margin-bottom: 32px; }
    button { background: #1a1209; color: white; border: none; padding: 16px 32px; border-radius: 12px; font-size: 16px; cursor: pointer; }
    button:hover { background: #c8341a; }
    #status { margin-top: 24px; color: #1a6b45; font-size: 14px; }
  </style>
</head>
<body>
  <h1>FinAdvisor Plaid Test</h1>
  <p>Connect a fake Sandbox bank account to test the integration</p>
  <button onclick="connectBank()">Connect Bank Account</button>
  <div id="status"></div>

<script>
async function connectBank() {
  const status = document.getElementById('status');
  status.textContent = 'Getting link token...';

  // Step 1 - get link token from your backend
  const res = await fetch('http://localhost:3000/api/create-link-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });

  const data = await res.json();
  const linkToken = data.link_token;
  status.textContent = 'Opening Plaid...';

  // Step 2 - open Plaid Link window
  const handler = Plaid.create({
    token: linkToken,
    onSuccess: async (public_token, metadata) => {
      status.textContent = 'Exchanging token...';

      // Step 3 - exchange public token for access token
      await fetch('http://localhost:3000/api/exchange-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token })
      });

      status.textContent = '✅ Bank connected! Fetching balances...';

      // Step 4 - get balances
      const balRes = await fetch('http://localhost:3000/api/balances');
      const balData = await balRes.json();
      console.log('BALANCES:', balData);

      status.textContent = '✅ Success! Check the browser console for your account data (Command + Option + J)';
    },
    onExit: (err) => {
      if (err) status.textContent = 'Error: ' + err.message;
      else status.textContent = 'Cancelled.';
    }
  });

  handler.open();
}
</script>
</body>
</html>
```
<!DOCTYPE html>
<html>
<head>
  <title>FinAdvisor — Plaid Test</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #f5f0e8; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    p { color: #7a6e5f; margin-bottom: 32px; }
    button { background: #1a1209; color: white; border: none; padding: 16px 32px; border-radius: 12px; font-size: 16px; cursor: pointer; }
    button:hover { background: #c8341a; }
    #status { margin-top: 24px; color: #1a6b45; font-size: 14px; }
  </style>
</head>
<body>
  <h1>FinAdvisor Plaid Test</h1>
  <p>Connect a fake Sandbox bank account to test the integration</p>
  <button onclick="connectBank()">Connect Bank Account</button>
  <div id="status"></div>

<script>
async function connectBank() {
  const status = document.getElementById('status');
  status.textContent = 'Getting link token...';

  // Step 1 - get link token from your backend
  const res = await fetch('http://localhost:3000/api/create-link-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });

  const data = await res.json();
  const linkToken = data.link_token;
  status.textContent = 'Opening Plaid...';

  // Step 2 - open Plaid Link window
  const handler = Plaid.create({
    token: linkToken,
    onSuccess: async (public_token, metadata) => {
      status.textContent = 'Exchanging token...';

      // Step 3 - exchange public token for access token
      await fetch('http://localhost:3000/api/exchange-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token })
      });

      status.textContent = '✅ Bank connected! Fetching balances...';

      // Step 4 - get balances
      const balRes = await fetch('http://localhost:3000/api/balances');
      const balData = await balRes.json();
      console.log('BALANCES:', balData);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'savyn-secret-key';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid session. Please log in again.' });
  }
}

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Account already exists.' });
    const hashedPassword = await bcrypt.hash(password, 12);
    const result = await pool.query('INSERT INTO users (email, password_hash, created_at) VALUES ($1, $2, NOW()) RETURNING id, email', [email.toLowerCase(), hashedPassword]);
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, email: user.email, userId: user.id });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    const result = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'No account found with this email.' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Incorrect password.' });
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, email: user.email, userId: user.id });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, created_at FROM users WHERE id = $1', [req.user.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get user info.' });
  }
});

      status.textContent = '✅ Success! Check the browser console for your account data (Command + Option + J)';
    },
    onExit: (err) => {
      if (err) status.textContent = 'Error: ' + err.message;
      else status.textContent = 'Cancelled.';
    }
  });

  handler.open();
}
</script>
</body>
</html>
```

Save with **Command + S**.

Then open this file in your browser — in Terminal tab 2 type:
```
open test.html