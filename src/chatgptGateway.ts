import express from 'express';
import { WcapiClient } from './wcapiClient.js';
import { config } from './config.js';

const app = express();
app.use(express.json());

const client = new WcapiClient();

// -------------------------------------------------------------
// OPENAPI 3.1 SPECIFICATION FOR CHATGPT CUSTOM GPT ACTIONS
// -------------------------------------------------------------
const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Kambala WCAPI Trading Gateway for ChatGPT',
    description: 'Enables ChatGPT to query live portfolio, account limits, market data, and place verified trading orders via Kambala OMS/RMS.',
    version: '1.0.0',
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Local development server (or your public ngrok / domain URL)',
    },
  ],
  paths: {
    '/api/limits': {
      get: {
        operationId: 'getAccountLimits',
        summary: 'Get account funds, cash balance, and available margin limits',
        description: 'Returns total available cash, margin used, and collateral limits for trading.',
        responses: {
          '200': {
            description: 'Account limits and margin balance',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/api/holdings': {
      get: {
        operationId: 'getHoldings',
        summary: 'Get long-term Demat equity portfolio holdings',
        description: 'Returns list of shares held in Demat account with quantities and current valuations.',
        responses: {
          '200': {
            description: 'Holdings array',
            content: { 'application/json': { schema: { type: 'array' } } },
          },
        },
      },
    },
    '/api/positions': {
      get: {
        operationId: 'getPositions',
        summary: 'Get open intraday and F&O positions',
        description: 'Returns real-time open positions, net quantity, MTM, and realized/unrealized P&L.',
        responses: {
          '200': {
            description: 'Positions array',
            content: { 'application/json': { schema: { type: 'array' } } },
          },
        },
      },
    },
    '/api/orders': {
      get: {
        operationId: 'getOrderBook',
        summary: 'Get today order book',
        description: 'Returns all orders placed today with status (Pending, Traded, Rejected, Cancelled).',
        responses: {
          '200': {
            description: 'Order book array',
            content: { 'application/json': { schema: { type: 'array' } } },
          },
        },
      },
    },
    '/api/search': {
      get: {
        operationId: 'searchSymbols',
        summary: 'Search for stocks or contracts across exchanges',
        description: 'Finds scrip tokens and trading symbols on NSE, BSE, NFO, MCX.',
        parameters: [
          {
            name: 'exchange',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['NSE', 'BSE', 'NFO', 'MCX'] },
            description: 'Exchange to search (e.g. NSE)',
          },
          {
            name: 'keyword',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Symbol or company name (e.g. RELIANCE, TATASTEEL, NIFTY)',
          },
        ],
        responses: {
          '200': {
            description: 'List of matching symbols and tokens',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/api/quote': {
      get: {
        operationId: 'getMarketQuote',
        summary: 'Get live market quote and 5-level depth',
        description: 'Returns live LTP, open, high, low, close, volume, and bid/ask depth for an instrument token.',
        parameters: [
          {
            name: 'exchange',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['NSE', 'BSE', 'NFO', 'MCX'] },
            description: 'Exchange (e.g. NSE)',
          },
          {
            name: 'token',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Scrip token obtained from search (e.g. 2885 for Reliance)',
          },
        ],
        responses: {
          '200': {
            description: 'Live quote data',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/api/check-margin': {
      post: {
        operationId: 'checkOrderMargin',
        summary: 'Simulate margin required before placing an order',
        description: 'Pre-trade risk check: verifies if account has enough margin before executing an order.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['exchange', 'tradingSymbol', 'quantity', 'price', 'product', 'transactionType', 'priceType'],
                properties: {
                  exchange: { type: 'string', enum: ['NSE', 'BSE', 'NFO', 'MCX'] },
                  tradingSymbol: { type: 'string', description: 'Trading symbol (e.g. RELIANCE-EQ)' },
                  quantity: { type: 'number', description: 'Quantity of shares' },
                  price: { type: 'number', description: 'Price (0 for Market)' },
                  product: { type: 'string', enum: ['C', 'M', 'I', 'F'], description: 'C (Delivery), I (Intraday), M (Margin/F&O), F (MTF)' },
                  transactionType: { type: 'string', enum: ['B', 'S'], description: 'B (Buy), S (Sell)' },
                  priceType: { type: 'string', enum: ['LMT', 'MKT', 'SL-LMT'], description: 'Price type' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Calculated margin requirements',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/api/place-order': {
      post: {
        operationId: 'placeOrder',
        summary: 'Execute a verified trading order to OMS/RMS',
        description: 'Places a confirmed buy/sell order through Kambala OMS/RMS. MUST ONLY BE CALLED AFTER EXPLICIT USER CONFIRMATION IN CHAT.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['exchange', 'tradingSymbol', 'quantity', 'price', 'product', 'transactionType', 'priceType'],
                properties: {
                  exchange: { type: 'string', enum: ['NSE', 'BSE', 'NFO', 'MCX'] },
                  tradingSymbol: { type: 'string', description: 'Trading symbol (e.g. RELIANCE-EQ)' },
                  quantity: { type: 'number', description: 'Quantity of shares' },
                  price: { type: 'number', description: 'Price (0 for Market)' },
                  product: { type: 'string', enum: ['C', 'M', 'I', 'F'], description: 'C (Delivery), I (Intraday MIS), M (Margin)' },
                  transactionType: { type: 'string', enum: ['B', 'S'], description: 'B (Buy), S (Sell)' },
                  priceType: { type: 'string', enum: ['LMT', 'MKT', 'SL-LMT'] },
                  remarks: { type: 'string', default: 'CHATGPT_AI_ORDER' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Order placement result with norenordno',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
};

// -------------------------------------------------------------
// ENDPOINTS
// -------------------------------------------------------------

// Serve dynamic OpenAPI specification
app.get('/openapi.json', (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const dynamicSpec = {
    ...openApiSpec,
    servers: [
      {
        url: `${protocol}://${host}`,
        description: 'Kambala Trading Gateway Server',
      },
    ],
  };
  res.json(dynamicSpec);
});

// Profile / User Details
app.get('/api/profile', async (req, res) => {
  try {
    const data = await client.getUserDetails();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Account Limits
app.get('/api/limits', async (req, res) => {
  try {
    const data = await client.getLimits();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Demat Holdings
app.get('/api/holdings', async (req, res) => {
  try {
    const data = await client.getHoldings();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Positions Book
app.get('/api/positions', async (req, res) => {
  try {
    const data = await client.getPositions();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Order Book
app.get('/api/orders', async (req, res) => {
  try {
    const data = await client.getOrderBook();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Search Scrips
app.get('/api/search', async (req, res) => {
  try {
    const exch = (req.query.exchange as string) || 'NSE';
    const keyword = (req.query.keyword as string) || '';
    const data = await client.searchScrips(exch, keyword);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get Quotes
app.get('/api/quote', async (req, res) => {
  try {
    const exch = (req.query.exchange as string) || 'NSE';
    const token = (req.query.token as string) || '';
    const data = await client.getQuotes(exch, token);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Simulate / Check Margin
app.post('/api/check-margin', async (req, res) => {
  try {
    const b = req.body;
    const data = await client.checkOrderMargin({
      exch: b.exchange,
      tsym: b.tradingSymbol,
      qty: b.quantity,
      prc: b.price,
      prd: b.product,
      trantype: b.transactionType,
      prctyp: b.priceType,
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Place Order
app.post('/api/place-order', async (req, res) => {
  try {
    const b = req.body;
    const data = await client.placeOrder({
      exch: b.exchange,
      tsym: b.tradingSymbol,
      qty: b.quantity,
      prc: b.price,
      prd: b.product,
      trantype: b.transactionType,
      prctyp: b.priceType,
      remarks: b.remarks || 'CHATGPT_AI_ORDER',
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  ChatGPT Custom Actions Gateway Running!`);
  console.log(`  OpenAPI Specification: http://localhost:${PORT}/openapi.json`);
  console.log(`======================================================\n`);
});
