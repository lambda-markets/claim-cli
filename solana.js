// dependencies
import { PublicKey, Connection } from '@solana/web3.js';
import {
  Token,
  AccountLayout,
  u64,
} from '@solana/spl-token';

export const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
)

export default class Solana {
    constructor(rpc) {
        this._rpc = rpc;
        this._connection = new Connection(rpc);
    }
}

/* eslint-disable new-cap */

function parseTokenAccountData(account, data) {
  const accountInfo = AccountLayout.decode(data)
  accountInfo.address = account
  accountInfo.mint = new PublicKey(accountInfo.mint)
  accountInfo.owner = new PublicKey(accountInfo.owner)
  accountInfo.amount = u64.fromBuffer(accountInfo.amount)

  if (accountInfo.delegateOption === 0) {
    accountInfo.delegate = null
    accountInfo.delegatedAmount = new u64(0)
  } else {
    accountInfo.delegate = new PublicKey(accountInfo.delegate)
    accountInfo.delegatedAmount = u64.fromBuffer(accountInfo.delegatedAmount)
  }

  accountInfo.isInitialized = accountInfo.state !== 0
  accountInfo.isFrozen = accountInfo.state === 2

  if (accountInfo.isNativeOption === 1) {
    accountInfo.rentExemptReserve = u64.fromBuffer(accountInfo.isNative)
    accountInfo.isNative = true
  } else {
    accountInfo.rentExemptReserve = null
    accountInfo.isNative = false
  }

  if (accountInfo.closeAuthorityOption === 0) {
    accountInfo.closeAuthority = null
  } else {
    accountInfo.closeAuthority = new PublicKey(accountInfo.closeAuthority)
  }

  return accountInfo
}

export async function createTokenAccount(provider, mint, owner) {
  const token = new Token(
    provider.connection,
    mint,
    TOKEN_PROGRAM_ID,
    owner,
  );
  return await token.createAccount(owner);
}

export async function getTokenAccount(connection, publicKey) {
  const result = await connection.getAccountInfo(publicKey)
  if (!result) return false;
  const data = Buffer.from(result.data)
  const account = parseTokenAccountData(publicKey, data)
  return {
    publicKey,
    account,
  }
}

export async function getOwnedTokenAccounts(connection, publicKey) {
  const results = await connection.getTokenAccountsByOwner(publicKey, {
    programId: TOKEN_PROGRAM_ID,
  })
  return results.value.map((r) => {
    const publicKey = r.pubkey
    const data = Buffer.from(r.account.data)
    const account = parseTokenAccountData(publicKey, data)
    return { publicKey, account }
  })
}
