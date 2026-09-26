import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { WcapiClient } from './wcapiClient.js';
import { getStoredSession, saveSession, exchangeCodeForToken } from './auth.js';
import { config } from './config.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// Enable CORS for Claude Web (claude.ai)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const client = new WcapiClient();

// Map to store active SSE transports by sessionId
const transports = new Map<string, SSEServerTransport>();

function createTradingMcpServer(reqHost?: string) {
  const server = new McpServer({
    name: 'kambala-trading',
    version: '1.0.0',
  });

  function jsonResponse(data: any) {
    return {
      content: [
        {
          type: 'text' as const,
          text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  function getLoginUrl() {
    return reqHost
      ? `https://${reqHost}/oauth/kambala`
      : `${config.oauthAuthUrl}?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(config.redirectUri)}`;
  }

  function errorResponse(err: any) {
    const errMsg = err?.message || String(err);
    const isAuthError =
      errMsg.includes('Session Expired') ||
      errMsg.includes('Invalid Session Key') ||
      errMsg.includes('Not authenticated') ||
      errMsg.includes('Token generation failed') ||
      errMsg.includes('401') ||
      errMsg.includes('403');

    if (isAuthError) {
      const loginUrl = getLoginUrl();
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text:
              `⚠️ KAMBALA SESSION EXPIRED / AUTHENTICATION REQUIRED\n\n` +
              `Your Kambala WCAPI session is not active. Please provide this login link to the user:\n\n` +
              `👉 [Click here to Log in to Kambala](${loginUrl})\n\n` +
              `Or direct URL: ${loginUrl}\n\n` +
              `Once the user logs in with their Kambala User ID, Password, and TOTP, the session token will be saved automatically.\n\n` +
              `(Diagnostic reason: ${errMsg})`,
          },
        ],
      };
    }

    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `Error: ${errMsg}`,
        },
      ],
    };
  }

  // 0. Get Login URL
  server.tool(
    'get_login_url',
    'Get the Kambala OAuth login link to sign in or renew an expired session.',
    {},
    async () => {
      const loginUrl = getLoginUrl();
      return jsonResponse({
        action: 'LOGIN_REQUIRED',
        loginUrl: loginUrl,
        instruction: `Click this link to authenticate with Kambala: ${loginUrl}. Once signed in, you can query your portfolio and place orders.`,
      });
    }
  );

  // 1. Account Profile
  server.tool('get_user_profile', 'Get logged-in trader account profile and trading segment details.', {}, async () => {
    try {
      const data = await client.getUserDetails();
      return jsonResponse(data);
    } catch (e: any) {
      return errorResponse(e);
    }
  });

  // 2. Account Limits
  server.tool('get_account_limits', 'Retrieve available cash, margin used, and collateral limits.', {}, async () => {
    try {
      const data = await client.getLimits();
      return jsonResponse(data);
    } catch (e: any) {
      return errorResponse(e);
    }
  });

  // 3. Demat Holdings
  server.tool('get_holdings', 'Retrieve long-term Demat portfolio holdings and stock quantities.', {}, async () => {
    try {
      const data = await client.getHoldings();
      return jsonResponse(data);
    } catch (e: any) {
      return errorResponse(e);
    }
  });

  // 4. Open Positions
  server.tool('get_positions', 'Retrieve real-time open intraday and F&O positions with MTM P&L.', {}, async () => {
    try {
      const data = await client.getPositions();
      return jsonResponse(data);
    } catch (e: any) {
      return errorResponse(e);
    }
  });

  // 5. Order Book
  server.tool('get_order_book', 'Retrieve today complete order book (pending, executed, cancelled).', {}, async () => {
    try {
      const data = await client.getOrderBook();
      return jsonResponse(data);
    } catch (e: any) {
      return errorResponse(e);
    }
  });

  // 6. Search Scrip
  server.tool(
    'search_symbols',
    'Search for stocks or contracts across exchanges (NSE, BSE, NFO, MCX). Returns token and trading symbol.',
    {
      exchange: z.enum(['NSE', 'BSE', 'NFO', 'MCX']).describe('Exchange'),
      searchText: z.string().describe('Search keyword (e.g. RELIANCE, TATASTEEL)'),
    },
    async ({ exchange, searchText }) => {
      try {
        const data = await client.searchScrips(exchange, searchText);
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(e);
      }
    }
  );

  // 7. Get Quotes
  server.tool(
    'get_market_quote',
    'Retrieve live market quote including LTP, OHLC, and depth for an instrument token.',
    {
      exchange: z.enum(['NSE', 'BSE', 'NFO', 'MCX']).describe('Exchange'),
      token: z.string().describe('Scrip token (e.g. 2885 for Reliance)'),
    },
    async ({ exchange, token }) => {
      try {
        const data = await client.getQuotes(exchange, token);
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(e);
      }
    }
  );

  // 8. Prepare Order (Pre-Trade Guard)
  server.tool(
    'prepare_order',
    'Simulate and prepare an order ticket with margin verification before execution.',
    {
      exchange: z.enum(['NSE', 'BSE', 'NFO', 'MCX']).describe('Exchange'),
      tradingSymbol: z.string().describe('Exact trading symbol (e.g. RELIANCE-EQ)'),
      quantity: z.number().int().positive().describe('Quantity of shares'),
      price: z.number().nonnegative().describe('Order price (0 for Market)'),
      product: z.enum(['C', 'M', 'I', 'F']).describe('C (Delivery), I (Intraday MIS), M (Margin)'),
      transactionType: z.enum(['B', 'S']).describe('B (BUY) or S (SELL)'),
      priceType: z.enum(['LMT', 'MKT', 'SL-LMT']).describe('Price type'),
    },
    async (args) => {
      return jsonResponse({
        action: 'ORDER_PREVIEW_CONFIRMATION_REQUIRED',
        orderSummary: {
          side: args.transactionType === 'B' ? 'BUY' : 'SELL',
          symbol: args.tradingSymbol,
          quantity: args.quantity,
          price: args.price === 0 ? 'MARKET' : `₹${args.price}`,
          product: args.product,
          priceType: args.priceType,
        },
        instructionForClaude: 'Ask the user to confirm this order before executing.',
      });
    }
  );

  // 9. Execute Order
  server.tool(
    'execute_order',
    'Execute a confirmed trading order directly to Kambala OMS/RMS.',
    {
      exchange: z.enum(['NSE', 'BSE', 'NFO', 'MCX']).describe('Exchange'),
      tradingSymbol: z.string().describe('Exact trading symbol'),
      quantity: z.number().int().positive().describe('Quantity of shares'),
      price: z.number().nonnegative().describe('Order price (0 for Market)'),
      product: z.enum(['C', 'M', 'I', 'F']).describe('C (Delivery), I (Intraday), M (Margin)'),
      transactionType: z.enum(['B', 'S']).describe('B (BUY) or S (SELL)'),
      priceType: z.enum(['LMT', 'MKT', 'SL-LMT']).describe('Price type'),
    },
    async (args) => {
      try {
        const data = await client.placeOrder({
          exch: args.exchange,
          tsym: args.tradingSymbol,
          qty: args.quantity,
          prc: args.price,
          prd: args.product,
          trantype: args.transactionType,
          prctyp: args.priceType,
          remarks: 'CLAUDE_MCP_ORDER',
        });
        return jsonResponse(data);
      } catch (e: any) {
        return errorResponse(e);
      }
    }
  );

  return server;
}

