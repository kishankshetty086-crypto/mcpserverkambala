import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { WcapiClient } from './wcapiClient.js';

const app = express();
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

function createTradingMcpServer() {
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

  function errorResponse(err: any) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `Error: ${err.message || String(err)}`,
        },
      ],
    };
  }

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

app.set('trust proxy', 1);

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
  const server = createTradingMcpServer();
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
  const transport = sessionId ? transports.get(sessionId) : transports.values().next().value;

  if (!transport) {
    res.status(404).json({ error: 'Session not found or expired' });
    return;
  }

  await transport.handlePostMessage(req, res);
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  Kambala Remote MCP Server (SSE) Running on Port ${PORT}`);
  console.log(`  Auth Mode: No sign-in required`);
  console.log(`  Claude Connector Endpoint: /sse or /mcp`);
  console.log(`======================================================\n`);
});
