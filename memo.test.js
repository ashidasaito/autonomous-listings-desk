import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { buildMemo, signMemo, verifyMemo, memoId, canonical, renderMemo } from "../src/memo.js";

function fakeCheck(id, score, cost) {
  return {
    id,
    dimension: id,
    intent: `${id.toUpperCase()}_GENERAL`,
    miner: "miner-1 (id 42)",
    signalHash: `0x${"aa".repeat(32)}`,
    receiptHash: `0x${"bb".repeat(32)}`,
    costUsd: cost,
    billedUsd: cost,
    authorizedUsd: 0.26,
    latencyMs: 1200,
    rail: "escrow",
    score,
    notes: [`note for ${id}`],
    evidence: { summary: "ok" },
  };
}

test("canonical JSON is key-order independent", () => {
  assert.equal(canonical({ b: 1, a: { d: 4, c: 3 } }), canonical({ a: { c: 3, d: 4 }, b: 1 }));
  assert.equal(canonical([1, { b: 2, a: 1 }]), '[1,{"a":1,"b":2}]');
});

test("memo: build -> sign -> verify round-trips", async () => {
  const wallet = Wallet.createRandom();
  const checks = [fakeCheck("audit", 90, 0.02), fakeCheck("holders", 80, 0.015)];
  const memo = buildMemo({
    token: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", name: "USD Coin", symbol: "USDC" },
    chain: "ethereum",
    checks,
    startedAt: 1000,
    finishedAt: 5000,
    signer: wallet.address,
  });
  assert.equal(memo.verdict, "LIST");
  assert.equal(memo.mean_score, 85);
  assert.equal(memo.cost_line.total_usd, 0.035);
  const signed = await signMemo(wallet, memo);
  assert.ok(signed.memo_id.startsWith("0x") && signed.memo_id.length === 66);
  const v = verifyMemo(signed);
  assert.equal(v.valid, true);
  assert.equal(v.signer.toLowerCase(), wallet.address.toLowerCase());
});

test("memo: tampering is detected", async () => {
  const wallet = Wallet.createRandom();
  const memo = buildMemo({
    token: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    chain: "ethereum",
    checks: [fakeCheck("audit", 90, 0.02)],
    startedAt: 1000,
    finishedAt: 2000,
    signer: wallet.address,
  });
  const signed = await signMemo(wallet, memo);
  const tampered = { ...signed, verdict: "DO NOT LIST" }; // flip a field after signing
  const v = verifyMemo(tampered);
  assert.equal(v.valid, false);
  assert.ok(v.reason.includes("memo_id mismatch"));
});

test("memo: veto forces DO NOT LIST", async () => {
  const wallet = Wallet.createRandom();
  const bad = fakeCheck("sanctions", 0, 0.01);
  bad.veto = true;
  bad.notes = ["sanctions MATCH: OFAC"];
  const memo = buildMemo({
    token: { address: "0x87230146E138d3F296a9a77e497A2A830E40684" },
    chain: "ethereum",
    checks: [fakeCheck("audit", 95, 0.02), fakeCheck("holders", 90, 0.01), bad],
    startedAt: 1000,
    finishedAt: 2000,
    signer: wallet.address,
  });
  assert.equal(memo.verdict, "DO NOT LIST");
  assert.equal(memo.vetoes.length, 1);
});

test("memo: memo_id is the keccak256 of the canonical unsigned memo", async () => {
  const wallet = Wallet.createRandom();
  const memo = buildMemo({
    token: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    chain: "ethereum",
    checks: [fakeCheck("audit", 90, 0.02)],
    startedAt: 1000,
    finishedAt: 2000,
    signer: wallet.address,
  });
  const signed = await signMemo(wallet, memo);
  assert.equal(signed.memo_id, memoId(memo));
});

test("renderMemo includes verdict, scores and cost line", () => {
  const wallet = Wallet.createRandom();
  const memo = buildMemo({
    token: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    chain: "ethereum",
    checks: [fakeCheck("audit", 90, 0.02)],
    startedAt: 1000,
    finishedAt: 2000,
    signer: wallet.address,
  });
  const text = renderMemo({ ...memo, memo_id: "0x1234", signature: { signer: wallet.address, signature: "0xabcd" } });
  assert.ok(text.includes("Verdict: LIST"));
  assert.ok(text.includes("COST LINE"));
  assert.ok(text.includes("audit"));
});
