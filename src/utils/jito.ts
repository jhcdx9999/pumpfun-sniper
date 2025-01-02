import { Commitment, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import base58 from "bs58";
import axios from "axios";

/**
 * Execute transactions through Jito MEV infrastructure
 * @param transactions Array of transactions to be executed
 * @param payer Keypair of the transaction payer
 * @param commitment Commitment level for transaction confirmation
 * @returns Transaction signature or null if execution fails
 */
export const executeJitoTx = async (transactions: VersionedTransaction[], payer: Keypair, commitment: Commitment) => {
  // Get Jito fee from environment variables
  const JITO_FEE = Number(process.env.JITO_FEE);
  if(!JITO_FEE) return console.log('Jito fee has not been set!');
  const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
  if(!RPC_ENDPOINT) return console.log("Rpc has not been set!")
  const solanaConnection = new Connection(RPC_ENDPOINT)

  // Array of Jito tip accounts (searcher fee recipients)
  const tipAccounts = [
    'JiToVqvj8Jmsfz9L2J3PJhGVvsJsHxXKPKqKxwQdXFh',
    'JiToFZLHr9uNh4qtE3K7YH9Yh3qx3t3hYwZxJ3BxaKh',
    'JiToSearcherBooster11111111111111111111111111',
    'JiToShMxY2LY6CbYBmxKPyBxzBhX8ydHGCmK7xu4Lkh',
    'JiToB2pZwzKrMRJZx5mzfGHYzMtDjg3yh4PzQBXxzKh'
  ];
  
  // Randomly select a tip account
  const jitoFeeWallet = new PublicKey(tipAccounts[Math.floor(tipAccounts.length * Math.random())])

  try {
    // Get latest blockhash for transaction
    let latestBlockhash = await solanaConnection.getLatestBlockhash();

    // Create a transaction to pay Jito fee
    const jitTipTxFeeMessage = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: jitoFeeWallet,
          lamports: Math.floor(JITO_FEE * 10 ** 9), // Convert SOL to lamports
        }),
      ],
    }).compileToV0Message();

    // Create and sign the fee transaction
    const jitoFeeTx = new VersionedTransaction(jitTipTxFeeMessage);
    jitoFeeTx.sign([payer]);

    // Get the transaction signature
    const jitoTxsignature = base58.encode(transactions[0].signatures[0]);

    // Serialize all transactions for submission
    const serializedjitoFeeTx = base58.encode(jitoFeeTx.serialize());
    const serializedTransactions = [serializedjitoFeeTx];
    for (let i = 0; i < transactions.length; i++) {
      const serializedTransaction = base58.encode(transactions[i].serialize());
      serializedTransactions.push(serializedTransaction);
    }

    // Jito block engine endpoints
    const endpoints = [
      // 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
      // 'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
      // 'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
      'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
      // 'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
    ];

    // Prepare requests for all endpoints
    const requests = endpoints.map((url) =>
      axios.post(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [serializedTransactions],
      })
    );

    // Send requests to all endpoints and collect results
    const results = await Promise.all(requests.map((p) => p.catch((e) => e)));
    const successfulResults = results.filter((result) => !(result instanceof Error));

    if (successfulResults.length > 0) {
      // Wait for transaction confirmation
      const confirmation = await solanaConnection.confirmTransaction(
        {
          signature: jitoTxsignature,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          blockhash: latestBlockhash.blockhash,
        },
        commitment,
      );
      console.log("🚀 ~ executeJitoTx ~ confirmation:", confirmation)

      // Check confirmation status
      if (confirmation.value.err) {
        console.log("Confirmation error")
        return null
      } else {
        return jitoTxsignature;
      }
    } else {
      console.log(`No successful responses received for jito`);
    }
    console.log("case 1")
    return null
  } catch (error) {
    console.log('Error during transaction execution', error);
    return null
  }
}




