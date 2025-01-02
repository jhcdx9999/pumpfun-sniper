import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import dotenv from 'dotenv';
import { buyToken, sellToken } from "../pumputils/utils/tradeToken";
import base58 from "bs58";

// ======== Configuration Parameters ========
type TradeType = 'buy' | 'sell' | 'both';

const CONFIG = {
    // Trade type: 'buy' | 'sell' | 'both'
    TRADE_TYPE: 'sell' as TradeType,

    // Token to trade (pumpfun token contract)
    TOKEN_MINT: "AUE2nh4JVSEfENiPSVe6J4u7EjrYh32TejuA5bqhpump",

    // Buy params
    BUY_AMOUNT_SOL: 0.02,      // Amount of SOL buy
    SLIPPAGE_PERCENT: 1,       // 5 = 5%

    // Sell params
    SELL_PORTION: 0.01,       // 0.001 = 0.1%
    SELL_ALL: false,           
    MIN_SOL_OUTPUT: 0,         // Minimum SOL to receive from sell

    // Transaction confirmation
    CONFIRM_TIMEOUT: 120000,    // Increased to 120 seconds
    
    // Network commitment
    COMMITMENT: "confirmed" as const
};

// Load env
dotenv.config();

// ======== Util Functions ========
function isValidPublicKey(address: string): boolean {
    try {
        new PublicKey(address);
        return true;
    } catch (error) {
        return false;
    }
}

async function checkTransactionStatus(connection: Connection, signature: string): Promise<boolean> {
    try {
        const status = await connection.getSignatureStatus(signature);
        if (!status || !status.value) return false;
        
        if (status.value.err) {
            console.log("Transaction failed on chain:", status.value.err);
            return false;
        }
        
        const tx = await connection.getTransaction(signature);
        if (!tx) return false;

        if (tx.meta?.err) {
            console.log("Transaction error:", tx.meta.err);
            return false;
        }

        return true;
    } catch (error) {
        console.error("Error checking transaction status:", error);
        return false;
    }
}

async function validateEnvironment() {
    const rpc = process.env.RPC_ENDPOINT;
    if (!rpc) throw new Error("RPC_ENDPOINT not found in .env");
    
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) throw new Error("PRIVATE_KEY not found in .env");

    try {
        const keypair = Keypair.fromSecretKey(base58.decode(privateKey));
        // console.log("Private key is valid");
    } catch (error) {
        throw new Error("Invalid PRIVATE_KEY format in .env");
    }

    try {
        const connection = new Connection(rpc);
        await connection.getLatestBlockhash();
        // console.log("RPC connection is valid");
    } catch (error) {
        throw new Error("Failed to connect to RPC endpoint");
    }
}

