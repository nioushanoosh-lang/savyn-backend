const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ── DATABASE ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plaid_access_token TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_bills (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      cc_monthly NUMERIC DEFAULT 0,
      quarterly_annual_monthly NUMERIC DEFAULT 0,
      seasonal_monthly NUMERIC DEFAULT 0,
      aggressiveness VARCHAR(20) DEFAULT 'moderate',
      irregular_expenses NUMERIC DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transfer_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      amount NUMERIC,
      status VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database tables ready');
}
initDB();

// ── PLAID ──
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SANDBOX_SECRET,
    }
  }
});
const plaidClient = new PlaidApi(plaidConfig);

// ── JWT AUTH ──
const JWT_SECRET = process.env.JWT_SECRET || 'savyn-super-secret-key-2026-change-this';

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

async function getUserAccessToken(userId) {
  const result = await pool.query('SELECT plaid_access_token FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0 || !result.rows[0].plaid_access_token) return null;
  return result.rows[0].plaid_access_token;
}

// Safe liabilities fetch — returns empty if not supported by institution
async function getLiabilitiesSafe(accessToken) {
  try {
    const res = await plaidClient.liabilitiesGet({ access_token: accessToken });
    return res.data.liabilities;
  } catch (err) {
    const errCode = err.response?.data?.error_code;
    if (errCode === 'NO_LIABILITY_ACCOUNTS' || errCode === 'PRODUCTS_NOT_SUPPORTED') {
      return { credit: [], student: [], mortgage: [] };
    }
    throw err;
  }
}

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: 'Savyn backend running' }));

// ── AUTH ENDPOINTS ──
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Account already exists.' });
    const hashedPassword = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, created_at) VALUES ($1, $2, NOW()) RETURNING id, email',
      [email.toLowerCase(), hashedPassword]
    );
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
    if (result.rows.length === 0) return res.status(400).json({ error: 'No account found.' });
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

