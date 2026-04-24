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
    CREATE TABLE IF NOT EXISTS user_banks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      access_token TEXT NOT NULL,
      institution_name VARCHAR(255),
      institution_id VARCHAR(100),
      accounts JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_bills (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) UNIQUE,
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

// Get ALL access tokens for a user
async function getUserAccessTokens(userId) {
  // First check user_banks table (new multi-bank)
  const banksResult = await pool.query(
    'SELECT access_token, institution_name FROM user_banks WHERE user_id = $1 ORDER BY created_at ASC',
    [userId]
  );
  if (banksResult.rows.length > 0) {
    return banksResult.rows.map(r => ({ token: r.access_token, institution: r.institution_name }));
  }
  // Fall back to legacy single token
  const legacyResult = await pool.query('SELECT plaid_access_token FROM users WHERE id = $1', [userId]);
  if (legacyResult.rows.length > 0 && legacyResult.rows[0].plaid_access_token) {
    return [{ token: legacyResult.rows[0].plaid_access_token, institution: 'Bank' }];
  }
  return [];
}

// Safe liabilities fetch
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
      products: ['transactions'],
      optional_products: ['liabilities', 'auth'],
      country_codes: ['US'],
      language: 'en',
      redirect_uri: 'https://www.savynapp.com/Savyn.html',
      account_filters: {
        depository: { account_subtypes: ['checking', 'savings'] },
        credit: { account_subtypes: ['credit card'] }
      }
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
    const itemId = response.data.item_id;

    // Get institution info
    let institutionName = 'Bank';
    try {
      const itemRes = await plaidClient.itemGet({ access_token: accessToken });
      const instId = itemRes.data.item.institution_id;
      if (instId) {
        const instRes = await plaidClient.institutionsGetById({
          institution_id: instId,
          country_codes: ['US']
        });
        institutionName = instRes.data.institution.name;
      }
    } catch (e) {
      console.log('Could not get institution name:', e.message);
    }

    // Check if this institution already connected for this user
    const existing = await pool.query(
      'SELECT id FROM user_banks WHERE user_id = $1 AND institution_name = $2',
      [req.user.userId, institutionName]
    );

    if (existing.rows.length > 0) {
      // Update existing
      await pool.query(
        'UPDATE user_banks SET access_token = $1, updated_at = NOW() WHERE user_id = $2 AND institution_name = $3',
        [accessToken, req.user.userId, institutionName]
      );
    } else {
      // Insert new bank
      await pool.query(
        'INSERT INTO user_banks (user_id, access_token, institution_name, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())',
        [req.user.userId, accessToken, institutionName]
      );
    }

    // Also update legacy column for backward compat
    await pool.query(
      'UPDATE users SET plaid_access_token = $1 WHERE id = $2',
      [accessToken, req.user.userId]
    );

    res.json({ success: true, institution: institutionName });
  } catch (err) {
    console.error('Exchange token error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

// ── BALANCES — all connected banks ──
app.get('/api/balances', authenticateToken, async (req, res) => {
  try {
    const banks = await getUserAccessTokens(req.user.userId);
    if (banks.length === 0) return res.status(400).json({ error: 'No bank account linked. Please connect your bank first.' });

    let allAccounts = [];
    let itemInfo = null;

    for (const bank of banks) {
      try {
        const response = await plaidClient.accountsBalanceGet({ access_token: bank.token });
        const accounts = response.data.accounts.map(a => ({
          ...a,
          institution_name: bank.institution
        }));
        allAccounts = allAccounts.concat(accounts);
        if (!itemInfo) itemInfo = { institution_name: bank.institution, ...response.data.item };
      } catch (e) {
        console.log('Error fetching balances for', bank.institution, e.message);
      }
    }

    res.json({
      accounts: allAccounts,
      item: itemInfo || { institution_name: banks.map(b => b.institution).join(' + ') },
      connected_banks: banks.map(b => b.institution)
    });
  } catch (err) {
    console.error('Balances error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get balances' });
  }
});

// ── TRANSACTIONS — all connected banks ──
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const banks = await getUserAccessTokens(req.user.userId);
    if (banks.length === 0) return res.status(400).json({ error: 'No bank account linked.' });

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let allTransactions = [];
    for (const bank of banks) {
      try {
        const response = await plaidClient.transactionsGet({
          access_token: bank.token,
          start_date: startDate,
          end_date: endDate
        });
        allTransactions = allTransactions.concat(response.data.transactions);
      } catch (e) {
        console.log('Error fetching transactions for', bank.institution, e.message);
      }
    }

    res.json({ transactions: allTransactions });
  } catch (err) {
    console.error('Transactions error:', err.message);
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

// ── LIABILITIES ──
app.get('/api/liabilities', authenticateToken, async (req, res) => {
  try {
    const banks = await getUserAccessTokens(req.user.userId);
    if (banks.length === 0) return res.status(400).json({ error: 'No bank account linked.' });

    let allCredit = [], allStudent = [], allMortgage = [];
    for (const bank of banks) {
      const liabilities = await getLiabilitiesSafe(bank.token);
      allCredit = allCredit.concat(liabilities.credit || []);
      allStudent = allStudent.concat(liabilities.student || []);
      allMortgage = allMortgage.concat(liabilities.mortgage || []);
    }

    res.json({ liabilities: { credit: allCredit, student: allStudent, mortgage: allMortgage } });
  } catch (err) {
    console.error('Liabilities error:', err.message);
    res.status(500).json({ error: 'Failed to get liabilities' });
  }
});

// ── SAVYN AI CHAT ──
app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'No message provided' });

    let financialContext = 'No bank account connected yet.';
    try {
      const banks = await getUserAccessTokens(req.user.userId);
      if (banks.length > 0) {
        let allAccounts = [];
        let allCredit = [], allStudent = [];

        for (const bank of banks) {
          const balRes = await plaidClient.accountsBalanceGet({ access_token: bank.token });
          allAccounts = allAccounts.concat(balRes.data.accounts.map(a => ({ ...a, institution: bank.institution })));
          const liab = await getLiabilitiesSafe(bank.token);
          allCredit = allCredit.concat(liab.credit || []);
          allStudent = allStudent.concat(liab.student || []);
        }

        const checking = allAccounts.filter(a => a.subtype === 'checking');
        const savings = allAccounts.filter(a => a.subtype === 'savings');
        const creditAccounts = allAccounts.filter(a => a.type === 'credit');

        financialContext = `User real financial data:
Connected banks: ${banks.map(b => b.institution).join(', ')}
Checking accounts: ${checking.map(a => a.institution + ' $' + (a.balances.available || a.balances.current || 0).toLocaleString()).join(', ') || 'none'}
Savings accounts: ${savings.map(a => '$' + (a.balances.current || 0).toLocaleString()).join(', ') || 'none'}
Credit card accounts: ${creditAccounts.map(a => a.name + ' balance $' + Math.abs(a.balances.current || 0).toLocaleString()).join(', ') || 'none'}
Credit card liabilities: ${allCredit.map(c => c.name + ' $' + c.last_statement_balance + ' at ' + (c.aprs?.[0]?.apr_percentage || '?') + '% APR').join(', ') || 'none'}
Student loans: ${allStudent.map(l => l.loan_name + ' $' + l.outstanding_principal_amount + ' at ' + l.interest_rate_percentage + '%').join(', ') || 'none'}`;
      }
    } catch (e) {
      console.log('Financial context error:', e.message);
    }

    const systemPrompt = `You are Savyn AI — a friendly, witty personal financial advisor. Help users pay off debt faster and save more money.

Personality: warm, encouraging, slightly funny, use emojis naturally, make finance fun, keep responses 3-5 sentences, be specific with numbers, never preachy.

Commands: "balance" show savings, "which loan first" explain avalanche, "when debt free" calculate payoff, "save more" suggest aggressiveness increase.

${financialContext}

Always end with something encouraging. Keep it real and fun! 💚`;

    const messages = [];
    if (history && history.length > 0) {
      history.slice(-8).forEach(h => {
        if (h.role === 'user' || h.role === 'assistant') messages.push({ role: h.role, content: h.content });
      });
    }
    messages.push({ role: 'user', content: message });

    const axiosResponse = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: systemPrompt,
      messages
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

