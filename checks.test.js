import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreHolders,
  scoreSanctions,
  scoreCodeReview,
  scoreSocialBot,
  scoreAuditText,
  verdictFor,
  CHECKS,
  textOf,
} from "../src/checks.js";

test("holder concentration: log scale (1->0, 10->25, 100->50, 1000->75, 10000->100)", () => {
  assert.equal(scoreHolders({ holders_count: 1 }).score, 0);
  assert.equal(scoreHolders({ holders_count: 10 }).score, 25);
  assert.equal(scoreHolders({ holders_count: 100 }).score, 50);
  assert.equal(scoreHolders({ holders_count: 1000 }).score, 75);
  assert.equal(scoreHolders({ holders_count: 10000 }).score, 100);
  assert.equal(scoreHolders({ holders_count: 500000 }).score, 100);
  assert.equal(scoreHolders({ holders_count: 50 }).score, 42);
  assert.ok(scoreHolders({ holders_count: 5 }).notes.join(" ").includes("fewer than 100"));
});

test("holder concentration: missing count scores neutral, not zero", () => {
  assert.equal(scoreHolders({}).score, 50);
  assert.equal(scoreHolders(null).score, 50);
});

test("sanctions: match is a hard veto, no match is 100", () => {
  const hit = scoreSanctions({ matched: true, matches: [{ name: "X", lists: ["OFAC"] }] });
  assert.equal(hit.score, 0);
  assert.equal(hit.veto, true);
  assert.equal(scoreSanctions({ matched: false, matches: [] }).score, 100);
  assert.equal(scoreSanctions({}).score, 50);
});

test("code review: verdict mapping with findings penalty", () => {
  assert.equal(scoreCodeReview({ verdict: "Approve", findings: [] }).score, 100);
  assert.equal(scoreCodeReview({ verdict: "Approve", findings: [1, 2] }).score, 90);
  assert.equal(scoreCodeReview({ verdict: "Comment", findings: [] }).score, 70);
  assert.equal(scoreCodeReview({ verdict: "Request changes", findings: [] }).score, 30);
  assert.equal(scoreCodeReview({}).score, 50);
});

test("social bot: verdict mapping and bot_score blend", () => {
  assert.equal(scoreSocialBot({ verdict: "human", bot_score: 0.05 }).score, 100);
  assert.equal(scoreSocialBot({ verdict: "likely_human" }).score, 80);
  assert.equal(scoreSocialBot({ verdict: "inconclusive" }).score, 50);
  assert.equal(scoreSocialBot({ verdict: "likely_bot" }).score, 20);
  assert.equal(scoreSocialBot({ verdict: "bot", bot_score: 0.97 }).score, 0);
  assert.equal(scoreSocialBot({ bot_score: 0.3 }).score, 70);
  assert.equal(scoreSocialBot({}).score, 50);
});

test("audit text: honeypot/backdoor language drops the score hard", () => {
  const bad = scoreAuditText("The contract contains a honeypot mechanism and a backdoor that lets the owner drain funds. Verdict: UNSAFE.");
  assert.ok(bad.score <= 40, `expected <=40, got ${bad.score}`);
  const clean = scoreAuditText("No critical or high issues found. The contract appears safe. Verdict: SAFE.");
  assert.ok(clean.score >= 90, `expected >=90, got ${clean.score}`);
  assert.equal(scoreAuditText("").score, 50);
  assert.equal(scoreAuditText(null).score, 50);
});

