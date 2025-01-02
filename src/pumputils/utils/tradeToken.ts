import * as token from "@solana/spl-token";
import * as web3 from "@solana/web3.js";
import getBondingCurvePDA from "./getBondingCurvePDA";
import tokenDataFromBondingCurveTokenAccBuffer from "./tokenDataFromBondingCurveTokenAccBuffer";
import { getBuyPrice, getSellPrice } from "./getPrice";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { BN } from "bn.js";
import { PumpFun } from "../idl/pump-fun";
import IDL from "../idl/pump-fun.json";
import wait from "./wait";
import getBondingCurveTokenAccountWithRetry from "./getBondingCurveTokenAccountWithRetry";
import { SystemProgram, TransactionMessage } from "@solana/web3.js";
import { executeJitoTx } from "../../utils/jito";
import { exit } from "process";

// Retry settings for bonding curve account
const BOANDING_CURVE_ACC_RETRY_AMOUNT = 5;
const BOANDING_CURVE_ACC_RETRY_DELAY = 50;
const FEE_RECEIPT = new web3.PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
const PROGRAM_ID = new web3.PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

interface Payload {
  transaction: TransactionMessages;
}

interface TransactionMessages {
  content: string;
}

// Sell tokens on Pump.fun
async function sellToken(
  mint: web3.PublicKey,
  connection: web3.Connection,
  keypair: web3.Keypair,
  amount: number,
  minSolOutput: number = 0,
  priorityFee?: number
): Promise<string | false> {
  try {
    // Initialize Anchor program
    const provider = new AnchorProvider(connection, new Wallet(keypair), {
      commitment: "finalized",
    });
    const program = new Program<PumpFun>(IDL as PumpFun, provider);
    const transaction = new web3.Transaction();

    // Get token account
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      keypair.publicKey,
      { mint: mint }
    );

    if (tokenAccounts.value.length === 0) {
      throw new Error("No token account found for this mint");
    }

    // Setup bonding curve and token accounts
    console.log("Selling");
    const bondingCurve = getBondingCurvePDA(mint, PROGRAM_ID);
    const associatedUser = await token.getAssociatedTokenAddress(mint, keypair.publicKey);
    const associatedBondingCurve = await token.getAssociatedTokenAddress(mint, bondingCurve, true);

    // Get current token balance and validate amount
    const tokenBalance = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
    if (!tokenBalance.value.uiAmount || tokenBalance.value.uiAmount < amount) {
      throw new Error(`Insufficient token balance. Have: ${tokenBalance.value.uiAmount}, Need: ${amount}`);
    }

    // Convert amount to raw amount considering decimals
    const rawAmount = Math.round(amount * Math.pow(10, tokenBalance.value.decimals));
    console.log('Selling token amount => ', amount);
    console.log('Raw amount => ', rawAmount);

    // Setup transaction parameters
    const modifyComputeUnits = web3.ComputeBudgetProgram.setComputeUnitLimit({
      units: 100000,
    });
    const addPriorityFee = web3.ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: typeof priorityFee === "number" ? priorityFee * 1000000000 : 0.0001 * 1000000000,
    });

    const latestBlockhash = await connection.getLatestBlockhash();

    // Build sell transaction
    transaction
      .add(modifyComputeUnits)
      .add(addPriorityFee)
      .add(
        await program.methods
          .sell(
            new BN(rawAmount.toString()),
            new BN(minSolOutput * web3.LAMPORTS_PER_SOL)
          )
          .accounts({
            feeRecipient: FEE_RECEIPT,
            mint,
            associatedBondingCurve,
            associatedUser,
            user: keypair.publicKey
          })
          .transaction()
      );

    transaction.feePayer = keypair.publicKey;
    transaction.recentBlockhash = latestBlockhash.blockhash;

    // console.log(await connection.simulateTransaction(transaction));

    // Handle different transaction submission methods based on .env settings
    if (process.env.IS_NEXT === 'true' && process.env.NEXT_BLOCK_API) {
      // NextBlock submission logic
      const next_block_addrs = [
        'NEXTbLoCkB51HpLBLojQfpyVAMorm3zzKg7w9NFdqid',
        'NeXTBLoCKs9F1y5PJS9CKrFNNLU1keHW71rfh7KgA1X',
        'NexTBLockJYZ7QD7p2byrUa6df8ndV2WSd8GkbWqfbb',
        'neXtBLock1LeC67jYd1QdAa32kbVeubsfPNTJC1V5At',
        'nEXTBLockYgngeRmRrjDV31mGSekVPqZoMGhQEZtPVG',
        'nextBLoCkPMgmG8ZgJtABeScP35qLa2AMCNKntAP7Xc',
        'NextbLoCkVtMGcV47JzewQdvBpLqT9TxQFozQkN98pE',
        'NexTbLoCkWykbLuB1NkjXgFWkX9oAtcoagQegygXXA2'
      ];

      for (let i = 0; i < next_block_addrs.length; i++) {
        const next_block_addr = next_block_addrs[i];
        const next_block_api = process.env.NEXT_BLOCK_API;

        const recipientPublicKey = new web3.PublicKey(next_block_addr);
        const transferInstruction = SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: recipientPublicKey,
          lamports: process.env.NEXT_BLOCK_FEE ? Number(process.env.NEXT_BLOCK_FEE) * web3.LAMPORTS_PER_SOL : 1000000
        });

        transaction.add(transferInstruction);
        transaction.sign(keypair);

        console.log("NextBlock Selling token");

        const tx64Str = transaction.serialize().toString('base64');
        const payload: Payload = {
          transaction: {
            content: tx64Str
          }
        };

        try {
          console.log("Trying transaction to confirm using nextblock");
          const response = await fetch('https://fra.nextblock.io/api/v2/submit', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'authorization': next_block_api
            },
            body: JSON.stringify(payload)
          });

          const responseData = await response.json();
          console.log("responseData", responseData);

          if (response.ok) {
            console.log("Sent transaction with signature", `https://solscan.io/tx/${responseData.signature?.toString()}`);
            return responseData.signature;
          } else {
            console.error("Failed to send transaction:", response.status, responseData);
            continue;
          }
        } catch (error) {
          console.error("Error sending transaction:", error);
          continue;
        }
      }
      return false;
    } else if (process.env.IS_JITO === 'true' && process.env.JITO_FEE) {
      // Jito submission logic
      const messageV0 = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: transaction.instructions,
      }).compileToV0Message();

      const versionedTx = new web3.VersionedTransaction(messageV0);
      versionedTx.sign([keypair]);

      const sig = await executeJitoTx([versionedTx], keypair, 'confirmed');
      return sig || false;
    } else {
      // Standard transaction submission
      transaction.sign(keypair);
      const txSig = await connection.sendTransaction(transaction, [keypair]);
      const confirmSig = await connection.confirmTransaction(txSig, 'confirmed');

      // console.log('confirm sig => ', confirmSig.value.err);

      if (confirmSig.value.err) {
        console.log("Transaction failed with error:", confirmSig.value.err);
        return false;
      }

      return txSig;
    }
  } catch (error) {
    console.error("Error selling tokens:", error);
    return false;
  }
}