async function getTokenBalance(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<number | null> {
    try {
        const tokenAccounts = await connection.getTokenAccountsByOwner(owner, { mint });
        if (tokenAccounts.value.length === 0) return null;
        
        const balance = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
        return balance.value.uiAmount;
    } catch (error) {
        console.error("Error getting token balance:", error);
        return null;
    }
}

// ======== Main Trading Function ========
async function testTrading() {
    let connection: Connection | null = null;
    let keypair: Keypair | null = null;
    const startTime = Date.now();

    try {
        // Print configuration
        console.log("\n=== Trading Config ===");
        console.log("Trade Type:", CONFIG.TRADE_TYPE.toUpperCase());
        console.log("Token:", CONFIG.TOKEN_MINT);
        if (CONFIG.TRADE_TYPE === 'buy' || CONFIG.TRADE_TYPE === 'both') {
            console.log("Buy Amount:", CONFIG.BUY_AMOUNT_SOL, "SOL");
            console.log("Slippage:", CONFIG.SLIPPAGE_PERCENT, "%");
        }
        if (CONFIG.TRADE_TYPE === 'sell' || CONFIG.TRADE_TYPE === 'both') {
            console.log("Sell Portion:", CONFIG.SELL_ALL ? "100% (ALL)" : CONFIG.SELL_PORTION * 100 + "%");
            if (CONFIG.MIN_SOL_OUTPUT > 0) {
                console.log("Min SOL Output:", CONFIG.MIN_SOL_OUTPUT);
            }
        }
        console.log("========================\n");

        console.log("Validating environment...");
        await validateEnvironment();

        // Setup connection and keypair
        const rpc = process.env.RPC_ENDPOINT!;
        const privateKey = process.env.PRIVATE_KEY!;

        connection = new Connection(rpc, CONFIG.COMMITMENT);
        keypair = Keypair.fromSecretKey(base58.decode(privateKey));
        
        // Validate mint address
        if (!isValidPublicKey(CONFIG.TOKEN_MINT)) {
            throw new Error(`Invalid token mint address: ${CONFIG.TOKEN_MINT}`);
        }
        
        const testMint = new PublicKey(CONFIG.TOKEN_MINT);

        // Get initial balances
        console.log("\nInitial Balances:");
        const initialSolBalance = await connection.getBalance(keypair.publicKey);
        const initialTokenBalance = await getTokenBalance(connection, testMint, keypair.publicKey);
        console.log(`SOL: ${initialSolBalance / LAMPORTS_PER_SOL}`);
        console.log(`Token: ${initialTokenBalance}`);

        // Execute buy if configured
        if (CONFIG.TRADE_TYPE === 'buy' || CONFIG.TRADE_TYPE === 'both') {
            // Check if wallet has enough SOL
            if (initialSolBalance < CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL) {
                throw new Error(
                    `Insufficient balance. Need ${CONFIG.BUY_AMOUNT_SOL} SOL but wallet has ${initialSolBalance / LAMPORTS_PER_SOL} SOL`
                );
            }

            console.log("\nExecuting buy transaction...");
            const buyResult = await buyToken(
                testMint,
                connection,
                keypair,
                CONFIG.BUY_AMOUNT_SOL,
                CONFIG.SLIPPAGE_PERCENT
            );

            if (buyResult && typeof buyResult === 'string') {
                console.log("\n=== Buy Transaction Details ===");
                console.log("Status: Success");
                console.log("SOL Spent:", CONFIG.BUY_AMOUNT_SOL);
                console.log("Signature:", buyResult);
                console.log("View on Solscan:", `https://solscan.io/tx/${buyResult}`);
                
                console.log("\nWaiting for transaction confirmation...");
                await new Promise(resolve => setTimeout(resolve, CONFIG.CONFIRM_TIMEOUT));

                // Get post-buy balances
                const postBuyTokenBalance = await getTokenBalance(connection, testMint, keypair.publicKey);
                const postBuySolBalance = await connection.getBalance(keypair.publicKey);
                
                console.log("\n=== Final Balances ===");
                console.log(`SOL Balance: ${postBuySolBalance / LAMPORTS_PER_SOL} SOL`);
                console.log(`Token Balance: ${postBuyTokenBalance}`);
                console.log(`Tokens Received: ${postBuyTokenBalance! - (initialTokenBalance || 0)}`);
                console.log(`SOL Net Change: ${(postBuySolBalance - initialSolBalance) / LAMPORTS_PER_SOL} SOL`);
            } else {
                console.log("\n=== Buy Transaction Failed ===");
                if (CONFIG.TRADE_TYPE === 'both') {
                    console.log("Skipping sell operation due to buy failure");
                    return;
                }
            }
        }

        // Execute sell if configured
        if (CONFIG.TRADE_TYPE === 'sell' || CONFIG.TRADE_TYPE === 'both') {
            // Get current token balance
            const currentTokenBalance = await getTokenBalance(connection, testMint, keypair.publicKey);
            if (!currentTokenBalance || currentTokenBalance <= 0) {
                console.log("\n=== Sell Operation Skipped ===");
                console.log("Reason: No tokens available to sell");
                return;
            }

            // Calculate sell amount (without MAX_TOKENS_PER_SELL limit)
            const sellAmount = CONFIG.SELL_ALL ? 
                currentTokenBalance : 
                (CONFIG.TRADE_TYPE === 'both' ? 
                    (currentTokenBalance - (initialTokenBalance || 0)) * CONFIG.SELL_PORTION :
                    currentTokenBalance * CONFIG.SELL_PORTION
                );

            console.log("\n=== Executing Sell Transaction ===");
            console.log(`Available Token Balance: ${currentTokenBalance.toLocaleString('en-US', { maximumFractionDigits: 6 })}`);
            console.log(`Amount to Sell: ${sellAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })} tokens`);
            if (CONFIG.MIN_SOL_OUTPUT > 0) {
                console.log(`Minimum SOL Output: ${CONFIG.MIN_SOL_OUTPUT} SOL`);
            }
            
            let sellSignature;
            try {
                sellSignature = await sellToken(
                    testMint, 
                    connection, 
                    keypair, 
                    sellAmount,
                    CONFIG.MIN_SOL_OUTPUT
                );
            } catch (error: any) {
                // Check if it's a timeout error with a signature
                if (error.signature) {
                    console.log("\nTransaction submitted but waiting for confirmation...");
                    console.log("Signature:", error.signature);
                    console.log("View on Solscan:", `https://solscan.io/tx/${error.signature}`);
                    
                    // Wait and check status
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    const isSuccess = await checkTransactionStatus(connection, error.signature);
                    if (isSuccess) {
                        sellSignature = error.signature;
                    }
                } else {
                    throw error;
                }
            }

            if (sellSignature) {
                console.log("\n=== Sell Transaction Details ===");
                console.log("Status: Success");
                console.log("Tokens Sold:", sellAmount.toLocaleString('en-US', { maximumFractionDigits: 6 }));
                console.log("Signature:", sellSignature);
                console.log("View on Solscan:", `https://solscan.io/tx/${sellSignature}`);

                console.log("\nWaiting for transaction confirmation...");
                await new Promise(resolve => setTimeout(resolve, 5000));

                // Get final balances
                const finalSolBalance = await connection.getBalance(keypair.publicKey);
                const finalTokenBalance = await getTokenBalance(connection, testMint, keypair.publicKey);
                const tokenNetChange = finalTokenBalance! - (initialTokenBalance || 0);
                
                console.log("\n=== Final Balances ===");
                console.log(`SOL Balance: ${(finalSolBalance / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 6 })} SOL`);
                console.log(`Token Balance: ${finalTokenBalance?.toLocaleString('en-US', { maximumFractionDigits: 6 })}`);
                console.log(`SOL Change: ${((finalSolBalance - initialSolBalance) / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 6 })} SOL`);
                console.log(`Token Sent: ${tokenNetChange.toLocaleString('en-US', { maximumFractionDigits: 6 })}`);
            } else {
                console.log("\n=== Sell Transaction Failed ===");
            }
        }

    } catch (error: any) {
        if (error?.signature && connection && keypair) {
            console.log("Transaction may have succeeded despite error. Checking status...");
            console.log("Signature:", error.signature);
            console.log("View on Solscan:", `https://solscan.io/tx/${error.signature}`);
            
            await new Promise(resolve => setTimeout(resolve, CONFIG.CONFIRM_TIMEOUT));
            const isSuccess = await checkTransactionStatus(connection, error.signature);
            
            if (isSuccess) {
                console.log("Transaction was actually successful!");
                const tokenBalance = await getTokenBalance(
                    connection, 
                    new PublicKey(CONFIG.TOKEN_MINT), 
                    keypair.publicKey
                );
                console.log("Token Balance:", tokenBalance);
            } else {
                console.log("Transaction failed on chain");
            }
        }
        console.error("Test error:", error);
    } finally {
        const endTime = Date.now();
        const duration = endTime - startTime;
        const seconds = Math.floor(duration / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        console.log("Duration:", `${minutes}m ${remainingSeconds}s (${duration}ms)`);
    }
}

// ======== Run Test ========
testTrading().then(() => {
    console.log("\n=== Trade Complete ===");
});