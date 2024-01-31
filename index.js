// dependencies: npm
import ora from 'ora';
import _ from 'lodash';
import path from 'path';
import chalk from 'chalk';
import yargs from 'yargs';
import axios from 'axios';
import FastGlob from 'fast-glob';
import { readFile } from 'fs/promises';
import { hideBin } from 'yargs/helpers';

// dependencies: solana
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, Token } from '@solana/spl-token';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import * as anchor from '@project-serum/anchor';
import { getTokenAccount } from './solana.js';
import BN from 'bn.js';

// configuration
import * as dotenv from 'dotenv';
const NODE_ENV = process.env.NODE_ENV || 'development';
dotenv.config({ path: path.resolve(path.resolve(), `.env.${NODE_ENV}.local`) });
const { RPC_MAINNET, QUOTE_MINT, BASE_MINT } = process.env;

// connect to solana
const connection = new Connection(RPC_MAINNET);

// constants
// TODO: paste the DROP_WALLETS from the check command here
const DROP_WALLETS = [];
// NOTE: same program for wen and for jup
const LFG_MERKLE_PROGRAM = 'meRjbQXFNf5En86FXT2YPz1dQzLj4Yb3xK8u1MVgqpb';
// NOTE: change mint (preset for $JUP now)
const TOKEN_MINT = new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
const TOKEN_DECIMALS = 1e6;
import IDL from './idl.js';

// helpers
async function promiseAllInBatches(promiseFunctions, batchSize) {
  let results = [];
  for (let i = 0; i < promiseFunctions.length; i += batchSize) {
    const batchFuncs = promiseFunctions.slice(i, i + batchSize);
    const batchPromises = batchFuncs.map((func) => func()); // Start each promise
    results = [...results, ...(await Promise.all(batchPromises))];
  }
  return results;
}
async function addressBalances(conn, publicKey, baseMint, quoteMint) {
  const baseMintKey = new PublicKey(baseMint);
  const quoteMintKey = new PublicKey(quoteMint);

  // fetch associated token accounts
  const baseAta = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, baseMintKey, publicKey);
  const quoteAta = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, quoteMintKey, publicKey);

  // get mint info
  const baseMintInfo = await new Token(conn, baseMintKey, TOKEN_PROGRAM_ID, null).getMintInfo();
  const quoteMintInfo = await new Token(conn, quoteMintKey, TOKEN_PROGRAM_ID, null).getMintInfo();

  // get accounts
  const baseAccount = await getTokenAccount(conn, baseAta);
  const quoteAccount = await getTokenAccount(conn, quoteAta);

  // return normalised account balances
  return {
    sol: await conn.getBalance(publicKey),
    hasBaseAta: (baseAccount.account && baseAccount.account.amount.toNumber() >= 0) || false,
    baseLamports: (baseAccount.account && baseAccount.account.amount.toNumber()) || 0,
    base: (baseAccount.account && baseAccount.account.amount.toNumber() / 10 ** baseMintInfo.decimals) || 0,
    baseDecimals: baseMintInfo.decimals,
    hasQuoteAta: (quoteAccount.account && quoteAccount.account.amount.toNumber() >= 0) || false,
    quoteLamports: (quoteAccount.account && quoteAccount.account.amount.toNumber()) || 0,
    quote: (quoteAccount.account && quoteAccount.account.amount.toNumber() / 10 ** quoteMintInfo.decimals) || 0,
    quoteDecimals: quoteMintInfo.decimals,
    accounts: {
      baseAta: baseAta.toBase58(),
      baseMint: baseMintKey.toBase58(),
      quoteAta: quoteAta.toBase58(),
      quoteMint: quoteMintKey.toBase58(),
    },
  };
}

const claimProofUrl = (pubkey) => `https://worker.jup.ag/jup-claim-proof/${TOKEN_MINT.toBase58()}/${pubkey}`;

// initialise argv parser
const cli = yargs(hideBin(process.argv)).usage('$0 <cmd> [args]');