// Main function to buy tokens on Pump.fun with support for NextBlock and Jito
async function buyToken(
  mint: web3.PublicKey,
  connection: web3.Connection,
  keypair: web3.Keypair,
  solAmount: number,
  slippage: number,
  priorityFee?: number
) {
  try {
    // Initialize Anchor program
    const provider = new AnchorProvider(connection, new Wallet(keypair), {
      commitment: "finalized",
    });
    const program = new Program<PumpFun>(IDL as PumpFun, provider);
    const transaction = new web3.Transaction();

    // Get or create token account for the user
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      keypair.publicKey,
      {
        mint: mint,
      }
    );
    // console.log("🚀 ~ tokenAccounts:", tokenAccounts)

    const associatedUser = await token.getAssociatedTokenAddress(mint, keypair.publicKey, false);

    if (tokenAccounts.value.length === 0) {
      transaction.add(
        token.createAssociatedTokenAccountInstruction(keypair.publicKey, associatedUser, keypair.publicKey, mint)
      );
    }

    // Setup bonding curve and token accounts
    console.log("Buying");
    const bondingCurve = getBondingCurvePDA(mint, PROGRAM_ID);
    const associatedBondingCurve = await token.getAssociatedTokenAddress(mint, bondingCurve, true);

    const bondingCurveTokenAccount = await getBondingCurveTokenAccountWithRetry(
      connection,
      bondingCurve,
      BOANDING_CURVE_ACC_RETRY_AMOUNT,
      BOANDING_CURVE_ACC_RETRY_DELAY
    );

    if (bondingCurveTokenAccount === null) {
      throw new Error("Bonding curve account not found");
    }

    // Calculate buy amount and slippage
    const tokenData = tokenDataFromBondingCurveTokenAccBuffer(bondingCurveTokenAccount!.data);
    if (tokenData.complete) {
      throw new Error("Bonding curve already completed");
    }
    console.log('transfer sol amount => ', solAmount);
    const SLIPAGE_POINTS = BigInt(slippage * 100);
    const solAmountLamp = BigInt(solAmount * web3.LAMPORTS_PER_SOL);
    // console.log("🚀 ~ solAmountLamp:", solAmountLamp)
    const buyAmountToken = getBuyPrice(solAmountLamp, tokenData);
    const buyAmountSolWithSlippage = solAmountLamp + (solAmountLamp * SLIPAGE_POINTS) / 10000n;

    // Setup transaction parameters
    const modifyComputeUnits = web3.ComputeBudgetProgram.setComputeUnitLimit({
      units: 100000,
    });
    const addPriorityFee = web3.ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: typeof priorityFee === "number" ? priorityFee * 1000000000 : 0.0001 * 1000000000,
    });

    const latestBlockhash = await connection.getLatestBlockhash()

    // Build buy transaction
    transaction
      .add(modifyComputeUnits)
      .add(addPriorityFee)
      .add(
        await program.methods
          .buy(new BN(buyAmountToken.toString()), new BN(buyAmountSolWithSlippage.toString()))
          .accounts({
            feeRecipient: FEE_RECEIPT,
            mint: mint,
            associatedBondingCurve: associatedBondingCurve,
            associatedUser: associatedUser,
            user: keypair.publicKey,
          })
          .transaction()
      );

    transaction.feePayer = keypair.publicKey;
    transaction.recentBlockhash = latestBlockhash.blockhash;

    // console.log(await connection.simulateTransaction(transaction))

    // Handle different transaction submission methods based on .env settings
    if (process.env.IS_NEXT === 'true' && process.env.NEXT_BLOCK_API) {
      // NextBlock submission logic
      const next_block_addrs = [
        'NEXTbLoCkB51HpLBLojQfpyVAMorm3zzKg7w9NFdqid',
        'NeXTBLoCKs9F1y5PJS9CKrFNNLU1keHW71rfh7KgA1X',
        'NexTBLockJYZ7QD7p2byrUa6df8ndV2WSd8GkbWqfbb',
        'neXtBLock1LeC67jYd1QdAa32kbVeubsfPNTJC1V5At',
        'nEXTBLockYgngeRmRrjDV31mGSekVPqZoMGhQEZtPVG',
        'nextBLoCkPMgmG8ZgJtABeScP35qLa2AMCNKntAP7Xc',
        'NextbLoCkVtMGcV47JzewQdvBpLqT9TxQFozQkN98pE',
        'NexTbLoCkWykbLuB1NkjXgFWkX9oAtcoagQegygXXA2'
      ]

      for (let i = 0; i < next_block_addrs.length; i++) {
        const next_block_addr = next_block_addrs[i];
        const next_block_api = process.env.NEXT_BLOCK_API;

        const recipientPublicKey = new web3.PublicKey(next_block_addr);
        const transferInstruction = SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: recipientPublicKey,
          lamports: process.env.NEXT_BLOCK_FEE ? Number(process.env.NEXT_BLOCK_FEE) * web3.LAMPORTS_PER_SOL : 1000000
        });

        transaction.add(transferInstruction);
        transaction.sign(keypair)

        console.log("Buying token")

        const tx64Str = transaction.serialize().toString('base64');
        const payload: Payload = {
          transaction: {
            content: tx64Str
          }
        };

        try {
          console.log("Trying transaction to confirm using nextblock")
          const response = await fetch('https://fra.nextblock.io/api/v2/submit', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'authorization': next_block_api
            },
            body: JSON.stringify(payload)
          });

          const responseData = await response.json();
          console.log("responseData", responseData);

          if (response.ok) {
            console.log("Sent transaction with signature", `https://solscan.io/tx/${responseData.signature?.toString()}`);
            return responseData.signature;
          } else {
            console.error("Failed to send transaction:", response.status, responseData);
            continue;
          }
        } catch (error) {
          console.error("Error sending transaction:", error);
          continue;
        }
      }
      return false;
    } else if (process.env.IS_JITO === 'true' && process.env.JITO_FEE) {
      // Jito submission logic
      const messageV0 = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: transaction.instructions,
      }).compileToV0Message()

      const versionedTx = new web3.VersionedTransaction(messageV0);
      versionedTx.sign([keypair]);

      const sig = await executeJitoTx([versionedTx], keypair, 'confirmed');
      return sig;
    } else {
      // Standard transaction submission
      transaction.sign(keypair);
      const txSig = await connection.sendTransaction(transaction, [keypair]);
      const confirmSig = await connection.confirmTransaction(txSig, 'confirmed');

      console.log('confirm sig => ', confirmSig.value.err);

      if (confirmSig.value.err) {
        console.log("Transaction failed with error:", confirmSig.value.err);
        return false;
      }

      return txSig;
    }

  } catch (error) {
    console.error(error);
    return false
  }
}

export { buyToken, sellToken };