test("audit text: live 20 Nov SQUID phrasings fire the concentration rule", () => {
  // Regression (20 Nov 2026): two live SQUID audits stated the
  // mint-to-deployer fact but neither used the "held by" wording, so the
  // old rule missed both and one run scored the honeypot 100 -> LIST.
  // Both phrasings must veto; the USDC proxy shape must stay clean.
  const run1 =
    "3. **Is the entire supply held by one address?**\n\n" +
    "*   No, the entire supply is not held by one address. The `INITIAL_TOTAL_SUPPLY` is minted to `msg.sender` during initialization. " +
    "If the contract is deployed by an owner, that owner will initially hold the entire supply.";
  const s1 = scoreAuditText(run1);
  assert.ok(s1.score < 50, `SQUID run-1 shape should be <50, got ${s1.score}`);
  assert.ok(s1.notes.join(" ").includes("critical concentration"));
  const run2 =
    "3. **Entire Supply Held by One Address:**\n\n" +
    "*   **Finding:** The `INITIAL_TOTAL_SUPPLY` is minted to `msg.sender` during the `initialize` function. " +
    "If the contract is deployed by a single entity, then initially, that entity will hold the entire supply.";
  const s2 = scoreAuditText(run2);
  assert.ok(s2.score < 50, `SQUID run-2 shape should be <50, got ${s2.score}`);
  assert.ok(s2.notes.join(" ").includes("critical concentration"));
  // A generic definition of "honeypot" is not a finding about this contract.
  const defn = scoreAuditText(
    "A honeypot is typically created by having a contract that allows users to deposit funds but prevents them from withdrawing. Verdict: SAFE.",
  );
  assert.equal(defn.score, 100);
});

test("audit text: severity-labelled findings and centralization (live SQUID shape)", () => {
  // Real openai-miner answer shape for the SQUID tail (19 Nov 2026).
  const squid = [
    "1. **Unlimited Minting/Fund Draining:**",
    "   *   **Finding:** The `_mint` function is called only once during initialization to mint the `INITIAL_TOTAL_SUPPLY` to `msg.sender` (the owner).",
    "   *   **Severity:** Low",
    "3. **Supply Held by One Address:**",
    "   *   **Finding:** The `INITIAL_TOTAL_SUPPLY` is minted to `msg.sender` during initialization. If `msg.sender` is the owner, then the entire initial supply will be held by the owner.",
    "   *   **Severity:** Medium",
    "8. **Honeypot Behaviour:**",
    "   *   **Finding:** The contract itself does not exhibit typical honeypot characteristics like preventing token transfers or sales.",
  ].join("\n");
  const s = scoreAuditText(squid);
  assert.ok(s.score < 50, `SQUID audit should be <50, got ${s.score}`);
  assert.ok(s.notes.join(" ").includes("critical concentration"));
  // The USDC proxy answer shape: explicit SAFE, severities all Not Applicable.
  const usdc = "1. **Can the owner mint unlimited tokens?**\n   *   **Severity:** Not Applicable (for this contract)\n   *   **Finding:** The proxy contract itself does not contain any minting logic.\n\n**Overall Verdict:**\n\n**SAFE** (with a significant caveat)\n\n**Caveat:** This verdict applies only to the proxy contract itself.";
  assert.equal(scoreAuditText(usdc).score, 100);
});

test("audit text: negated and heading mentions do not count as findings", () => {
  // "cannot exhibit ... honeypot behaviour" is a negation, not a finding.
  const neg = scoreAuditText("The proxy contract cannot exhibit reentrancy, hidden minting, blacklisting, or honeypot behavior on its own. Verdict: SAFE.");
  assert.equal(neg.score, 100);
  // A section heading that merely names the topic is not a finding.
  const head = scoreAuditText("8. **Honeypot Behaviour:**\n   *   **Finding:** The contract does not exhibit typical honeypot characteristics.\n   *   **Severity:** None.\n\n**Overall Verdict:** **SAFE**");
  assert.equal(head.score, 100);
  // Regression (live USDC, 19 Nov 2026): the miner echoes the question's
  // checklist as a numbered bold heading — that mention must not veto.
  const echo = scoreAuditText(
    "**4. Reentrancy, access control flaws, hidden mint, blacklist or honeypot behaviour.**\n\n" +
    "*   **Reentrancy:** The proxy contract includes a `_willFallback()` function which is called before delegating to the implementation.\n\n" +
    "**Overall Verdict:**\n\n**SAFE**",
  );
  assert.equal(echo.score, 100);
});

