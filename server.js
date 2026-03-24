require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(cors());
app.use(express.json());

const config = new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SANDBOX_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(config);

let accessTokens = {};

app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'test-user-001' },
      client_name: 'FinAdvisor',
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
    const accessToken = response.data.access_token;
    accessTokens['test-user-001'] = accessToken;
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

app.get('/api/transactions', async (req, res) => {
  try {
    const accessToken = accessTokens['test-user-001'];
    if (!accessToken) return res.status(400).json({ error: 'No account linked yet' });
    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: '2024-01-01',
      end_date: '2024-12-31',
    });
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get transactions' });
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

app.listen(process.env.PORT, () => {
  console.log(`FinAdvisor backend running on http://localhost:${process.env.PORT}`);
});