// COMMAND: CHECK
cli.command(
  'check [execute]',
  'check claim eligibility per wallet and display valid and total sum',
  (yargs) => {
    yargs.option('execute', {
      describe: 'execute state changing action',
      type: 'boolean',
      default: false,
    });
  },
  async (argv) => {
    // get keyfiles
    const keyFiles = FastGlob.sync(path.resolve(path.resolve(), argv.deprecated ? 'keys/DEPRECATED/*.json' : 'keys/*.json'));
    const keyPairs = await Promise.all(keyFiles.map(async (x) => Keypair.fromSecretKey(new Uint8Array(JSON.parse(await readFile(x))))));

    const kpBalancesPromises = keyPairs.map((x) => {
      return async () => {
        return {
          pubkey: x.publicKey.toBase58(),
          balance: await addressBalances(connection, x.publicKey, BASE_MINT, QUOTE_MINT),
          kp: x,
        };
      };
    });

    const spinner = ora(`retrieving ${kpBalancesPromises.length} account balances...`).start();
    const kpBalances = await promiseAllInBatches(kpBalancesPromises, 5);
    spinner.stop();

    const airdropProofPromises = kpBalances.map((x) => {
      return async () => {
        try {
          const { data } = await axios.get(claimProofUrl(x.pubkey));
          if (!data || !data.amount) throw new Error('no proof data, wallet likely not eligible');
          console.log('checked:', x.pubkey, data.amount);
          return {
            pubkey: x.pubkey,
            amount: data.amount,
          };
        } catch (e) {
          console.log('ERROR', e.message);
          return {
            pubkey: x.pubkey,
            amount: 0,
          };
        }
      };
    });

    // execute all promises in batches of 5 and report total
    const airdropProofData = await promiseAllInBatches(airdropProofPromises, 5);
    console.log('TOTAL', _.sumBy(airdropProofData, 'amount') / TOKEN_DECIMALS);
    console.log(
      'DROP_WALLETS',
      airdropProofData.filter((x) => x.amount > 0).map((x) => x.pubkey)
    );
  }
);

// COMMAND: CLAIM
cli.command(
  'claim [execute]',
  'claim airdrop',
  (yargs) => {
    yargs.option('execute', {
      describe: 'trigger trade 0',
      type: 'boolean',
      default: false,
    });
  },
  async (argv) => {
    // get keyfiles
    const keyFiles = FastGlob.sync(path.resolve(path.resolve(), 'keys/*.json'));
    const keyPairs = await Promise.all(keyFiles.map(async (x) => Keypair.fromSecretKey(new Uint8Array(JSON.parse(await readFile(x))))));

    // constants
    const preflightCommitment = 'processed';
    const commitment = 'confirmed';

    const claimPromises = DROP_WALLETS.map((w) => {
      return async () => {
        // get drop wallet keypair
        const firstKp = _.find(keyPairs, (x) => x.publicKey.toBase58() === w);

        // setup anchor program interface
        const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(firstKp), {
          preflightCommitment,
          commitment,
        });
        const wenProgram = new anchor.Program(IDL, LFG_MERKLE_PROGRAM, provider);

        // get claim data
        const { data } = await axios.get(claimProofUrl(firstKp.publicKey.toBase58()));

        // construct arguments in proper format
        const amountUnlocked = new BN(data.amount);
        const amountLocked = new BN(0);
        const validProofData = data.proof.map((p) => new Uint8Array(p));

        // DERIVE PDA: distributor
        // NOTE: you normally have to do this but the api call actually gives you the address apparently
        // const [distributorAccount] = await PublicKey.findProgramAddress(
        //   [Buffer.from('MerkleDistributor'), TOKEN_MINT.toBuffer(), Buffer.alloc(8)],
        //   wenProgram.programId
        // );
        const distributorAccount = new PublicKey(data.merkle_tree);
        // console.log('DistributorAccount', distributorAccount.toBase58());

        // DERIVE PDA: claim_status
        const [claimStatusAccount] = await PublicKey.findProgramAddress(
          [Buffer.from('ClaimStatus'), firstKp.publicKey.toBuffer(), distributorAccount.toBuffer()],
          wenProgram.programId
        );
        // console.log('claimStatusAccount', claimStatusAccount.toBase58());

        // get on curve (non seeded) ata of the mint for the distributor account
        const distributorAta = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_MINT, distributorAccount, true);
        // console.log('distributorAta', distributorAta);

        // derive claimer mint ata and generate creation instruction
        const claimerMintAta = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_MINT, firstKp.publicKey);
        const createClaimerMintAtaInstruction = Token.createAssociatedTokenAccountInstruction(
          ASSOCIATED_TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          TOKEN_MINT,
          claimerMintAta,
          firstKp.publicKey,
          firstKp.publicKey
        );

        // prepare solana program invocation account envelope
        const accounts = {
          distributor: distributorAccount, // The [MerkleDistributor].
          claimstatus: claimStatusAccount,
          from: distributorAta, // Distributor ATA containing the tokens to distribute.
          to: claimerMintAta,
          claimant: firstKp.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        };
        try {
          // RUN WITH --execute to run
          if (!argv.execeute) return;
          const claimTx = await wenProgram.methods
            .newClaim(amountUnlocked, amountLocked, validProofData)
            .accounts(accounts)
            .preInstructions([createClaimerMintAtaInstruction])
            .rpc();

          console.log('DONE', claimTx); // YOLO ITS CLAIMING BEYOOOTCH
          return claimTx;
        } catch (e) {
          return e.message;
        }
      };
    });

    const claimTransactions = await promiseAllInBatches(claimPromises, 5);
    console.log(claimTransactions);

    // shut down
    console.log(chalk.white.bold('\nDONE'));
    process.exit(0);
  }
);

