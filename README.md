# 🤖 Solana Pumpfun Sniper

*Forked from whistledev411*

You can automatically snipe and trade tokens on pump.fun with advanced buy and sell strategies.

You can filter tokens by creator or token ticker/symbol.

## ✨ Features

### ➡️ Buy Features
- Filter tokens by creator wallet address
- Filter tokens by token ticker/symbol
- Support for Geyser(GRPC) mode for faster monitoring
- Support for NextBlock service for faster buying
- WebSocket and HTTP connection support

### ⬅️ Sell Features
- Automatic price monitoring
- Configurable sell multiplier (e.g., sell at 2x)
- Configurable sell ratio (e.g., sell 50% of holdings)
- Adjustable slippage tolerance
- Automatic removal of sold tokens from monitoring

## 🚀 Usage

### Installation
```bash
npm install
```

### Running the Bot
1. Test trading functionality:
```bash
npm run test
```

2. Start the main sniper bot:
```bash
npm run start
```

3. Start the sell listener:
```bash
npm run start_listen_sell
```

## ⚙️ Configuration

### Basic Configuration
```env
RPC_ENDPOINT = Your RPC endpoint
WS_ENDPOINT = Your WebSocket endpoint
USE_WS = true/false
PRIVATE_KEY = Your wallet private key
```

### Buy Configuration
```env
BUY_AMOUNT = Amount of SOL to spend
IS_GEYSER = true/false  # Enable Geyser mode
GEYSER_RPC = Your Geyser RPC endpoint

# NextBlock Service (Optional)
IS_NEXT = true/false
NEXT_BLOCK_API = Your API key
NEXT_BLOCK_FEE = Fee amount

# Token Filter (Optional)
TICKER_MODE = true/false
TOKEN_TICKER = Token symbol to snipe

# Dev Wallet Filter (Optional)
DEV_MODE = true/false
DEV_WALLET_ADDRESS = Creator wallet to monitor
```

### 💎 Sell Configuration
```env
PRICE_FILE_PATH = ./src/asset/price.json  # Path to price tracking file
SELL_MULTIPLIER = 2  # Sell when price reaches 2x
SELL_RATIO = 0.5  # Sell 50% of holdings
SELL_SLIPPAGE = 0.05  # 5% slippage tolerance
```