// Global HTTP Request Logger
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  next();
});

// -------------------------------------------------------------
// SSE ROUTES (FOR CLAUDE CONNECTORS)
// -------------------------------------------------------------

// 1. Establish SSE Stream (handles /, /sse, /mcp)
app.get(['/', '/sse', '/mcp'], async (req, res) => {
  // If GET / is requested by a normal browser without SSE Accept header, return health JSON
  if (req.path === '/' && !req.headers.accept?.includes('text/event-stream')) {
    return res.status(200).json({
      status: 'ok',
      name: 'kambala-trading',
      version: '1.0.0',
      auth: 'none',
      description: 'Kambala Solutions Remote MCP Server for Claude (No Sign-In Required)',
      endpoints: {
        root: '/',
        sse: '/sse',
        mcp: '/mcp',
        messages: '/messages',
      },
    });
  }

  console.log(`[SSE] New connection from Claude client on ${req.path}`);
  const server = createTradingMcpServer(req.get('host'));
  const transport = new SSEServerTransport('/messages', res);

  transports.set(transport.sessionId, transport);

  req.on('close', () => {
    console.log(`[SSE] Session closed: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

// 2. Handle incoming client messages
app.post(['/', '/messages', '/sse', '/mcp'], async (req, res) => {
  const sessionId = (req.query.sessionId as string) || (req.headers['x-session-id'] as string);
  console.log(`[POST] Received message for sessionId: ${sessionId}`);
  const transport = sessionId ? transports.get(sessionId) : transports.values().next().value;

  if (!transport) {
    console.warn(`[POST] No active SSE transport found for sessionId: ${sessionId}`);
    res.status(404).json({ error: 'Session not found or expired' });
    return;
  }

  try {
    // IMPORTANT: Pass req.body as the 3rd argument (parsedBody).
    // Otherwise handlePostMessage tries to read the already-consumed req stream, causing HTTP 400!
    await transport.handlePostMessage(req, res, req.body);
    console.log(`[POST] Handled message for sessionId: ${sessionId}`);
  } catch (err: any) {
    console.error(`[POST] Error in handlePostMessage:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// 3. Health check & MCP Discovery routes
app.get('/.well-known/mcp', (req, res) => {
  res.status(200).json({
    mcp_version: '1.0.0',
    transport: 'sse',
    endpoint: '/sse',
    auth: {
      type: 'none',
    },
  });
});

// Explicitly return 404 for OAuth discovery so Claude confirms the server requires NO sign-in
app.all(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/.well-known/oauth-protected-resource'], (req, res) => {
  res.status(404).json({ error: 'OAuth not required. This server uses direct authenticated session.' });
});

// 4. Web Session Manager UI (for cloud deployments like Render)
app.get('/login', (req, res) => {
  const session = getStoredSession();
  const isEnvActive = Boolean(process.env.SUSERTOKEN);
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Kambala MCP - Session Manager</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; max-width: 520px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        h1 { font-size: 22px; margin-top: 0; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
        .status { padding: 14px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; line-height: 1.5; }
        .active { background: #064e3b; color: #6ee7b7; border: 1px solid #059669; }
        .inactive { background: #450a0a; color: #fca5a5; border: 1px solid #dc2626; }
        label { display: block; font-size: 13px; color: #94a3b8; margin-top: 14px; margin-bottom: 6px; font-weight: 500; }
        input { width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #475569; border-radius: 6px; padding: 10px 12px; color: #f8fafc; font-size: 14px; }
        input:focus { border-color: #38bdf8; outline: none; }
        button { width: 100%; background: #2563eb; color: white; border: none; border-radius: 6px; padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 20px; transition: background 0.2s; }
        button:hover { background: #1d4ed8; }
        .hint { font-size: 12px; color: #64748b; margin-top: 14px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Kambala MCP Session Manager</h1>
        <div class="status ${session?.susertoken ? 'active' : 'inactive'}">
          ${session?.susertoken 
            ? `✓ <strong>Session Active!</strong><br/>Trader: <b>${session.uid || 'KKSINV'}</b> | Token: ${session.susertoken.slice(0, 10)}...${session.susertoken.slice(-6)}${isEnvActive ? ' (via Render Env)' : ''}`
            : '⚠ <strong>No Active Session</strong><br/>Claude cannot execute trades until a valid Kambala session token is provided.'
          }
        </div>
        <div style="margin: 20px 0; text-align: center;">
          <a href="/oauth/kambala" style="display: block; background: #059669; color: white; text-decoration: none; padding: 13px; border-radius: 6px; font-weight: 600; font-size: 15px; box-shadow: 0 4px 10px rgba(5, 150, 105, 0.4);">
            🔐 1-Click Login via Kambala Auth Page
          </a>
          <div style="margin: 16px 0; display: flex; align-items: center; color: #475569;">
            <div style="flex: 1; height: 1px; background: #334155;"></div>
            <span style="padding: 0 10px; font-size: 12px; text-transform: uppercase;">or manual paste</span>
            <div style="flex: 1; height: 1px; background: #334155;"></div>
          </div>
        </div>
        <form action="/login" method="POST">
          <label>Trader User ID (uid)</label>
          <input name="uid" value="${session?.uid || 'KKSINV'}" required />
          <label>Trader Account ID (actid)</label>
          <input name="actid" value="${session?.actid || 'KKSINV'}" required />
          <label>Kambala susertoken</label>
          <input name="susertoken" value="${session?.susertoken || ''}" placeholder="Paste 64-char Kambala susertoken" required />
          <button type="submit">Activate Session</button>
        </form>
        <p class="hint">Tip: Setting <code>SUSERTOKEN</code> in Render Dashboard → Environment will persist across all restarts.</p>
      </div>
    </body>
    </html>
  `);
});

app.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { susertoken, uid, actid } = req.body;
  if (!susertoken) {
    return res.status(400).send('susertoken is required');
  }
  saveSession({
    susertoken: susertoken.trim(),
    uid: (uid || 'KKSINV').trim(),
    actid: (actid || 'KKSINV').trim(),
    loginTime: new Date().toISOString(),
  });
  console.log(`[Session] New session activated for user ${uid || 'KKSINV'}`);
  res.redirect('/login');
});

// 5. 1-Click Kambala OAuth Redirect Flow
app.get('/oauth/kambala', (req, res) => {
  const redirectUri = process.env.REDIRECT_URI || `${req.protocol}://${req.get('host')}/oauth/callback`;
  const authUrl = `${config.oauthAuthUrl}?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  console.log(`[OAuth] Redirecting trader to Kambala Auth Page: ${authUrl}`);
  res.redirect(authUrl);
});

// 6. Kambala OAuth Callback Interceptor (exchanges code for access_token / susertoken)
app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    return res.status(400).send(`
      <div style="font-family:sans-serif; text-align:center; padding:40px;">
        <h2 style="color:red;">Login Failed</h2>
        <p>Missing 'code' query parameter in OAuth callback from Kambala.</p>
      </div>
    `);
  }

  try {
    console.log(`[OAuth] Intercepted authorization code: ${code}. Requesting GenAcsTok from WCAPI...`);
    const session = await exchangeCodeForToken(code);
    console.log(`[OAuth] Token generated successfully for user: ${session.uid}`);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Kambala Login Success</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
          .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 36px; max-width: 480px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; }
          h1 { color: #10b981; font-size: 24px; margin-bottom: 8px; }
          p { color: #94a3b8; font-size: 15px; line-height: 1.6; }
          .box { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 14px; margin: 20px 0; font-size: 13px; text-align: left; }
          .btn { display: inline-block; background: #2563eb; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; margin-top: 10px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>✓ Login Successful!</h1>
          <p>Kambala WCAPI access token has been generated and securely stored in your server's session vault.</p>
          <div class="box">
            <div><strong>Trader User ID:</strong> ${session.uid || 'KKSINV'}</div>
            <div style="margin-top: 6px;"><strong>Token:</strong> ${session.susertoken.slice(0, 10)}...${session.susertoken.slice(-6)}</div>
            <div style="margin-top: 6px;"><strong>Session Active Since:</strong> ${new Date(session.loginTime).toLocaleTimeString()}</div>
          </div>
          <p>You can now return to <strong>Claude</strong> and begin trading!</p>
          <a href="/login" class="btn">View Session Manager</a>
        </div>
      </body>
      </html>
    `);
  } catch (err: any) {
    console.error(`[OAuth] Token exchange error:`, err);
    res.status(500).send(`
      <div style="font-family:sans-serif; text-align:center; padding:40px;">
        <h2 style="color:red;">Token Exchange Error</h2>
        <p>${err.message}</p>
        <p><a href="/login">Return to Session Manager</a></p>
      </div>
    `);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  Kambala Remote MCP Server (SSE) Running on Port ${PORT}`);
  console.log(`  Auth Mode: No sign-in required`);
  console.log(`  Claude Connector Endpoint: /sse or /mcp`);
  console.log(`======================================================\n`);
});