// ── PLAID ENDPOINTS ──
app.post('/api/create-link-token', authenticateToken, async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(req.user.userId) },
      client_name: 'Savyn',
      // FIX: Use transactions as primary product, liabilities as optional
      // This allows Chase, Amex, and all banks to connect properly
      products: ['transactions'],
      optional_products: ['liabilities', 'auth'],
      country_codes: ['US'],
      language: 'en',
      redirect_uri: 'https://www.savynapp.com/Savyn.html',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('Link token error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

app.post('/api/exchange-token', authenticateToken, async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const accessToken = response.data.access_token;
    await pool.query(
      'UPDATE users SET plaid_access_token = $1 WHERE id = $2',
      [accessToken, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Exchange token error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

app.get('/api/balances', authenticateToken, async (req, res) => {
  try {
    const accessToken = await getUserAccessToken(req.user.userId);
    if (!accessToken) return res.status(400).json({ error: 'No bank account linked. Please connect your bank first.' });
    const response = await plaidClient.accountsBalanceGet({ access_token: accessToken });
    res.json(response.data);
  } catch (err) {
    console.error('Balances error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get balances' });
  }
});

app.get('/api/liabilities', authenticateToken, async (req, res) => {
  try {
    const accessToken = await getUserAccessToken(req.user.userId);
    if (!accessToken) return res.status(400).json({ error: 'No bank account linked.' });
    const liabilities = await getLiabilitiesSafe(accessToken);
    res.json({ liabilities });
  } catch (err) {
    console.error('Liabilities error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get liabilities' });
  }
});

app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const accessToken = await getUserAccessToken(req.user.userId);
    if (!accessToken) return res.status(400).json({ error: 'No bank account linked.' });
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate
    });
    res.json(response.data);
  } catch (err) {
    console.error('Transactions error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

// ── SAVYN AI CHAT ──
app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'No message provided' });

    let financialContext = 'No bank account connected yet.';
    try {
      const accessToken = await getUserAccessToken(req.user.userId);
      if (accessToken) {
        const balRes = await plaidClient.accountsBalanceGet({ access_token: accessToken });
        const accounts = balRes.data.accounts;
        const checking = accounts.find(a => a.subtype === 'checking');
        const savings = accounts.find(a => a.subtype === 'savings');
        const creditCards = accounts.filter(a => a.type === 'credit');

        // Try to get liabilities safely
        const liabilities = await getLiabilitiesSafe(accessToken);
        const liabCreditCards = liabilities.credit || [];
        const studentLoans = liabilities.student || [];

        financialContext = `User's real financial data:
- Checking balance: $${checking ? (checking.balances.available || checking.balances.current || 0).toLocaleString() : 'unknown'}
- Savings balance: $${savings ? (savings.balances.current || 0).toLocaleString() : 0}
- Credit accounts: ${creditCards.map(c => `${c.name} balance $${c.balances.current || 0}`).join('; ') || 'none'}
- Credit card liabilities: ${liabCreditCards.map(c => `${c.name} $${c.last_statement_balance} at ${c.aprs?.[0]?.apr_percentage || '?'}% APR`).join('; ') || 'none'}
- Student loans: ${studentLoans.map(l => `${l.loan_name} $${l.outstanding_principal_amount} at ${l.interest_rate_percentage}%`).join('; ') || 'none'}`;
      }
    } catch (e) {
      console.log('Financial context error:', e.message);
    }

    const systemPrompt = `You are Savyn AI — a friendly, witty personal financial advisor. Help users pay off debt faster and save more money.

Personality: warm, encouraging, slightly funny, use emojis naturally, make finance fun, keep responses 3-5 sentences, be specific with numbers, never preachy.

Commands you understand:
- "balance / how much saved" → show their savings balance
- "which loan first" → explain avalanche method with their specific data
- "when debt free" → calculate payoff timeline
- "how much can I save" → analyze checking vs expenses
- "save more / aggressive" → suggest increasing savings aggressiveness
- "pause" → explain how to pause in Profile tab

${financialContext}

Always end with something encouraging. Keep it real and fun! 💚`;

    const messages = [];
    if (history && history.length > 0) {
      history.slice(-8).forEach(h => {
        if (h.role === 'user' || h.role === 'assistant') {
          messages.push({ role: h.role, content: h.content });
        }
      });
    }
    messages.push({ role: 'user', content: message });

    const axiosResponse = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: systemPrompt,
      messages: messages
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    });

    const reply = axiosResponse.data.content?.[0]?.text || "Try asking that again! 💚";
    res.json({ reply });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ reply: "Oops! Try again in a moment! 😅" });
  }
});

