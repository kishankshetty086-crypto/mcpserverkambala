# Kambala WCAPI Model Context Protocol (MCP) Server

An enterprise-ready **MCP Server** connecting AI assistants (such as **Claude Desktop**, **Cursor**, and **ChatGPT**) directly to Kambala Solutions' **WCAPI (`NorenWClientAPI`)** and OMS/RMS infrastructure.

---

## 1. Architecture

```text
       ┌────────────────────────┐
       │ AI Assistant (Claude)  │
       └───────────┬────────────┘
                   │ MCP (stdio / JSON-RPC)
                   ▼
       ┌────────────────────────┐
       │ Kambala Node.js MCP    │ <--- Manages OAuth Session & susertoken
       └───────────┬────────────┘
                   │ REST API (jData format)
                   ▼
       ┌────────────────────────┐
       │   Kambala WCAPI        │ (https://rama.kambala.co.in)
       └───────────┬────────────┘
                   │
                   ▼
       ┌────────────────────────┐
       │       OMS / RMS        │ <--- Risk, Margins, Limits, Exchange Router
       └────────────────────────┘
```

### Security & Compliance Architecture
* **Credentials Kept Private**: The LLM never sees `SECRET_KEY`, broker passwords, or `susertoken`.
* **Zero Direct Execution (Human-in-the-Loop)**: AI uses `prepare_order` $\rightarrow$ simulates margin $\rightarrow$ presents confirmation $\rightarrow$ human approves $\rightarrow$ `execute_order`.
* **Standard RMS Governance**: Every order passes normal broker RMS, margin checks, and exchange limits.

---

## 2. Quick Setup

### Step 1: Install Dependencies
Open a terminal in this directory:
```bash
npm install
```

### Step 2: Configure Environment (`.env`)
The `.env` file is pre-configured with your client details:
```env
WCAPI_BASE_URL=https://rama.kambala.co.in
OAUTH_AUTH_URL=https://rama.kambala.co.in/NorenWeb2.0/authorize/oauth

CLIENT_ID=KKSINV_U
SECRET_KEY=v7dEItTCfHurgCgnn0g3HfdlfsSOzVdd6uXFPBX2NsnFMx2Z9FKR0YYyzftOE605

REDIRECT_URI=http://localhost:3000/oauth/callback
PORT=3000
SESSION_FILE=.session.json
```

> **Note**: Ensure `http://localhost:3000/oauth/callback` is registered as the Redirect URI in the Kambala OAuth application settings.

### Step 3: Interactive Login (Generate `susertoken`)
Run the login command:
```bash
npm run login
```
* This command spins up a temporary callback listener on `http://localhost:3000/oauth/callback`.
* It opens your browser to:
  `https://rama.kambala.co.in/NorenWeb2.0/authorize/oauth?client_id=KKSINV_U&redirect_uri=http://localhost:3000/oauth/callback`
* Complete your broker credentials and 2FA/TOTP.
* Upon redirect, the server computes `SHA-256(CLIENT_ID + SECRET_KEY + CODE)`, calls `/NorenWClientAPI/GenAcsTok`, and saves the session to `.session.json`.

### Step 4: Build TypeScript
```bash
npm run build
```

---

## 3. Configuring Claude Desktop

To connect this MCP server to Claude Desktop, edit your Claude configuration file:

* **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
* **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the following under `mcpServers`:

```json
{
  "mcpServers": {
    "kambala-trading": {
      "command": "node",
      "args": [
        "C:\\Users\\Kishan K Shetty\\.gemini\\antigravity\\scratch\\kambala-mcp-trading\\dist\\index.js"
      ],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

Restart Claude Desktop. You will see a hammer 🔨 icon indicating that Kambala Trading tools are available.

---

## 4. Available MCP Tools

| Tool | Category | Description |
| :--- | :--- | :--- |
| `get_user_profile` | Account | Trader profile, user ID, account ID, permitted exchanges. |
| `get_account_limits` | Account | Available balance, margin used, collateral limits. |
| `get_holdings` | Portfolio | Long-term Demat equity holdings and current values. |
| `get_positions` | Portfolio | Real-time open intraday and F&O positions, MTM, and P&L. |
| `get_order_book` | Trading | Complete order status book (pending, executed, cancelled). |
| `get_trade_book` | Trading | All executed trades for the trading day. |
| `search_symbols` | Market Data | Resolves company names/derivatives to exact trading symbols & tokens. |
| `get_market_quote` | Market Data | Live LTP, bid/ask depth, OHLC for an instrument token. |
| `check_order_margin`| Risk Pre-trade| Calculates margin required before placing an order. |
| `prepare_order` | Trading Guard | Generates an order preview card and margin check for user confirmation. |
| `execute_order` | Trading Exec | Dispatches order to OMS/RMS exchange router (`PlaceOrder`). |
| `cancel_order` | Trading Exec | Cancels an open order by `norenordno`. |

---

## 5. Example Prompts in Claude

Once configured, you can ask Claude:
* *"Show my account limits and available cash."*
* *"What are my open positions today? Calculate my total unrealized P&L."*
* *"Search for Reliance on NSE and give me its latest quote."*
* *"I want to buy 10 shares of RELIANCE-EQ intraday. Check margin and prepare the order preview."*
* *"Review my trade book and analyze my win rate and average trade size today."*
