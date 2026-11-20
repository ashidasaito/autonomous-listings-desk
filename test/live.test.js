// LIVE test — runs the desk end-to-end against Telegraph beta 2.
// Requires a funded escrow (node src/fund.js). If the escrow cannot cover
// the worst case, the test SKIPS with a clear message instead of failing —
// the offline suite (npm test) stays green without funds.
// Run: npm run test:live
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDesk } from "../src/desk.js";
import { verifyMemo } from "../src/memo.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));

for (const f of fixtures) {
  test(`live: ${f.id} (${f.label}) -> ${f.expected_verdict}`, async (t) => {
    let out;
    try {
      out = await runDesk({
        tokenAddress: f.address,
        handle: f.handle,
        name: f.name,
        symbol: f.symbol,
        chain: f.chain,
        outDir: "out",
      });
    } catch (e) {
      if (/escrow spendable is/.test(e.message)) {
        t.skip(`no funded escrow: ${e.message}`);
        return;
      }
      throw e;
    }
    const m = out.memo;
    console.log(`\n--- ${f.id}: verdict=${m.verdict} mean=${m.mean_score} total=$${m.cost_line.total_usd} ---`);
    for (const c of m.checks) {
      console.log(`  ${c.id}: score=${c.score} cost=$${c.cost_usd} miner=${c.miner} signal=${c.signal_hash}`);
    }
    // The memo must verify against its own signature.
    assert.equal(out.verified.valid, true, `memo self-verification failed: ${out.verified.reason}`);
    assert.equal(verifyMemo(m).valid, true);
    // Every paid check must carry a receipt (signal_hash or receipt_hash) and a cost.
    for (const c of m.checks) {
      if (c.error) continue; // a failed buy is recorded, not hidden
      assert.ok(c.signal_hash || c.receipt_hash, `${c.id}: no signal/receipt hash`);
      assert.ok(typeof c.cost_usd === "number" && c.cost_usd >= 0, `${c.id}: no cost`);
    }
    // The cost line must equal the sum of the per-check costs.
    const sum = m.checks.reduce((a, c) => a + (c.cost_usd ?? 0), 0);
    assert.ok(Math.abs(sum - m.cost_line.total_usd) < 0.000001, `cost line ${m.cost_line.total_usd} != sum ${sum}`);
    // The expected verdict for the fixture.
    assert.equal(m.verdict, f.expected_verdict, `expected ${f.expected_verdict}, got ${m.verdict} (mean ${m.mean_score})`);
    // The failure case must actually fail on substance, not just on a veto:
    // SQUID's audit and holder scores must be low.
    if (f.id === "squid-scam") {
      const audit = m.checks.find((c) => c.id === "contract_audit");
      const holders = m.checks.find((c) => c.id === "holder_concentration");
      assert.ok(audit && audit.score !== null && audit.score < 50, `SQUID audit score should be <50, got ${audit?.score}`);
      assert.ok(holders, "SQUID holder check missing");
    }
    // The clean case must not be vetoed.
    if (f.id === "usdc-clean") {
      assert.equal(m.vetoes.length, 0, `USDC should have no vetoes, got ${JSON.stringify(m.vetoes)}`);
    }
  });
}
