// One-off: the FIRST live purchase — the contract-audit check on USDC,
// using exactly the input the desk builds (CHECKS[0].buildInput).
// Prints the full purchase receipt and verifies the signal hash.
// Run: node first-purchase.mjs
import { TelegraphClient, loadEnv } from "./src/telegraph.js";
import { CHECKS } from "./src/checks.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const client = new TelegraphClient(loadEnv());
const audit = CHECKS.find((c) => c.id === "contract_audit");
const input = audit.buildInput({ address: USDC, chainLabel: "Ethereum mainnet" });
console.log("ASK:", JSON.stringify(input, null, 2));
const ask = await client.ask({ query: input.query });
console.log("\nPURCHASE RECEIPT:");
console.log(JSON.stringify(ask, null, 2));
if (ask.signalHash) {
  const v = await client.verifySignal(ask.signalHash);
  console.log("\nSIGNAL VERIFICATION:", JSON.stringify(v));
}