// ── PAYOFF OPTIMIZER — all connected banks ──
app.get('/api/optimize', authenticateToken, async (req, res) => {
  try {
    const banks = await getUserAccessTokens(req.user.userId);
    if (banks.length === 0) return res.status(400).json({ error: 'No bank account linked yet.' });

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let allAccounts = [];
    let allTransactions = [];
    let allCredit = [], allStudent = [];
    let connectedBanks = [];

    for (const bank of banks) {
      try {
        const [balRes, txRes] = await Promise.all([
          plaidClient.accountsBalanceGet({ access_token: bank.token }),
          plaidClient.transactionsGet({ access_token: bank.token, start_date: startDate, end_date: endDate })
        ]);
        const accounts = balRes.data.accounts.map(a => ({ ...a, institution: bank.institution }));
        allAccounts = allAccounts.concat(accounts);
        allTransactions = allTransactions.concat(txRes.data.transactions);
        connectedBanks.push({ institution: bank.institution, accountCount: accounts.length });

        const liab = await getLiabilitiesSafe(bank.token);
        allCredit = allCredit.concat(liab.credit || []);
        allStudent = allStudent.concat(liab.student || []);
      } catch (e) {
        console.log('Error fetching data for', bank.institution, e.message);
      }
    }

    // Calculate checking balance from ALL depository accounts
    const checkingAccounts = allAccounts.filter(a => a.type === 'depository');
    const checkingBalance = checkingAccounts.reduce((sum, a) => sum + (a.balances.available || a.balances.current || 0), 0);

    // Calculate spending from ALL transactions
    const totalSpend = allTransactions
      .filter(t => t.amount > 0 && !t.category?.includes('Transfer') && !t.category?.includes('Payment'))
      .reduce((sum, t) => sum + t.amount, 0);
    const avgMonthlySpend = totalSpend / 3;
    const safetyBuffer = avgMonthlySpend * 1.5;
    const disposable = Math.max(0, checkingBalance - safetyBuffer);

    // Build loans list from liabilities
    let allLoans = [
      ...allCredit.map(c => ({
        name: c.name || 'Credit Card',
        balance: c.last_statement_balance || c.current_balance || 0,
        apr: c.aprs?.[0]?.apr_percentage || 0,
        minPayment: c.minimum_payment_amount || 25,
        type: 'credit'
      })),
      ...allStudent.map(l => ({
        name: l.loan_name || 'Student Loan',
        balance: l.outstanding_principal_amount || 0,
        apr: l.interest_rate_percentage || 0,
        minPayment: l.minimum_payment_amount || 100,
        type: 'student'
      }))
    ];

    // Fallback: use credit account balances if no liability data
    if (allLoans.length === 0) {
      const creditAccounts = allAccounts.filter(a => a.type === 'credit');
      allLoans = creditAccounts.map(a => ({
        name: a.name || 'Credit Card',
        balance: Math.abs(a.balances.current || 0),
        apr: 20,
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
        message: disposable < 10 ? 'Your checking balance is running low. Keep up with minimum payments for now.' : 'No loan balances found.',
        disposable: Math.round(disposable),
        checkingBalance: Math.round(checkingBalance),
        loans: allLoans,
        connectedBanks,
        accounts: allAccounts.map(a => ({
          name: a.name,
          institution: a.institution,
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
      connectedBanks,
      accounts: allAccounts.map(a => ({
        name: a.name,
        institution: a.institution,
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


// ── USER SETTINGS ──
app.post('/api/settings', authenticateToken, async (req, res) => {
  try {
    const { aggressiveness, cc_monthly, quarterly_annual_monthly, irregular_expenses } = req.body;
    await pool.query(`
      INSERT INTO user_bills (user_id, aggressiveness, cc_monthly, quarterly_annual_monthly, irregular_expenses, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        aggressiveness = EXCLUDED.aggressiveness,
        cc_monthly = EXCLUDED.cc_monthly,
        quarterly_annual_monthly = EXCLUDED.quarterly_annual_monthly,
        irregular_expenses = EXCLUDED.irregular_expenses,
        updated_at = NOW()
    `, [req.user.userId, aggressiveness || 'moderate', cc_monthly || 0, quarterly_annual_monthly || 0, irregular_expenses || 0]);
    res.json({ success: true });
  } catch (err) {
    console.error('Settings error:', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

app.get('/api/settings', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM user_bills WHERE user_id = $1', [req.user.userId]);
    if (result.rows.length === 0) {
      return res.json({ aggressiveness: 'moderate', cc_monthly: 0, quarterly_annual_monthly: 0, irregular_expenses: 0 });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Savyn backend running on port ${PORT}`);
});
