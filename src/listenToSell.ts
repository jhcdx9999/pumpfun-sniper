import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { commitment, PUMP_FUN_PROGRAM } from "./constants";
import { formatDate } from "./utils/commonFunc";
import { sellToken } from "./pumputils/utils/tradeToken";
import getBondingCurvePDA from "./pumputils/utils/getBondingCurvePDA";
import getBondingCurveTokenAccountWithRetry from "./pumputils/utils/getBondingCurveTokenAccountWithRetry";
import tokenDataFromBondingCurveTokenAccBuffer from "./pumputils/utils/tokenDataFromBondingCurveTokenAccBuffer";
import { getSellPrice } from "./pumputils/utils/getPrice";
import * as token from "@solana/spl-token";
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import base58 from "bs58";
console.log("listenToSell.ts");
// Load environment variables
dotenv.config();

// Load and validate environment variables 
if (!process.env.PRICE_FILE_PATH) {
    console.error("Missing required environment variable: PRICE_FILE_PATH");
    process.exit(1);
}
const PRICE_FILE = path.resolve(process.env.PRICE_FILE_PATH);
console.log("PRICE_FILE: ", PRICE_FILE);

const SELL_MULTIPLIER = Number(process.env.SELL_MULTIPLIER || 2);
const SELL_RATIO = Number(process.env.SELL_RATIO || 0.5);  // Default to 50%
const SELL_SLIPPAGE = Number(process.env.SELL_SLIPPAGE || 0.05);

// Validate sell ratio
if (SELL_RATIO <= 0 || SELL_RATIO > 1) {
    console.error("Invalid SELL_RATIO. Must be between 0 and 1");
    process.exit(1);
}

interface TokenConfig {
    [key: string]: {
        initialPrice: number;
        tokenAccount?: PublicKey;
        balance?: number;
    };
}

// Load and validate token configurations from price.json
async function loadTokenConfigs(connection: Connection, keypair: PublicKey): Promise<TokenConfig> {
    try {
        const rawData = fs.readFileSync(PRICE_FILE, 'utf8');
        const priceData = JSON.parse(rawData);
        const tokenConfig: TokenConfig = {};

        // Convert simple price data to detailed configuration
        for (const [mint, price] of Object.entries(priceData)) {
            if (typeof price === 'number' && price > 0) {
                // Get token account for this mint
                const tokenAccounts = await connection.getTokenAccountsByOwner(
                    keypair,
                    { mint: new PublicKey(mint) }
                );

                if (tokenAccounts.value.length > 0) {
                    const balance = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
                    tokenConfig[mint] = {
                        initialPrice: price,
                        tokenAccount: tokenAccounts.value[0].pubkey,
                        balance: balance.value.uiAmount || 0
                    };
                }
            }
        }

        return tokenConfig;
    } catch (error) {
        console.error("Error loading price configuration:", error);
        return {};
    }
}

/**
 * Remove token from price.json after successful sell
 */
async function removeTokenFromPriceFile(mint: string) {
    try {
        if (fs.existsSync(PRICE_FILE)) {
            const rawData = fs.readFileSync(PRICE_FILE, 'utf8');
            const priceData: { [key: string]: number } = JSON.parse(rawData);
            
            // Remove the token
            delete priceData[mint];
            
            // Save back to file
            fs.writeFileSync(PRICE_FILE, JSON.stringify(priceData, null, 4));
            console.log(`Removed token ${mint} from price file`);
        }
    } catch (error) {
        console.error("Error removing token from price file:", error);
    }
}

/**
 * Start monitoring token prices
 */
