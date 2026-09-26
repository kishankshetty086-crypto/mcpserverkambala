import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WcapiClient } from './wcapiClient.js';
import { getOAuthLoginUrl, getStoredSession } from './auth.js';

// Create MCP Server instance
const server = new McpServer({
  name: 'kambala-wcapi-trading-server',
  version: '1.0.0',
});

const client = new WcapiClient();

// Helper to format tool response
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

// Helper to format error response
function errorResponse(error: any) {
  const session = getStoredSession();
  const authHint = !session
    ? `\n\n[Action Required] You are not currently logged in. Run 'npm run login' or visit: ${getOAuthLoginUrl()}`
    : '';
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: `Error: ${error.message || String(error)}${authHint}`,
      },
    ],
  };
}

// -------------------------------------------------------------
// READ TOOLS
// -------------------------------------------------------------

server.tool(
  'get_user_profile',
  'Get the logged-in trader account profile and trading segment details.',
  {},
  async () => {
    try {
      const data = await client.getUserDetails();
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

server.tool(
  'get_account_limits',
  'Retrieve cash balance, available margin, margin used, and collateral limits.',
  {
    segment: z.enum(['EQT', 'DER', 'FX', 'COM']).optional().describe('Market segment filter: EQT (Equity), DER (Derivatives), FX (Currency), COM (Commodity)'),
  },
  async ({ segment }) => {
    try {
      const data = await client.getLimits(undefined, undefined, segment);
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

server.tool(
  'get_holdings',
  'Retrieve long-term equity portfolio and Demat holdings with current valuation.',
  {},
  async () => {
    try {
      const data = await client.getHoldings();
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

server.tool(
  'get_positions',
  'Retrieve all open and closed intraday, delivery, and F&O positions with MTM and realized P&L.',
  {},
  async () => {
    try {
      const data = await client.getPositions();
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

server.tool(
  'get_order_book',
  "Retrieve today's complete order book including pending, executed, cancelled, and rejected orders.",
  {},
  async () => {
    try {
      const data = await client.getOrderBook();
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

server.tool(
  'get_trade_book',
  "Retrieve all executed trades for the current trading day with trade price and execution time.",
  {},
  async () => {
    try {
      const data = await client.getTradeBook();
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

server.tool(
  'search_symbols',
  'Search for scrips/contracts by symbol or company name across exchanges (NSE, BSE, NFO, MCX). Returns token and trading symbol.',
  {
    exchange: z.enum(['NSE', 'BSE', 'NFO', 'MCX', 'CDS', 'BFO']).describe('Exchange to search on'),
    searchText: z.string().describe('Search keyword, e.g. "RELIANCE", "NIFTY26SEP", "TCS"'),
  },
  async ({ exchange, searchText }) => {
    try {
      const data = await client.searchScrips(exchange, searchText);
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

server.tool(
  'get_market_quote',
  'Retrieve live market quote including LTP, OHLC, volume, and 5-level market depth for an instrument token.',
  {
    exchange: z.enum(['NSE', 'BSE', 'NFO', 'MCX', 'CDS', 'BFO']).describe('Exchange'),
    token: z.string().describe('Scrip/instrument token (obtained via search_symbols)'),
  },
  async ({ exchange, token }) => {
    try {
      const data = await client.getQuotes(exchange, token);
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

// -------------------------------------------------------------
// RISK & ORDER TOOLS (WITH SAFEGUARDS)
// -------------------------------------------------------------

server.tool(
  'check_order_margin',
  'Simulate and calculate margin requirements before placing an order to verify sufficiency.',
  {
    exchange: z.enum(['NSE', 'BSE', 'NFO', 'MCX', 'CDS', 'BFO']).describe('Exchange'),
    tradingSymbol: z.string().describe('Exact trading symbol (e.g. RELIANCE-EQ, NIFTY26SEP24500CE)'),
    quantity: z.number().int().positive().describe('Quantity of shares or lots'),
    price: z.number().nonnegative().describe('Order price (set to 0 for market orders)'),
    product: z.enum(['C', 'M', 'I', 'F', 'S', 'P']).describe('Product: C (CNC/Delivery), M (NRML/Margin), I (MIS/Intraday), F (MTF)'),
    transactionType: z.enum(['B', 'S']).describe('Transaction: B (BUY), S (SELL)'),
    priceType: z.enum(['LMT', 'MKT', 'SL-LMT', 'SL-MKT']).describe('Price Type: LMT (Limit), MKT (Market), SL-LMT, SL-MKT'),
  },
  async (args) => {
    try {
      const data = await client.checkOrderMargin({
        exch: args.exchange,
        tsym: args.tradingSymbol,
        qty: args.quantity,
        prc: args.price,
        prd: args.product,
        trantype: args.transactionType,
        prctyp: args.priceType,
      });
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

server.tool(
  'prepare_order',
  'Prepare and validate an order preview with estimated margin before actual execution. Recommended to show this to the user for confirmation.',
  {
    exchange: z.enum(['NSE', 'BSE', 'NFO', 'MCX', 'CDS', 'BFO']).describe('Exchange'),
    tradingSymbol: z.string().describe('Exact trading symbol'),
    quantity: z.number().int().positive().describe('Order quantity'),
    price: z.number().nonnegative().describe('Order price (0 for market)'),
    product: z.enum(['C', 'M', 'I', 'F', 'S', 'P']).describe('Product: C (Delivery), M (Margin), I (Intraday), F (MTF)'),
    transactionType: z.enum(['B', 'S']).describe('B (BUY) or S (SELL)'),
    priceType: z.enum(['LMT', 'MKT', 'SL-LMT']).describe('Order price type'),
  },
  async (args) => {
    try {
      // 1. Check margin
      const marginResult = await client.checkOrderMargin({
        exch: args.exchange,
        tsym: args.tradingSymbol,
        qty: args.quantity,
        prc: args.price,
        prd: args.product,
        trantype: args.transactionType,
        prctyp: args.priceType,
      });

      const preview = {
        action: 'ORDER_PREVIEW_CONFIRMATION_REQUIRED',
        orderSummary: {
          exchange: args.exchange,
          symbol: args.tradingSymbol,
          side: args.transactionType === 'B' ? 'BUY' : 'SELL',
          quantity: args.quantity,
          price: args.price === 0 ? 'MARKET' : `₹${args.price}`,
          product: args.product,
          priceType: args.priceType,
        },
        marginCheck: marginResult,
        instructionForAI:
          'Present this order summary clearly to the user. Explicitly ask for user confirmation before calling execute_order.',
      };

      return jsonResponse(preview);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

server.tool(
  'execute_order',
  'Execute a verified order to OMS/RMS exchange router. Must only be invoked after explicit user confirmation.',
  {
    exchange: z.enum(['NSE', 'BSE', 'NFO', 'MCX', 'CDS', 'BFO']).describe('Exchange'),
    tradingSymbol: z.string().describe('Exact trading symbol'),
    quantity: z.number().int().positive().describe('Order quantity'),
    price: z.number().nonnegative().describe('Order price (0 for market)'),
    product: z.enum(['C', 'M', 'I', 'F', 'S', 'P']).describe('Product: C (Delivery), M (Margin), I (Intraday), F (MTF)'),
    transactionType: z.enum(['B', 'S']).describe('B (BUY) or S (SELL)'),
    priceType: z.enum(['LMT', 'MKT', 'SL-LMT']).describe('Order price type'),
    retention: z.enum(['DAY', 'EOS', 'IOC']).optional().default('DAY').describe('Retention type'),
    triggerPrice: z.number().optional().describe('Trigger price for stop loss orders'),
    remarks: z.string().optional().describe('Order remarks or tag (default: AI_MCP_ORDER)'),
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
        ret: args.retention,
        trgprc: args.triggerPrice,
        remarks: args.remarks || 'AI_MCP_ORDER',
      });
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

server.tool(
  'cancel_order',
  'Cancel an active or pending order using its Noren order number (norenordno).',
  {
    norenOrderNumber: z.string().describe('The Noren order ID (norenordno) to cancel'),
  },
  async ({ norenOrderNumber }) => {
    try {
      const data = await client.cancelOrder(norenOrderNumber);
      return jsonResponse(data);
    } catch (err: any) {
      return errorResponse(err);
    }
  }
);

// -------------------------------------------------------------
// SERVER STARTUP
// -------------------------------------------------------------
async function main() {
  if (process.env.PORT || process.env.RENDER) {
    console.log(`[Kambala MCP] Cloud Web Service detected on port ${process.env.PORT}. Starting SSE transport...`);
    await import('./sseServer.js');
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Kambala MCP] Server started on stdio transport.');
}

main().catch((error) => {
  console.error('[Kambala MCP] Fatal error in main():', error);
  process.exit(1);
});