test("audit text: inconclusive answers score neutral, never clean", () => {
  assert.equal(scoreAuditText("The provided contract code is incomplete. Without the complete code, it's impossible to fully audit. To provide a comprehensive audit, please provide the complete contract code.").score, 50);
  assert.equal(scoreAuditText("I need the smart contract source code to perform an audit. Please provide the Solidity code for the token.").score, 50);
  // ASTSec-style structured answer: "Needs changes" with 0 findings.
  assert.equal(scoreAuditText({ verdict: "Needs changes", vulnerability_count: 0, issues: null, summary: "0 published-rule security hotspots found in 1 JavaScript source block." }).score, 50);
});

test("code review: 'Approve' that evaluated nothing scores neutral", () => {
  const inconclusive = scoreCodeReview({
    verdict: "Approve",
    findings: null,
    summary: "The provided link points to an external smart contract address rather than an explicit code change. Without the source code or a specific description of a modification to review, no concrete correctness bug or risk can be evaluated.",
  });
  assert.equal(inconclusive.score, 50);
  // An Approve WITH an empty findings array is still a clean bill.
  assert.equal(scoreCodeReview({ verdict: "Approve", findings: [] }).score, 100);
});

test("verdict: a critical audit vetoes even when the mean is high", () => {
  const scores = [
    { id: "contract_audit", dimension: "Contract audit", score: 25, notes: ["entire supply minted to a single address"] },
    { id: "holder_concentration", dimension: "Holder concentration", score: 100, notes: [] },
    { id: "sanctions", dimension: "Sanctions exposure", score: 100, notes: [] },
    { id: "code_review", dimension: "Contributor authenticity", score: 20, notes: [] },
    { id: "social_bot", dimension: "Social authenticity", score: 80, notes: [] },
  ];
  const v = verdictFor(scores);
  assert.equal(v.verdict, "DO NOT LIST");
  assert.equal(v.vetoes.length, 1);
  assert.ok(v.vetoes[0].includes("Contract audit"));
});

test("verdict: mean thresholds and veto override", () => {
  const mk = (scores) => scores.map((s, i) => ({ id: `c${i}`, dimension: `d${i}`, score: s }));
  assert.equal(verdictFor(mk([100, 90, 80, 85, 90])).verdict, "LIST");
  assert.equal(verdictFor(mk([70, 60, 65, 70, 60])).verdict, "LIST WITH CONDITIONS");
  assert.equal(verdictFor(mk([20, 30, 10, 40, 25])).verdict, "DO NOT LIST");
  const vetoed = mk([100, 100, 100, 100, 100]);
  vetoed[0].veto = true;
  vetoed[0].notes = ["sanctions MATCH"];
  const v = verdictFor(vetoed);
  assert.equal(v.verdict, "DO NOT LIST");
  assert.equal(v.vetoes.length, 1);
});

test("check catalogue: six checks, five scored dimensions, live intent names", () => {
  assert.equal(CHECKS.length, 6);
  const intents = CHECKS.map((c) => c.intent);
  assert.ok(intents.every((i) => i.endsWith("_GENERAL")));
  assert.deepEqual(intents, [
    "SMART_CONTRACT_AUDIT_GENERAL",
    "TOKEN_HOLDER_COUNT_GENERAL",
    "SANCTIONS_SCREENING_MATCH_GENERAL",
    "CODE_REVIEW_GENERAL",
    "SOCIAL_BOT_DETECTION_GENERAL",
    "ONCHAIN_METRIC_VERIFY_GENERAL",
  ]);
  const scored = CHECKS.filter((c) => c.score({ holders_count: 100 }).score !== null);
  assert.ok(scored.length >= 5);
  // every check builds an input for a minimal context
  const ctx = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chain: "ethereum", chainLabel: "Ethereum mainnet", holderChain: "ethereum", metricChain: "ethereum", handle: "circle", deployer: "0x0000000000000000000000000000000000000000", block: 24000000, code: "contract X {}", codeUrl: "https://example.com" };
  for (const c of CHECKS) {
    const input = c.buildInput(ctx);
    assert.ok(input.query || input.intent, `check ${c.id} builds no input`);
  }
});

test("textOf handles strings, objects, null", () => {
  assert.equal(textOf("abc"), "abc");
  assert.equal(textOf({ a: 1 }), '{"a":1}');
  assert.equal(textOf(null), "");
});
