// Signed listing risk memo.
// The memo is a canonical JSON document. The desk signs keccak256 of the
// canonical memo (without the signature block) with its Sepolia wallet key
// via EIP-191 personal_sign, so anyone can verify the memo with
// ethers.verifyMessage and check the memo_id independently:
//   memo_id = keccak256(canonicalMemoWithoutSignature)
import { ethers } from "ethers";
import { verdictFor } from "./checks.js";

export function canonical(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(",")}]`;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

export function memoId(memoWithoutSignature) {
  return ethers.keccak256(ethers.toUtf8Bytes(canonical(memoWithoutSignature)));
}

export function buildMemo({ token, chain, checks, startedAt, finishedAt, signer }) {
  const scored = checks.filter((c) => typeof c.score === "number");
  const totalCostUsd = checks.reduce((a, c) => a + (c.billedUsd ?? c.costUsd ?? 0), 0);
  const { mean, verdict, vetoes } = verdictFor(checks);
  const memo = {
    memo_type: "autonomous-listings-desk/risk-memo",
    version: 1,
    token: { address: token.address, chain, name: token.name ?? null, symbol: token.symbol ?? null },
    issued_at: new Date(finishedAt).toISOString(),
    run_ms: finishedAt - startedAt,
    agent: { signer, network: "Ethereum Sepolia (Telegraph beta 2)", payment: "escrow (test USDC)" },
    scores: scored.map((c) => ({ dimension: c.dimension, intent: c.intent, score: c.score, notes: c.notes })),
    mean_score: mean,
    verdict,
    vetoes,
    checks: checks.map((c) => ({
      id: c.id,
      dimension: c.dimension,
      intent: c.intent,
      miner: c.miner,
      signal_hash: c.signalHash ?? null,
      receipt_hash: c.receiptHash ?? null,
      cost_usd: c.billedUsd ?? c.costUsd ?? null,
      authorized_usd: c.authorizedUsd ?? null,
      latency_ms: c.latencyMs ?? null,
      rail: c.rail ?? null,
      score: c.score ?? null,
      error: c.error ?? null,
      evidence: c.evidence,
    })),
    cost_line: {
      total_usd: Math.round(totalCostUsd * 1e6) / 1e6,
      currency: "test USDC",
      per_check: checks.map((c) => ({ id: c.id, intent: c.intent, usd: c.billedUsd ?? c.costUsd ?? null })),
    },
  };
  return memo;
}

export async function signMemo(wallet, memo) {
  const id = memoId(memo);
  const signature = await wallet.signMessage(ethers.getBytes(id));
  return { ...memo, memo_id: id, signature: { signer: wallet.address, scheme: "EIP-191 personal_sign", signature } };
}

export function verifyMemo(signedMemo) {
  const { memo_id, signature, ...memo } = signedMemo;
  if (!memo_id || !signature?.signature || !signature?.signer) return { valid: false, reason: "missing memo_id or signature" };
  const recomputed = memoId(memo);
  if (recomputed !== memo_id) return { valid: false, reason: `memo_id mismatch: recomputed ${recomputed}` };
  const recovered = ethers.verifyMessage(ethers.getBytes(memo_id), signature.signature);
  if (recovered.toLowerCase() !== signature.signer.toLowerCase()) {
    return { valid: false, reason: `signer mismatch: recovered ${recovered}, memo says ${signature.signer}` };
  }
  return { valid: true, signer: recovered };
}

export function renderMemo(m) {
  const lines = [];
  lines.push(`LISTING RISK MEMO — ${m.token.address} (${m.token.chain})`);
  lines.push(`Issued: ${m.issued_at} · Agent: ${m.agent.signer} · memo_id: ${m.memo_id ?? "(unsigned)"}`);
  lines.push(`Verdict: ${m.verdict} (mean score ${m.mean_score}/100)`);
  if (m.vetoes?.length) lines.push(`VETOES: ${m.vetoes.join(" | ")}`);
  lines.push("");
  for (const c of m.checks) {
    lines.push(`[${c.id}] ${c.dimension} — ${c.intent}`);
    lines.push(`  miner: ${c.miner} · cost: $${c.cost_usd ?? "?"} · signal: ${c.signal_hash ?? "n/a"} · receipt: ${c.receipt_hash ?? "n/a"}`);
    lines.push(`  score: ${c.score ?? "n/a (supporting)"}`);
    lines.push(`  evidence: ${typeof c.evidence === "string" ? c.evidence.slice(0, 400) : JSON.stringify(c.evidence).slice(0, 400)}`);
  }
  lines.push("");
  lines.push(`COST LINE: total $${m.cost_line.total_usd} test USDC across ${m.checks.length} paid checks ` +
    `(${m.cost_line.per_check.map((p) => `${p.id} $${p.usd ?? "?"}`).join(", ")})`);
  if (m.signature) lines.push(`Signature: ${m.signature.signature} (EIP-191, signer ${m.signature.signer})`);
  return lines.join("\n");
}
