import { Wallet } from "ethers";
import { writeFileSync, chmodSync } from "node:fs";
const w = Wallet.createRandom();
const env = [
  "# Autonomous Listings Desk — Telegraph beta 2 (Sepolia testnet ONLY)",
  "# Fresh agent wallet generated 2026-11-19. Testnet only, $0 real value.",
  "# NEVER commit this file. NEVER share the private key.",
  `TELEGRAPH_PRIVATE_KEY=${w.privateKey}`,
  `TELEGRAPH_ADDRESS=${w.address}`,
  "TELEGRAPH_URL=https://devnode.telegraphprotocol.com",
  "TELEGRAPH_CHAIN_ID=11155111",
  "TELEGRAPH_DIAMOND=0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b",
  "TELEGRAPH_USDC=0xcc194e1a843B658526D0D5C431f670028582Ae17",
  "TELEGRAPH_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com",
  "TELEGRAPH_PAYMENT=escrow",
].join("\n") + "\n";
const path = "./.env";
writeFileSync(path, env, { mode: 0o600 });
chmodSync(path, 0o600);
console.log("ADDRESS=" + w.address);
console.log("saved to .env (0600)");