async function startPriceMonitor() {
    // Load environment variables
    const rpc = process.env.RPC_ENDPOINT;
    const wsEndpoint = process.env.WS_ENDPOINT;
    const useWs = process.env.USE_WS === 'true';
    const payer = process.env.PRIVATE_KEY;

    if (!rpc || !payer) {
        console.error("Missing required environment variables (RPC_ENDPOINT or PRIVATE_KEY)");
        process.exit(1);
    }

    // Create connection
    const connection = new Connection(rpc, {
        wsEndpoint: useWs ? wsEndpoint : undefined,
        commitment: "confirmed"
    });

    // Create keypair from private key
    const keypair = Keypair.fromSecretKey(base58.decode(payer));

    console.log("\n=== Starting Multi-Token Price Monitor ===");
    console.log("Loading token configurations...");
    console.log("Sell Multiplier:", SELL_MULTIPLIER);
    console.log("Sell Ratio:", SELL_RATIO * 100 + "%");
    console.log("Sell Slippage:", SELL_SLIPPAGE * 100 + "%");

    // Load token configurations
    let tokenConfigs = await loadTokenConfigs(connection, keypair.publicKey);
    const tokenCount = Object.keys(tokenConfigs).length;

    if (tokenCount === 0) {
        throw new Error("No valid tokens found in price configuration");
    }

    console.log(`Loaded ${tokenCount} token configurations`);
    console.log("Start Time:", await formatDate());
    console.log("========================\n");

    // Create a Map to store bonding curve PDAs (for performance)
    const bondingCurveCache = new Map<string, PublicKey>();
    let isSelling = false;

    // Start monitoring logs
    console.log("Starting price monitoring...");
    connection.onLogs(
        PUMP_FUN_PROGRAM,
        async ({ logs, err }) => {
            if (err || isSelling) return;

            try {
                // Extract all mint addresses from logs
                const mintAddresses = Object.keys(tokenConfigs);
                const relevantMints = mintAddresses.filter(mint => 
                    logs.some(log => log.includes(mint))
                );

                if (relevantMints.length === 0) return;

                // Process each relevant mint
                for (const mint of relevantMints) {
                    const config = tokenConfigs[mint];
                    if (!config || config.balance === 0) continue;

                    // Get or cache bonding curve PDA
                    let bondingCurve = bondingCurveCache.get(mint);
                    if (!bondingCurve) {
                        bondingCurve = getBondingCurvePDA(new PublicKey(mint), PUMP_FUN_PROGRAM);
                        bondingCurveCache.set(mint, bondingCurve);
                    }

                    // Get current price
                    const bondingCurveTokenAccount = await getBondingCurveTokenAccountWithRetry(
                        connection,
                        bondingCurve,
                        5,
                        50
                    );

                    if (!bondingCurveTokenAccount) continue;

                    const tokenData = tokenDataFromBondingCurveTokenAccBuffer(bondingCurveTokenAccount.data);
                    const oneToken = BigInt(1_000_000);
                    const currentPriceInLamports = getSellPrice(oneToken, tokenData);
                    const currentPrice = Number(currentPriceInLamports) / 1_000_000_000;

                    console.log("\n=== Price Update ===");
                    console.log("Token:", mint);
                    console.log("Time:", await formatDate());
                    console.log("Initial Price:", config.initialPrice);
                    console.log("Current Price:", currentPrice);
                    console.log("Price Ratio:", currentPrice / config.initialPrice);

                    // Check if price meets criteria
                    if (currentPrice >= config.initialPrice * SELL_MULTIPLIER) {
                        console.log("\n🚨 Price Target Reached! Executing Sell...");
                        
                        // Set selling flag
                        isSelling = true;

                        try {
                            // Calculate sell amount based on ratio
                            if (!config.balance) {
                                console.log("❌ No balance available for selling");
                                continue;
                            }
                            
                            const sellAmount = config.balance * SELL_RATIO;
                            
                            // Execute sell
                            const sellSignature = await sellToken(
                                new PublicKey(mint),
                                connection,
                                keypair,
                                sellAmount,
                                currentPrice * (1 - SELL_SLIPPAGE)  // Apply slippage tolerance
                            );

                            if (sellSignature) {
                                console.log("✅ Sell Transaction Successful!");
                                console.log("Sold Amount:", sellAmount);
                                console.log("Signature:", sellSignature);
                                console.log("View on Solscan:", `https://solscan.io/tx/${sellSignature}`);
                                
                                // Update balance
                                const newBalance = await connection.getTokenAccountBalance(config.tokenAccount!);
                                config.balance = newBalance.value.uiAmount || 0;
                                
                                // Remove token from monitoring if balance is 0
                                if (config.balance === 0) {
                                    delete tokenConfigs[mint];
                                    console.log("Token removed from monitoring (zero balance)");
                                    // Remove from price file
                                    await removeTokenFromPriceFile(mint);
                                } else {
                                    console.log("Remaining Balance:", config.balance);
                                }
                            } else {
                                console.log("❌ Sell Transaction Failed");
                            }
                        } catch (error) {
                            console.error("Error executing sell:", error);
                        } finally {
                            // Reset selling flag
                            isSelling = false;
                        }
                    }
                }
            } catch (error) {
                console.error("Error processing transaction:", error);
                isSelling = false;
            }
        },
        commitment
    );
}

// Start the monitor
// console.log("Starting price monitor...");
// startPriceMonitor().catch(error => {
//     console.error("Error starting price monitor:", error);
//     process.exit(1);
// }); 