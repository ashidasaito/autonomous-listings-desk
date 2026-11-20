// Live smoke test (free endpoints only — no paid asks, no on-chain writes).
// Verifies: intent catalogue still lists our 6 intents, ledger/account reads,
// wallet balances, and the public context resolvers (token meta, deployer,
// verified source) for both fixtures.
import { TelegraphClient, loadEnv } from "../src/telegraph.js";
import { CHECKS } from "../src/checks.js";
import { CHAINS, resolveTokenMeta, resolveDeployer, resolveCode } from "../src/desk.js";
import { readFileSync } from "node:fs";

const client = new TelegraphClient(loadEnv());
const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));

console.log("== wallet ==");
const b = await client.balances();
console.log(JSON.stringify(b, null, 2));

console.log("\n== intents ==");
const intents = await client.listIntents();
console.log(`live catalogue: ${intents.length} intents`);
for (const c of CHECKS) {
  const found = intents.find((i) => i.name === c.intent);
  console.log(`  ${c.intent}: ${found ? `FOUND (${found.miner_count ?? "?"} miners, ${found.lifecycle_state})` : "MISSING!"}`);
}

for (const f of fixtures) {
  console.log(`\n== fixture ${f.id} (${f.address}, ${f.chain}) ==`);
  const cfg = CHAINS[f.chain];
  const meta = await resolveTokenMeta(f.address, cfg);
  console.log(`  token: ${meta.name} (${meta.symbol}), totalSupply=${meta.totalSupply}, block=${meta.block}`);
  const dep = await resolveDeployer(f.address, cfg);
  console.log(`  deployer: ${dep.deployer ?? "unknown"} — ${dep.note}`);
  const code = await resolveCode(f.address, cfg);
  console.log(`  code: ${code.note}`);
  console.log(`  active checks for ${f.chain}: ${CHECKS.filter((c) => !c.chains || c.chains.includes(f.chain)).map((c) => c.id).join(", ")}`);
}
console.log("\nSMOKE DONE");
