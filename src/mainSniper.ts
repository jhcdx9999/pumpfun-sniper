import {
    Connection,
    Keypair,
    PublicKey,
} from "@solana/web3.js";
import base58 from "bs58";
import dotenv from 'dotenv'
import { commitment, PUMP_FUN_PROGRAM } from "./constants";
import { convertHttpToWebSocket, formatDate } from "./utils/commonFunc";

import WebSocket = require("ws");
import { buyToken, sellToken } from "./pumputils/utils/tradeToken";
import { Metaplex } from "@metaplex-foundation/js";
import * as fs from 'fs';
import * as path from 'path';

// Load env var
dotenv.config();

// Get and validate price file path from env
if (!process.env.PRICE_FILE_PATH) {
    console.error("Missing required environment variable: PRICE_FILE_PATH");
    process.exit(1);
}
const PRICE_FILE = path.resolve(process.env.PRICE_FILE_PATH);

/**
 * Save token price to price.json file
 */
async function saveTokenPrice(mint: string, price: number) {
    try {
        // Read existing price data
        let priceData: { [key: string]: number } = {};
        if (fs.existsSync(PRICE_FILE)) {
            const rawData = fs.readFileSync(PRICE_FILE, 'utf8');
            priceData = JSON.parse(rawData);
        }

        // Add new token price
        priceData[mint] = price;

        // Ensure directory exists
        const dir = path.dirname(PRICE_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Save back to file
        fs.writeFileSync(PRICE_FILE, JSON.stringify(priceData, null, 4));
        console.log(`Saved price for token ${mint}: ${price} SOL`);
    } catch (error) {
        console.error("Error saving token price:", error);
    }
}

const rpc = process.env.RPC_ENDPOINT;
const wsEndpoint = process.env.WS_ENDPOINT;
const useWs = process.env.USE_WS === 'true';

console.log("🚀 Connection Type:", useWs ? "WebSocket" : "HTTP");
console.log("🚀 RPC:", rpc);
if (useWs) {
    console.log("🚀 WebSocket:", wsEndpoint);
}

const payer = process.env.PRIVATE_KEY;
console.log("🚀 Private Key:", `${payer?.slice(0, 6)}...`);

// Dev mode config
const isDevMode = process.env.DEV_MODE === 'true';
const devwallet = process.env.DEV_WALLET_ADDRESS;
if (isDevMode) {
    console.log("🚀 Dev Wallet:", devwallet);
}

// Ticker mode config
const isTickerMode = process.env.TICKER_MODE === 'true';
const tokenTicker = process.env.TOKEN_TICKER;
if (isTickerMode) {
    console.log("🚀 Token Ticker:", tokenTicker);
}

// Amount of SOL for buying
const buyamount = process.env.BUY_AMOUNT;
console.log("🚀 Buy Amount:", buyamount);

// Geyser mode
const isGeyser = process.env.IS_GEYSER === 'true';

// Main init function
const init = async (rpcEndPoint: string, payer: string, solIn: number, devAddr: string) => {
    try {
        // Setup keypair and connections
        const payerKeypair = Keypair.fromSecretKey(base58.decode(payer));

        // Create connections based on configuration
        const connection = new Connection(rpcEndPoint, {
            wsEndpoint: useWs ? wsEndpoint : undefined,
            commitment: "confirmed"
        });

        const logConnection = new Connection(rpcEndPoint, {
            wsEndpoint: useWs ? wsEndpoint : undefined,
            commitment: "processed"
        });

        let globalLogListener: any;

        // Function to stop monitoring for new tokens
        let isBuying = false;
        const stopListener = async () => {
            if (globalLogListener !== undefined) {
                try {
                    await logConnection.removeOnLogsListener(globalLogListener);
                    isBuying = true;
                } catch (err) {
                    console.log("Error stopping listener:", err);
                }
            }
        };

        console.log('--------------- Bot is Running Now ---------------');
        console.log('Connection Type:', useWs ? 'WebSocket' : 'HTTP');

        // Monitor for new token mints on the PUMP_FUN_PROGRAM
        globalLogListener = logConnection.onLogs(
            PUMP_FUN_PROGRAM,
            async ({ logs, err, signature }) => {
                if (err) return
                if (isBuying) return
                // Check if the transaction contains a MintTo instruction
                const isMint = logs.filter(log => log.includes("MintTo")).length;
                if (isMint && !isBuying) {
                    const parsedTransaction = await logConnection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
                    if (!parsedTransaction) {
                        return;
                    }
                    console.log("New signature => ", `https://solscan.io/tx/${signature}`, await formatDate());
                    let dev = parsedTransaction?.transaction.message.accountKeys[0].pubkey.toString();
                    const mint = parsedTransaction?.transaction.message.accountKeys[1].pubkey;
                    
                    // Dev mode check
                    if (isDevMode) {
                        console.log("Dev wallet => ", `https://solscan.io/address/${dev}`);
                    }
                    if (isDevMode && dev !== devAddr) return;

                    // Ticker mode check
                    if (isTickerMode) {
                        if (!tokenTicker) return console.log("Token Ticker is not defiend!");
                        const tokenInfo = await getTokenMetadata(mint.toString(), connection);
                        if (!tokenInfo) return;
                        const isTarget = tokenInfo.symbol.toUpperCase().includes(tokenTicker.toUpperCase())
                        if (!isTarget) return
                        console.log(`Found $${tokenInfo.symbol} token.`)
                    }

                    console.log('New token => ', `https://solscan.io/token/${mint.toString()}`)
                    // Stop listener (avoid multiple buys)
                    // await stopListener()
                    isBuying = true;
                    // **** Buy token ****
                    try {
                        const sig = await buyToken(mint, connection, payerKeypair, solIn, 1);
                        if (!sig) {
                            console.log('Buy Fail');
                        } else {
                            console.log('🚀 Buy Success!!!');
                            // Save token price after successful buy
                            await saveTokenPrice(mint.toString(), solIn);
                        }
                    } catch (error) {
                        console.error("Buy error:", error);
                    } finally {
                        isBuying = false; 
                    }
                }
            },
            commitment
        );

    } catch (err) {
        console.log(err);
        return { stopListener: undefined };
    }
};

// Alternative monitoring method using Geyser RPC
const withGaser = (rpcEndPoint: string, payer: string, solIn: number, devAddr: string) => {
    const GEYSER_RPC = process.env.GEYSER_RPC;
    if (!GEYSER_RPC) return console.log('Geyser RPC is not provided!');
    const ws = new WebSocket(GEYSER_RPC);
    
    // Create connection based on configuration
    const connection = new Connection(rpcEndPoint, {
        wsEndpoint: useWs ? wsEndpoint : undefined,
        commitment: "processed"
    });

    const payerKeypair = Keypair.fromSecretKey(base58.decode(payer));

    console.log('Your Pub Key => ', payerKeypair.publicKey.toString());
    console.log('Connection Type:', useWs ? 'WebSocket' : 'HTTP');

    // Setup WebSocket subscription request
    function sendRequest(ws: WebSocket) {
        const request = {
            jsonrpc: "2.0",
            id: 420,
            method: "transactionSubscribe",
            params: [
                {
                    failed: false,
                    accountInclude: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]
                },
                {
                    commitment: "confirmed",
                    encoding: "jsonParsed",
                    transactionDetails: "full",
                    maxSupportedTransactionVersion: 0
                }
            ]
        };
        ws.send(JSON.stringify(request));
    }

    // WebSocket event handlers
    ws.on('open', function open() {
        console.log('WebSocket is open');
        sendRequest(ws);
    });

    // Process incoming WebSocket messages
    ws.on('message', async function incoming(data) {
        const messageStr = data.toString('utf8');
        try {
            const messageObj = JSON.parse(messageStr);

            const result = messageObj.params.result;
            const logs = result.transaction.meta.logMessages;
            const signature = result.signature;
            const accountKeys = result.transaction.transaction.message.accountKeys.map((ak: { pubkey: any; }) => ak.pubkey);

            // Check for new token initialization
            if (logs && logs.some((log: string | string[]) => log.includes('Program log: Instruction: InitializeMint2'))) {
                const dev = accountKeys[0]
                const mint = accountKeys[1]

                console.log("New signature => ", `https://solscan.io/tx/${signature}`, await formatDate());
                if (isDevMode) {
                    console.log("Dev wallet => ", `https://solscan.io/address/${dev}`);
                }
                if (isDevMode && dev !== devAddr) return;

                // Check token ticker if in ticker mode
                if (isTickerMode) {
                    if (!tokenTicker) return console.log("Token Ticker is not defiend!");
                    const tokenInfo = await getTokenMetadata(mint.toString(), connection);
                    if (!tokenInfo) return;
                    const isTarget = tokenInfo.symbol.toUpperCase().includes(tokenTicker.toUpperCase())
                    if (!isTarget) return
                    console.log(`Found $${tokenInfo.symbol} token.`)
                }

                console.log('New token => ', `https://solscan.io/token/${mint.toString()}`)
                ws.close();
                const mintPub = new PublicKey(mint);
                // Attempt to buy the new token
                const sig = await buyToken(mintPub, connection, payerKeypair, solIn, 1);
                console.log('Buy Transaction => ', `https://solscan.io/tx/${sig}`)
                if (!sig) {
                    ws.on('open', function open() {
                        console.log('WebSocket is open');
                        sendRequest(ws);
                    });
                } else {
                    console.log('🚀 Buy Success!!!');
                    console.log('Try to sell on pumpfun: ', `https://pump.fun/${mint.toString()}`);
                    // Save token price after successful buy
                    await saveTokenPrice(mint.toString(), solIn);
                }
            }
        } catch (e) {
        }
    });
}

// Start the bot based on selected mode
const runBot = () => {
    if (isGeyser) {
        console.log('--------------- Geyser mode selected! ---------------\n');
        withGaser(rpc!, payer!, Number(buyamount!), devwallet!);
    } else {
        console.log("--------------- Common Mode selected! ---------------\n");
        init(rpc!, payer!, Number(buyamount!), devwallet!)
    }
}

// Utility function to fetch token metadata using Metaplex
const getTokenMetadata = async (mintAddress: string, connection: Connection) => {
    try {
        const metaplex = Metaplex.make(connection);
        const mintPublicKey = new PublicKey(mintAddress);
        const nft = await metaplex.nfts().findByMint({ mintAddress: mintPublicKey });
        return nft;
    } catch (error) {
        return false
    }
};

// Start the bot
runBot()