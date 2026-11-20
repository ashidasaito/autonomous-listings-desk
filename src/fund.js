// Fund the desk's Telegraph escrow (Sepolia testnet only, $0 real value).
//   node src/fund.js [mintUsd] [depositUsd]      (defaults: 10, 5)
// Steps: show balances -> mint Telegraph test USDC (open mint, anyone) ->
// approve + depositUSDC into the escrow diamond -> show balances again.
// Needs Sepolia ETH for gas: claim from a public Sepolia faucet to the
// wallet address printed here (the desk wallet is in .env at the repo root).
import { TelegraphClient, loadEnv } from "./telegraph.js";

const mintUsd = Number(process.argv[2] || 10);
const depositUsd = Number(process.argv[3] || 5);

const client = new TelegraphClient(loadEnv());
console.log(`Desk wallet: ${client.address} (Sepolia)`);
const before = await client.balances();
console.log("Before:", JSON.stringify(before));

if (before.eth === 0) {
  console.error(
    `\nBLOCKED: wallet holds 0 Sepolia ETH — mint/approve/deposit all need gas.\n` +
      `Claim Sepolia ETH from a public faucet (e.g. sepoliafaucet.com, Google Cloud Web3 faucet)\n` +
      `to ${client.address}, then re-run this script.`,
  );
  process.exit(3);
}

const mint = await client.mintUsdc(mintUsd);
console.log(`Minted ${mintUsd} test USDC: ${mint.txHash}`);

const dep = await client.deposit(depositUsd);
console.log(`Deposited ${depositUsd} test USDC into escrow:`, JSON.stringify(dep.transactions));

const after = await client.balances();
console.log("After:", JSON.stringify(after));
