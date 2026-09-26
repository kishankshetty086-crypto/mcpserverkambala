import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { exec } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

// -------------------------------------------------------------
// 1. CONFIGURATION
// -------------------------------------------------------------
const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  wcapiBaseUrl: (process.env.WCAPI_BASE_URL || 'https://rama.kambala.co.in').replace(/\/$/, ''),
  oauthAuthUrl: process.env.OAUTH_AUTH_URL || 'https://rama.kambala.co.in/NorenWeb2.0/authorize/oauth',
  clientId: process.env.CLIENT_ID || 'KKSINV_U',
  secretKey: process.env.SECRET_KEY || 'v7dEItTCfHurgCgnn0g3HfdlfsSOzVdd6uXFPBX2NsnFMx2Z9FKR0YYyzftOE605',
  redirectUri: process.env.REDIRECT_URI || 'http://localhost:3000/oauth/callback',
  sessionFile: path.resolve('.session.json'),
};

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------------------------------------------------------------
// 2. SESSION & AUTH HELPERS
// -------------------------------------------------------------
function getSession() {
  try {
    if (fs.existsSync(CONFIG.sessionFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.sessionFile, 'utf-8'));
    }
  } catch (e) {
    console.error('Error reading session file:', e);
  }
  return null;
}

function saveSession(data) {
  fs.writeFileSync(CONFIG.sessionFile, JSON.stringify(data, null, 2), 'utf-8');
}

function clearSession() {
  if (fs.existsSync(CONFIG.sessionFile)) {
    fs.unlinkSync(CONFIG.sessionFile);
  }
}

// -------------------------------------------------------------
// 3. KAMBALA WCAPI CALLER (jData format)
// -------------------------------------------------------------
async function callWcapi(endpoint, jData) {
  const session = getSession();
  if (!session || !session.susertoken) {
    throw new Error('Not logged in. Please click "Login with Kambala" to authenticate.');
  }

  const payload = `jData=${JSON.stringify(jData)}`;
  const url = `${CONFIG.wcapiBaseUrl}${endpoint}`;

  const response = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'text/plain',
      Authorization: `Bearer ${session.susertoken}`,
    },
    timeout: 12000,
  });

  const data = response.data;
  if (data && data.stat === 'Not_Ok') {
    throw new Error(data.emsg || 'WCAPI returned an error.');
  }
  return data;
}

// -------------------------------------------------------------
// 4. OAUTH ROUTES
// -------------------------------------------------------------
app.get('/login', (req, res) => {
  const loginUrl = `${CONFIG.oauthAuthUrl}?client_id=${CONFIG.clientId}&redirect_uri=${encodeURIComponent(CONFIG.redirectUri)}`;
  res.redirect(loginUrl);
});

app.get('/logout', (req, res) => {
  clearSession();
  res.redirect('/');
});

app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('<h2>OAuth Error: Missing code parameter.</h2><a href="/">Go Back</a>');
  }

  try {
    // Checksum: SHA256(Client_id + Secret_key + code)
    const combined = `${CONFIG.clientId}${CONFIG.secretKey}${code}`;
    const checksum = crypto.createHash('sha256').update(combined).digest('hex');
    const payload = `jData=${JSON.stringify({ code, checksum })}`;

    const tokenRes = await axios.post(`${CONFIG.wcapiBaseUrl}/NorenWClientAPI/GenAcsTok`, payload, {
      headers: { 'Content-Type': 'text/plain' },
    });

    const data = tokenRes.data;
    console.log('[OAuth Success] Full GenAcsTok response:', JSON.stringify(data));

    const token = data.access_token || data.susertoken;
    if (data.stat !== 'Ok' || !token) {
      throw new Error(data.emsg || 'Token generation failed');
    }

    const traderUid = data.uid || data.USERID || 'KKSINV';
    const traderActId = data.actid || traderUid;

    saveSession({
      ...data,
      susertoken: token,
      uid: traderUid,
      actid: traderActId,
      loginTime: new Date().toISOString(),
    });

    res.redirect('/?status=login_success');
  } catch (err) {
    res.status(500).send(`
      <body style="font-family:sans-serif; padding:40px; text-align:center;">
        <h2 style="color:#ef4444;">Login Failed</h2>
        <p>${err.message}</p>
        <a href="/" style="color:#2563eb; text-decoration:none;">Return to App</a>
      </body>
    `);
  }
});

