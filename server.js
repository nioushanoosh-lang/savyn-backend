require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(cors());
app.use(express.json());

const config = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SANDBOX_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(config);
let accessTokens = {};

app.get('/', (req, res) => res.json({ status: 'Savyn backend running' }));

app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'test-user-001' },
      client_name: 'Savyn',
      products: ['transactions', 'liabilities'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

app.post('/api/exchange-token', async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    accessTokens['test-user-001'] = response.data.access_token;
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

app.get('/api/balances', async (req, res) => {
  try {
    const accessToken = accessTokens['test-user-001'];
    if (!accessToken) return res.status(400).json({ error: 'No account linked yet' });
    const response = await plaidClient.accountsBalanceGet({ access_token: accessToken });
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get balances' });
  }
});

app.get('/api/liabilities', async (req, res) => {
  try {
    const accessToken = accessTokens['test-user-001'];
    if (!accessToken) return res.status(400).json({ error: 'No account linked yet' });
    const response = await plaidClient.liabilitiesGet({ access_token: accessToken });
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get liabilities' });
  }
});


app.get('/api/optimize', async (req, res) => {
  try {
    const accessToken = accessTokens['test-user-001'];
    if (!accessToken) return res.status(400).json({ error: 'No account linked yet' });
    const [balRes, txRes, liabRes] = await Promise.all([
      plaidClient.accountsBalanceGet({ access_token: accessToken }),
      plaidClient.transactionsGet({ access_token: accessToken, start_date: '2024-01-01', end_date: '2025-12-31' }),
      plaidClient.liabilitiesGet({ access_token: accessToken }),
    ]);
    const accounts = balRes.data.accounts;
    const transactions = txRes.data.transactions;
    const liabilities = liabRes.data.liabilities;
    const checking = accounts.find(a => a.subtype === 'checking');
    const checkingBalance = checking ? checking.balances.available : 0;
    const totalSpend = transactions.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
    const avgWeeklySpend = totalSpend / Math.max(1, transactions.length / 7);
    const safetyBuffer = avgWeeklySpend * 2;
    const disposable = Math.max(0, checkingBalance - safetyBuffer);
    const creditCards = liabilities.credit || [];
    const studentLoans = liabilities.student || [];
    let allLoans = [
      ...creditCards.map(c => ({ name: c.name || 'Credit Card', balance: c.last_statement_balance || 0, apr: c.aprs && c.aprs[0] ? c.aprs[0].apr_percentage : 0, minPayment: c.minimum_payment_amount || 0, type: 'credit' })),
      ...studentLoans.map(l => ({ name: l.loan_name || 'Student Loan', balance: l.outstanding_principal_amount || 0, apr: l.interest_rate_percentage || 0, minPayment: l.minimum_payment_amount || 0, type: 'student' }))
    ];
    allLoans.sort((a, b) => b.apr - a.apr);
    const topLoan = allLoans[0];
    if (!topLoan || disposable < 50) {
      return res.json({ recommendation: null, message: 'Not enough disposable income right now.', disposable: Math.round(disposable), loans: allLoans });
    }
    const extraPayment = Math.min(Math.round(disposable * 0.6), Math.round(topLoan.balance));
    const monthlyRate = topLoan.apr / 100 / 12;
    const currentMonths = monthlyRate > 0 ? Math.log(topLoan.minPayment / (topLoan.minPayment - topLoan.balance * monthlyRate)) / Math.log(1 + monthlyRate) : topLoan.balance / (topLoan.minPayment || 1);
    const newBalance = topLoan.balance - extraPayment;
    const newMonths = monthlyRate > 0 ? Math.log(topLoan.minPayment / (topLoan.minPayment - newBalance * monthlyRate)) / Math.log(1 + monthlyRate) : newBalance / (topLoan.minPayment || 1);
    const monthsSaved = Math.max(0, Math.round(currentMonths - newMonths));
    const interestSaved = Math.round(monthsSaved * topLoan.minPayment * (topLoan.apr / 100 / 12));
    const payoffDate = new Date();
    payoffDate.setMonth(payoffDate.getMonth() + Math.round(newMonths));
    const payoffStr = payoffDate.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    res.json({ recommendation: { loanName: topLoan.name, apr: topLoan.apr, extraPayment, interestSaved: Math.max(0, interestSaved), monthsSaved, newPayoffDate: payoffStr, currentBalance: Math.round(topLoan.balance) }, disposable: Math.round(disposable), checkingBalance: Math.round(checkingBalance), safetyBuffer: Math.round(safetyBuffer), loans: allLoans, message: 'Pay $' + extraPayment + ' extra on your ' + topLoan.name + ' today. You will save $' + Math.max(0, interestSaved) + ' in interest and finish ' + monthsSaved + ' months early.' });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Optimizer failed: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Savyn backend running on port ${PORT}`);
});