// COMMAND: DRAIN
cli.command(
  'drain [base] [quote] [tokens] [sol]',
  'drain keys balances {base, quote, tokens, sol}',
  (yargs) => {
    yargs
      .option('base', {
        describe: 'drain base',
        type: 'boolean',
        default: false,
      })
      .option('quote', {
        describe: 'drain quote',
        type: 'boolean',
        default: false,
      })
      .option('tokens', {
        describe: 'drain tokens',
        type: 'boolean',
        default: false,
      })
      .option('sol', {
        describe: 'drain sol',
        type: 'boolean',
        default: false,
      });
  },
  async (argv) => {
    // get keyfiles
    const keyFiles = FastGlob.sync(path.resolve(path.resolve(), 'keys/*.json'));
    const keyPairs = await Promise.all(keyFiles.map(async (x) => Keypair.fromSecretKey(new Uint8Array(JSON.parse(await readFile(x))))));
    const kpBalancesPromises = keyPairs.map((x) => {
      return async () => {
        return {
          pubkey: x.publicKey.toBase58(),
          balance: await addressBalances(connection, x.publicKey, BASE_MINT, QUOTE_MINT),
          kp: x,
        };
      };
    });

    const spinner = ora(`retrieving ${kpBalancesPromises.length} account balances...`).start();
    const kpBalances = await promiseAllInBatches(kpBalancesPromises, 5);
    spinner.stop();
    console.log(chalk.white.bold('\nACCOUNTS'));
    _.forEach(kpBalances, (x) => console.log(x.pubkey, x.balance.sol, x.balance.quote, x.balance.base));

    // DRAIN BASE
    if (argv.base || argv.tokens) {
      console.log(
        chalk.white.bold('\nBASE SIZE'),
        _.sumBy(kpBalances, (x) => x.balance.base)
      );

      // drain base from all wallets
      const spinner = ora(`draining ${kpBalances.length} base wallets...`).start();
      const drainTransactionPromises = kpBalances.map((x) => {
        return async () => {
          if (x.balance.base === 0) return;
          const xBaseAta = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, new PublicKey(BASE_MINT), x.kp.publicKey);
          const quoteXfer = new Transaction().add(
            Token.createTransferInstruction(
              TOKEN_PROGRAM_ID,
              xBaseAta,
              new PublicKey(accounts.baseAta),
              x.kp.publicKey,
              [],
              x.balance.base * 10 ** balances.baseDecimals
            )
          );
          spinner.text = `draining base ${x.balance.base} from ${x.kp.publicKey.toBase58()}...`;
          return await sendAndConfirmTransaction(connection, quoteXfer, [x.kp]);
        };
      });
      const drainTransactions = await promiseAllInBatches(drainTransactionPromises, 5);
      spinner.stop();
      console.log(chalk.white.bold('\nBASE DRAINED'), drainTransactions);
    }

    // DRAIN QUOTE
    if (argv.quote || argv.tokens) {
      console.log(
        chalk.white.bold('\nQUOTE SIZE'),
        _.sumBy(kpBalances, (x) => x.balance.quote)
      );

      // drain quote from all wallets
      const spinner = ora(`draining ${kpBalances.length} quote wallets...`).start();
      const drainTransactionPromises = kpBalances.map((x) => {
        return async () => {
          if (x.balance.quote === 0) return;
          const xQuoteAta = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, new PublicKey(QUOTE_MINT), x.kp.publicKey);
          const quoteXfer = new Transaction().add(
            Token.createTransferInstruction(
              TOKEN_PROGRAM_ID,
              xQuoteAta,
              new PublicKey(accounts.quoteAta),
              x.kp.publicKey,
              [],
              x.balance.quote * 10 ** balances.quoteDecimals
            )
          );
          spinner.text = `draining quote ${x.balance.quote} from ${x.kp.publicKey.toBase58()}...`;
          return await sendAndConfirmTransaction(connection, quoteXfer, [x.kp]);
        };
      });
      const drainTransactions = await promiseAllInBatches(drainTransactionPromises, 5);
      spinner.stop();
      console.log(chalk.white.bold('\nQUOTE DRAINED'), drainTransactions);
    }

    // DRAIN SOL
    if (argv.sol) {
      console.log(
        chalk.white.bold('\nSOL SIZE'),
        _.sumBy(kpBalances, (x) => x.balance.sol / 10 ** 9)
      );

      // send sol to all wallets
      const spinner = ora(`draining ${kpBalances.length} sol wallets...`).start();
      const solTransactionsPromises = keyPairs.map((kp) => {
        return async () => {
          const solBalance = await connection.getBalance(kp.publicKey);
          if (solBalance <= 5000) return false;
          const solXfer = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: kp.publicKey,
              toPubkey: pk.publicKey,
              lamports: solBalance - 5000,
            })
          );
          spinner.text = `draining ${solBalance} from ${kp.publicKey.toBase58()}...`;
          return await sendAndConfirmTransaction(connection, solXfer, [kp]);
        };
      });
      const solTransactions = await promiseAllInBatches(solTransactionsPromises, 5);
      console.log('\nSOL DRAINED', solTransactions);
      spinner.stop();
    }
  }
);

// RUN
cli.demandCommand(1).parse();