app.get('/api/session', (req, res) => {
  const session = getSession();
  res.json({
    isLoggedIn: !!(session && session.susertoken),
    clientId: CONFIG.clientId,
    loginTime: session?.loginTime,
  });
});

// -------------------------------------------------------------
// 5. NATURAL LANGUAGE AI TRADING HANDLER
// -------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  const prompt = (req.body.message || '').trim();
  const lower = prompt.toLowerCase();

  try {
    const session = getSession();
    if (!session || !session.susertoken) {
      return res.json({
        type: 'auth_required',
        reply: 'You are currently not logged in to your Kambala broker account. Please click the **Login with Kambala** button above to authenticate.',
      });
    }

    const uid = session.uid || CONFIG.clientId;
    const actid = session.actid || uid;

    // 1. Account Funds / Limits
    if (lower.includes('fund') || lower.includes('balance') || lower.includes('limit') || lower.includes('margin available') || lower.includes('cash')) {
      const data = await callWcapi('/NorenWClientAPI/Limits', { uid, actid });
      const cash = parseFloat(data.cash || '0').toFixed(2);
      const marginused = parseFloat(data.marginused || '0').toFixed(2);
      const payin = parseFloat(data.payin || '0').toFixed(2);

      return res.json({
        type: 'limits',
        reply: `Here are your account funds and margin limits:`,
        data: {
          cash: `₹${cash}`,
          marginUsed: `₹${marginused}`,
          payin: `₹${payin}`,
          raw: data,
        },
      });
    }

    // 2. Positions Book
    if (lower.includes('position') || lower.includes('pnl') || lower.includes('p&l') || lower.includes('mtm') || lower.includes('open trade')) {
      const data = await callWcapi('/NorenWClientAPI/PositionsBook', { uid, actid });
      if (!Array.isArray(data) || data.length === 0) {
        return res.json({
          type: 'text',
          reply: 'You currently have **no open positions** today.',
        });
      }
      return res.json({
        type: 'positions',
        reply: `Found ${data.length} position(s):`,
        positions: data.map((p) => ({
          symbol: p.tsym,
          netQty: p.netqty,
          buyQty: p.daybuyqty,
          sellQty: p.daysellqty,
          pnl: p.urmtom || p.rpnl || '0.00',
          product: p.prd,
        })),
      });
    }

    // 3. Demat Holdings
    if (lower.includes('holding') || lower.includes('portfolio') || lower.includes('shares') || lower.includes('stocks')) {
      const data = await callWcapi('/NorenWClientAPI/Holdings', { uid, actid });
      if (!Array.isArray(data) || data.length === 0) {
        return res.json({
          type: 'text',
          reply: 'Your Demat holdings list is currently empty.',
        });
      }
      return res.json({
        type: 'holdings',
        reply: `You have ${data.length} holding(s) in your portfolio:`,
        holdings: data.map((h) => ({
          symbol: h.exch_tsym?.[0]?.tsym || h.tsym || 'Unknown',
          quantity: h.holdqty || h.qty || '0',
          closePrice: h.upldprc || '0.00',
        })),
      });
    }

    // 4. Order Book
    if (lower.includes('order') && (lower.includes('book') || lower.includes('status') || lower.includes('pending') || lower.includes('today') || lower.includes('list') || lower.includes('show'))) {
      const data = await callWcapi('/NorenWClientAPI/OrderBook', { uid });
      if (!Array.isArray(data) || data.length === 0) {
        return res.json({
          type: 'text',
          reply: 'No orders have been placed today in your order book.',
        });
      }
      return res.json({
        type: 'orders',
        reply: `Found ${data.length} order(s) for today:`,
        orders: data.map((o) => ({
          norenordno: o.norenordno,
          symbol: o.tsym,
          side: o.trantype === 'B' ? 'BUY' : 'SELL',
          qty: o.qty,
          price: o.prc,
          status: o.status,
          time: o.norentm,
        })),
      });
    }

    // 5. Search Scrips / Stock Quote
    if (lower.startsWith('search ') || lower.startsWith('quote ') || lower.startsWith('price of ')) {
      const query = prompt.replace(/^(search|quote|price of)\s+/i, '').trim().toUpperCase();
      const searchRes = await callWcapi('/NorenWClientAPI/SearchScrips', { uid, exch: 'NSE', stext: query });

      if (searchRes.values && searchRes.values.length > 0) {
        const first = searchRes.values[0];
        let quote = null;
        try {
          quote = await callWcapi('/NorenWClientAPI/GetQuotes', { uid, exch: 'NSE', token: first.token });
        } catch (e) {
          // Quote fallback
        }

        return res.json({
          type: 'quote',
          reply: `Here is the market information for **${first.tsym}**:`,
          quote: {
            symbol: first.tsym,
            token: first.token,
            exchange: 'NSE',
            cname: first.cname,
            ltp: quote?.lp ? `₹${quote.lp}` : 'N/A',
            open: quote?.o || 'N/A',
            high: quote?.h || 'N/A',
            low: quote?.l || 'N/A',
            close: quote?.c || 'N/A',
          },
        });
      } else {
        return res.json({
          type: 'text',
          reply: `Could not find any scrips matching "${query}" on NSE.`,
        });
      }
    }

    // 6. Natural Language Order Intent: e.g. "Buy 10 Reliance at 2800" or "Sell 5 INFY at market"
    const orderMatch = lower.match(/(buy|sell)\s+(\d+)\s+([a-zA-Z0-9_\-\.]+)(?:\s+(?:at|@)\s+(\d+(?:\.\d+)?|\bmarket\b))?/i);
    if (orderMatch) {
      const side = orderMatch[1].toUpperCase() === 'BUY' ? 'B' : 'S';
      const qty = parseInt(orderMatch[2], 10);
      let symbol = orderMatch[3].toUpperCase();
      if (!symbol.includes('-') && !symbol.includes('CE') && !symbol.includes('PE')) {
        symbol = `${symbol}-EQ`;
      }
      const rawPrice = orderMatch[4];
      const isMarket = !rawPrice || rawPrice.toLowerCase() === 'market' || rawPrice === '0';
      const price = isMarket ? 0 : parseFloat(rawPrice);
      const prctyp = isMarket ? 'MKT' : 'LMT';

      // Margin verification
      let marginInfo = null;
      try {
        marginInfo = await callWcapi('/NorenWClientAPI/OrderMargin', {
          uid,
          actid,
          exch: 'NSE',
          tsym: symbol,
          qty: String(qty),
          prc: String(price),
          prd: 'I', // default intraday MIS
          trantype: side,
          prctyp,
        });
      } catch (e) {
        console.warn('Margin check note:', e.message);
      }

      return res.json({
        type: 'order_preview',
        reply: `I have prepared the order and simulated the margin requirement. **Please review and confirm below:**`,
        order: {
          exchange: 'NSE',
          symbol,
          side: side === 'B' ? 'BUY' : 'SELL',
          quantity: qty,
          price: isMarket ? 'MARKET' : `₹${price}`,
          rawPrice: price,
          product: 'I (Intraday MIS)',
          priceType: prctyp,
          marginRequired: marginInfo?.ordermargin ? `₹${marginInfo.ordermargin}` : 'Calculated by RMS',
          cashAvailable: marginInfo?.cash ? `₹${marginInfo.cash}` : 'Sufficient',
        },
      });
    }

    // Default Fallback
    return res.json({
      type: 'text',
      reply: `I can help you monitor and trade on your Kambala account. Try asking me:\n\n` +
        `• *"Show my funds & available balance"*\n` +
        `• *"What are my open positions today?"*\n` +
        `• *"Show my demat holdings"*\n` +
        `• *"Show today's order book"*\n` +
        `• *"Quote RELIANCE"*\n` +
        `• *"Buy 10 TATASTEEL at 160"*`,
    });
  } catch (err) {
    return res.json({
      type: 'error',
      reply: `Error communicating with WCAPI: ${err.message}`,
    });
  }
});

