# claim
merkle distributor claim tool


## usage
1. Make sure you fill out an `.env.development.local` using the keys in the `.template`
2. Place your keyPair files in the `/keys` directory (has a `README.md`)
3. Run `yarn install` to get the dependencies
4. Run `node index check` to check the keys in the directory and give you the crucial `DROP_WALLETS` array which you need to copy in the code. Also tells you your total drop claim.
5. Run `node index claim` to claim all drops (might need to run a couple of times until all keys return owner not allowed or some bullshit)
6. Run `node index drain --base` to get all the tokens to your main wallet (specified in the `.env.development.local`)
7. Run `node index drain --help` to check how to drain quote (USDC) or SOL as well if need be. 

## notes
8. If you want to completely strip the wallets you can also close all the associated token accounts created in the wallets, this frees up a bit of sol. If you need that code I have it and it works. Then at the end run `node index drain --sol`