// ── PAYOFF OPTIMIZER ──
app.get('/api/optimize', authenticateToken, async (req, res) => {
  try {
    const accessToken = await getUserAccessToken(req.user.userId);
    if (!accessToken) return res.status(400).json({ error: 'No bank account linked yet.' });

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Fetch balances and transactions — always available
    // Fetch liabilities safely — not all banks support this
    const [balRes, txRes] = await Promise.all([
      plaidClient.accountsBalanceGet({ access_token: accessToken }),
      plaidClient.transactionsGet({ access_token: accessToken, start_date: startDate, end_date: endDate }),
    ]);

    const liabilities = await getLiabilitiesSafe(accessToken);

    const accounts = balRes.data.accounts;
    const transactions = txRes.data.transactions;

    const checking = accounts.find(a => a.subtype === 'checking');
    const checkingBalance = checking ? (checking.balances.available || checking.balances.current || 0) : 0;

    // Calculate spending from transactions
    const totalSpend = transactions
      .filter(t => t.amount > 0 && !t.category?.includes('Transfer') && !t.category?.includes('Payment'))
      .reduce((sum, t) => sum + t.amount, 0);
    const avgMonthlySpend = totalSpend / 3;
    const safetyBuffer = avgMonthlySpend * 1.5;
    const disposable = Math.max(0, checkingBalance - safetyBuffer);

    // Get loans from liabilities
    const creditCards = liabilities.credit || [];
    const studentLoans = liabilities.student || [];

    // Also include credit accounts from balances (catches Amex etc.)
    const creditAccountsFromBalances = accounts.filter(a => a.type === 'credit');

    let allLoans = [
      ...creditCards.map(c => ({
        name: c.name || 'Credit Card',
        balance: c.last_statement_balance || c.current_balance || 0,
        apr: c.aprs?.[0]?.apr_percentage || 0,
        minPayment: c.minimum_payment_amount || 25,
        type: 'credit'
      })),
      ...studentLoans.map(l => ({
        name: l.loan_name || 'Student Loan',
        balance: l.outstanding_principal_amount || 0,
        apr: l.interest_rate_percentage || 0,
        minPayment: l.minimum_payment_amount || 100,
        type: 'student'
      }))
    ];

    // If no liability data, use credit account balances as fallback
    if (allLoans.length === 0 && creditAccountsFromBalances.length > 0) {
      allLoans = creditAccountsFromBalances.map(a => ({
        name: a.name || 'Credit Card',
        balance: Math.abs(a.balances.current || 0),
        apr: 20, // Default APR if unknown
        minPayment: Math.max(25, Math.round(Math.abs(a.balances.current || 0) * 0.02)),
        type: 'credit'
      }));
    }

    allLoans = allLoans.filter(l => l.balance > 0);
    allLoans.sort((a, b) => b.apr - a.apr);

    const topLoan = allLoans[0];

    if (!topLoan || disposable < 10) {
      return res.json({
        recommendation: null,
        message: disposable < 10 ? 'Your balance is running low — keep up with minimum payments for now.' : 'No loan balances found.',
        disposable: Math.round(disposable),
        checkingBalance: Math.round(checkingBalance),
        loans: allLoans,
        accounts: accounts.map(a => ({
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          balance: a.balances.current || 0,
          available: a.balances.available || 0
        }))
      });
    }

    const extraPayment = Math.max(10, Math.min(Math.round(disposable * 0.6), Math.round(topLoan.balance)));
    const monthlyRate = topLoan.apr / 100 / 12;

    let currentMonths, newMonths;
    if (monthlyRate > 0 && topLoan.minPayment > topLoan.balance * monthlyRate) {
      currentMonths = Math.log(topLoan.minPayment / (topLoan.minPayment - topLoan.balance * monthlyRate)) / Math.log(1 + monthlyRate);
      const newBalance = Math.max(0, topLoan.balance - extraPayment);
      newMonths = newBalance <= 0 ? 0 : Math.log(topLoan.minPayment / (topLoan.minPayment - newBalance * monthlyRate)) / Math.log(1 + monthlyRate);
    } else {
      currentMonths = topLoan.balance / (topLoan.minPayment || 1);
      newMonths = Math.max(0, topLoan.balance - extraPayment) / (topLoan.minPayment || 1);
    }

    const monthsSaved = Math.max(0, Math.round(currentMonths - newMonths));
    const interestSaved = Math.round(monthsSaved * topLoan.balance * monthlyRate);

    const payoffDate = new Date();
    payoffDate.setMonth(payoffDate.getMonth() + Math.max(1, Math.round(newMonths)));
    const payoffStr = payoffDate.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

    res.json({
      recommendation: {
        loanName: topLoan.name,
        apr: topLoan.apr,
        extraPayment,
        interestSaved: Math.max(0, interestSaved),
        monthsSaved,
        newPayoffDate: payoffStr,
        currentBalance: Math.round(topLoan.balance)
      },
      disposable: Math.round(disposable),
      checkingBalance: Math.round(checkingBalance),
      safetyBuffer: Math.round(safetyBuffer),
      loans: allLoans,
      totalDebt: Math.round(allLoans.reduce((s, l) => s + l.balance, 0)),
      accounts: accounts.map(a => ({
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        balance: a.balances.current || 0,
        available: a.balances.available || 0
      }))
    });

  } catch (err) {
    console.error('Optimizer error:', err.response ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: 'Optimizer failed: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Savyn backend running on port ${PORT}`);
});