// -------------------------------------------------------------
// 6. ORDER EXECUTION ROUTE (Triggered on User Confirmation Click)
// -------------------------------------------------------------
app.post('/api/execute-order', async (req, res) => {
  try {
    const session = getSession();
    if (!session || !session.susertoken) {
      return res.status(401).json({ stat: 'Not_Ok', emsg: 'Session expired. Please log in again.' });
    }

    const { exchange, symbol, side, quantity, price, priceType } = req.body;
    const uid = session.uid || CONFIG.clientId;
    const actid = session.actid || uid;

    const orderPayload = {
      uid,
      actid,
      exch: exchange || 'NSE',
      tsym: symbol,
      qty: String(quantity),
      prc: String(price || '0'),
      prd: 'I',
      trantype: side === 'BUY' ? 'B' : 'S',
      prctyp: priceType || (price === 0 ? 'MKT' : 'LMT'),
      ret: 'DAY',
      remarks: 'AI_WEB_ORDER',
      ordersource: 'WEB',
    };

    const result = await callWcapi('/NorenWClientAPI/PlaceOrder', orderPayload);
    res.json(result);
  } catch (err) {
    res.status(500).json({ stat: 'Not_Ok', emsg: err.message });
  }
});

// -------------------------------------------------------------
// 7. EMBEDDED SINGLE-PAGE WEB CHAT UI (Zero Setup for User)
// -------------------------------------------------------------
app.get('/', (req, res) => {
  const session = getSession();
  const isLoggedIn = !!(session && session.susertoken);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kambala AI Trading Assistant</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
    body { background-color: #0f172a; color: #f8fafc; height: 100vh; display: flex; flex-direction: column; }
    
    /* Header */
    header {
      background: #1e293b;
      padding: 16px 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #334155;
    }
    .logo-area { display: flex; align-items: center; gap: 12px; }
    .logo-badge { background: #3b82f6; color: white; padding: 6px 12px; border-radius: 8px; font-weight: 700; font-size: 14px; }
    .logo-title { font-size: 18px; font-weight: 600; color: #f1f5f9; }
    
    .status-area { display: flex; align-items: center; gap: 14px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
    }
    .badge-online { background: #064e3b; color: #34d399; border: 1px solid #059669; }
    .badge-offline { background: #450a0a; color: #f87171; border: 1px solid #dc2626; }
    .btn-login {
      background: #2563eb;
      color: white;
      text-decoration: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      transition: background 0.2s;
    }
    .btn-login:hover { background: #1d4ed8; }
    .btn-logout {
      background: #334155;
      color: #94a3b8;
      text-decoration: none;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 13px;
    }
    .btn-logout:hover { background: #475569; color: white; }

    /* Main Container */
    .main-container { display: flex; flex: 1; overflow: hidden; }

    /* Sidebar Quick Actions */
    .sidebar {
      width: 280px;
      background: #1e293b;
      border-right: 1px solid #334155;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .sidebar-title { font-size: 12px; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 6px; }
    .quick-btn {
      background: #0f172a;
      border: 1px solid #334155;
      color: #cbd5e1;
      padding: 12px;
      border-radius: 8px;
      text-align: left;
      cursor: pointer;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 10px;
      transition: all 0.2s;
    }
    .quick-btn:hover { background: #2563eb; color: white; border-color: #2563eb; }

    /* Chat Area */
    .chat-container { flex: 1; display: flex; flex-direction: column; background: #0b1120; }
    .messages-box { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 18px; }

    .msg { max-width: 80%; padding: 14px 18px; border-radius: 12px; font-size: 14px; line-height: 1.6; }
    .msg-user { align-self: flex-end; background: #2563eb; color: white; border-bottom-right-radius: 2px; }
    .msg-bot { align-self: flex-start; background: #1e293b; color: #f1f5f9; border-bottom-left-radius: 2px; border: 1px solid #334155; }

    /* Cards */
    .card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 14px; margin-top: 10px; }
    .card-title { font-size: 13px; color: #94a3b8; margin-bottom: 6px; font-weight: 500; }
    .card-value { font-size: 18px; font-weight: 700; color: #f8fafc; }
    
    .table-custom { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
    .table-custom th { text-align: left; padding: 8px; color: #94a3b8; border-bottom: 1px solid #334155; }
    .table-custom td { padding: 8px; border-bottom: 1px solid #1e293b; }
    .text-green { color: #34d399; font-weight: 600; }
    .text-red { color: #f87171; font-weight: 600; }

    /* Order Confirmation Card */
    .order-card {
      background: #1e1b4b;
      border: 1px solid #6366f1;
      border-radius: 10px;
      padding: 16px;
      margin-top: 12px;
    }
    .order-title { color: #a5b4fc; font-weight: 600; font-size: 14px; margin-bottom: 8px; }
    .order-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px; }
    .btn-confirm {
      width: 100%;
      background: #10b981;
      color: white;
      border: none;
      padding: 10px;
      border-radius: 6px;
      font-weight: 600;
      margin-top: 12px;
      cursor: pointer;
    }
    .btn-confirm:hover { background: #059669; }

    /* Input Box */
    .input-bar {
      padding: 18px 24px;
      background: #1e293b;
      border-top: 1px solid #334155;
      display: flex;
      gap: 12px;
    }
    .input-bar input {
      flex: 1;
      background: #0f172a;
      border: 1px solid #334155;
      color: white;
      padding: 14px 18px;
      border-radius: 10px;
      font-size: 14px;
      outline: none;
    }
    .input-bar input:focus { border-color: #3b82f6; }
    .input-bar button {
      background: #2563eb;
      color: white;
      border: none;
      padding: 0 24px;
      border-radius: 10px;
      font-weight: 600;
      cursor: pointer;
    }
    .input-bar button:hover { background: #1d4ed8; }
  </style>
</head>
<body>

  <header>
    <div class="logo-area">
      <span class="logo-badge">WCAPI AI</span>
      <span class="logo-title">Kambala AI Trading Assistant</span>
    </div>
    <div class="status-area">
      ${
        isLoggedIn
          ? `<span class="badge badge-online">● Connected (${CONFIG.clientId})</span>
             <a href="/logout" class="btn-logout">Logout</a>`
          : `<span class="badge badge-offline">● Not Logged In</span>
             <a href="/login" class="btn-login">Login with Kambala</a>`
      }
    </div>
  </header>

  <div class="main-container">
    <!-- Sidebar -->
    <div class="sidebar">
      <div class="sidebar-title">Quick Actions</div>
      <button class="quick-btn" onclick="sendPrompt('Show my funds and available margin')">💰 Check Available Funds</button>
      <button class="quick-btn" onclick="sendPrompt('Show my open positions and P&L')">📊 View Open Positions</button>
      <button class="quick-btn" onclick="sendPrompt('Show my Demat portfolio holdings')">📈 Demat Holdings</button>
      <button class="quick-btn" onclick="sendPrompt('Show today order book')">📑 View Order Book</button>
      <button class="quick-btn" onclick="sendPrompt('Quote RELIANCE')">🔍 Quote Reliance</button>
      <button class="quick-btn" onclick="sendPrompt('Buy 10 TATASTEEL at market')">⚡ Place Test Order</button>
    </div>

    <!-- Chat Area -->
    <div class="chat-container">
      <div class="messages-box" id="messagesBox">
        <div class="msg msg-bot">
          Hello! I am your AI Trading Assistant connected to Kambala WCAPI. ${
            isLoggedIn
              ? 'Your account is **connected and ready**. What would you like to analyze or trade today?'
              : 'Please click **Login with Kambala** above to authenticate with your broker credentials.'
          }
        </div>
      </div>

      <div class="input-bar">
        <input type="text" id="userInput" placeholder="Ask anything in English: 'Show funds', 'Open positions', or 'Buy 10 INFY at 1800'..." onkeypress="handleKey(event)">
        <button onclick="handleSend()">Send</button>
      </div>
    </div>
  </div>

  <script>
    const box = document.getElementById('messagesBox');
    const input = document.getElementById('userInput');

    function handleKey(e) {
      if (e.key === 'Enter') handleSend();
    }

    function sendPrompt(text) {
      input.value = text;
      handleSend();
    }

    async function handleSend() {
      const text = input.value.trim();
      if (!text) return;

      appendUserMsg(text);
      input.value = '';

      const loadingId = appendBotMsg('Analyzing and querying WCAPI...');

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text })
        });
        const data = await res.json();
        removeLoading(loadingId);
        renderBotResponse(data);
      } catch (err) {
        removeLoading(loadingId);
        appendBotMsg('Connection error: ' + err.message);
      }
    }

    function appendUserMsg(text) {
      const div = document.createElement('div');
      div.className = 'msg msg-user';
      div.innerText = text;
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
    }

    function appendBotMsg(text) {
      const id = 'msg-' + Date.now();
      const div = document.createElement('div');
      div.id = id;
      div.className = 'msg msg-bot';
      div.innerHTML = text.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
      return id;
    }

    function removeLoading(id) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }

    function renderBotResponse(res) {
      const div = document.createElement('div');
      div.className = 'msg msg-bot';

      let html = '<p>' + (res.reply || '').replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>').replace(/\\n/g, '<br>') + '</p>';

      if (res.type === 'limits') {
        html += \`
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px;">
            <div class="card">
              <div class="card-title">Available Cash</div>
              <div class="card-value text-green">\${res.data.cash}</div>
            </div>
            <div class="card">
              <div class="card-title">Margin Used</div>
              <div class="card-value text-red">\${res.data.marginUsed}</div>
            </div>
          </div>
        \`;
      } else if (res.type === 'positions') {
        html += \`
          <table class="table-custom">
            <thead><tr><th>Symbol</th><th>Qty</th><th>Product</th><th>P&L</th></tr></thead>
            <tbody>
              \${res.positions.map(p => \`
                <tr>
                  <td><strong>\${p.symbol}</strong></td>
                  <td>\${p.netQty}</td>
                  <td>\${p.product}</td>
                  <td class="\${parseFloat(p.pnl) >= 0 ? 'text-green' : 'text-red'}">₹\${p.pnl}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } else if (res.type === 'holdings') {
        html += \`
          <table class="table-custom">
            <thead><tr><th>Stock</th><th>Qty</th><th>Avg Price</th></tr></thead>
            <tbody>
              \${res.holdings.map(h => \`
                <tr>
                  <td><strong>\${h.symbol}</strong></td>
                  <td>\${h.quantity}</td>
                  <td>₹\${h.closePrice}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } else if (res.type === 'orders') {
        html += \`
          <table class="table-custom">
            <thead><tr><th>Order ID</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Status</th></tr></thead>
            <tbody>
              \${res.orders.map(o => \`
                <tr>
                  <td>\${o.norenordno}</td>
                  <td>\${o.symbol}</td>
                  <td class="\${o.side === 'BUY' ? 'text-green' : 'text-red'}">\${o.side}</td>
                  <td>\${o.qty}</td>
                  <td>\${o.price}</td>
                  <td><strong>\${o.status}</strong></td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } else if (res.type === 'quote') {
        const q = res.quote;
        html += \`
          <div class="card" style="margin-top:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div>
                <h3 style="font-size:16px; color:#f8fafc;">\${q.symbol} (\${q.exchange})</h3>
                <p style="color:#94a3b8; font-size:12px;">\${q.cname || ''}</p>
              </div>
              <div style="font-size:22px; font-weight:700; color:#38bdf8;">\${q.ltp}</div>
            </div>
            <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; margin-top:12px; font-size:12px;">
              <div><span style="color:#94a3b8;">Open:</span> \${q.open}</div>
              <div><span style="color:#94a3b8;">High:</span> \${q.high}</div>
              <div><span style="color:#94a3b8;">Low:</span> \${q.low}</div>
              <div><span style="color:#94a3b8;">Close:</span> \${q.close}</div>
            </div>
          </div>
        \`;
      } else if (res.type === 'order_preview') {
        const o = res.order;
        const orderData = encodeURIComponent(JSON.stringify(o));
        html += \`
          <div class="order-card">
            <div class="order-title">⚡ Pre-Trade Confirmation Required</div>
            <div class="order-row"><span>Action:</span> <strong class="\${o.side === 'BUY' ? 'text-green' : 'text-red'}">\${o.side}</strong></div>
            <div class="order-row"><span>Symbol:</span> <strong>\${o.symbol}</strong></div>
            <div class="order-row"><span>Quantity:</span> <strong>\${o.quantity}</strong></div>
            <div class="order-row"><span>Price:</span> <strong>\${o.price} (\${o.priceType})</strong></div>
            <div class="order-row"><span>Product:</span> <strong>\${o.product}</strong></div>
            <div class="order-row"><span>Margin Required:</span> <strong style="color:#f59e0b;">\${o.marginRequired}</strong></div>
            <button class="btn-confirm" onclick="confirmOrder('\${orderData}', this)">Confirm & Place Order</button>
          </div>
        \`;
      }

      div.innerHTML = html;
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
    }

    async function confirmOrder(encodedData, btn) {
      btn.disabled = true;
      btn.innerText = 'Dispatching to OMS...';
      const order = JSON.parse(decodeURIComponent(encodedData));

      try {
        const res = await fetch('/api/execute-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(order)
        });
        const result = await res.json();

        if (result.stat === 'Ok') {
          btn.style.background = '#059669';
          btn.innerText = '✓ Order Placed! (Noren ID: ' + result.norenordno + ')';
        } else {
          btn.style.background = '#dc2626';
          btn.innerText = 'Order Rejected: ' + (result.emsg || 'Unknown error');
        }
      } catch (e) {
        btn.style.background = '#dc2626';
        btn.innerText = 'Execution Failed: ' + e.message;
      }
    }
  </script>
</body>
</html>
`);
});

// -------------------------------------------------------------
// 8. START SERVER & AUTO-OPEN BROWSER
// -------------------------------------------------------------
app.listen(CONFIG.port, () => {
  const url = `http://localhost:${CONFIG.port}`;
  console.log(`\n======================================================`);
  console.log(`  Kambala AI Trading Assistant Running`);
  console.log(`  URL: ${url}`);
  console.log(`======================================================\n`);

  // Automatically open browser on Windows/Mac/Linux
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
});
