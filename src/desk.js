// Autonomous Listings Desk — CLI entry point.
//   node src/desk.js <tokenAddress> [--handle <xHandle>] [--name <n>] [--symbol <s>]
//                     [--chain ethereum] [--out <dir>] [--skip-fund-check]
//
// Takes a token contract address, buys the desk's checks in parallel through
// Telegraph (escrow, test USDC), scores each dimension, and issues a signed
// listing risk memo (verdict + evidence per check + cost line).
// All on testnet. No real money, no trades.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { TelegraphClient, loadEnv, TELEGRAPH } from "./telegraph.js";
import { CHECKS } from "./checks.js";
import { buildMemo, signMemo, verifyMemo, renderMemo } from "./memo.js";

// Per-chain public endpoints (no keys). ONCHAIN_METRIC_VERIFY's chain enum is
// ethereum/polygon/arbitrum only, so chains outside it skip that check.
export const CHAINS = {
  ethereum: {
    label: "Ethereum mainnet",
    chainId: 1,
    rpc: "https://ethereum-rpc.publicnode.com",
    sourcifyChainId: 1,
    explorer: "https://etherscan.io",
    blockscout: "https://eth.blockscout.com",
    holderChain: "ethereum",
    metricChain: "ethereum",
  },
  bsc: {
    label: "BNB Smart Chain",
    chainId: 56,
    rpc: "https://bsc-dataseed.binance.org",
    sourcifyChainId: 56,
    explorer: "https://bscscan.com",
    blockscout: null, // no public no-key creation endpoint found; deployer falls back to the token address
    holderChain: "bsc",
    metricChain: null,
  },
};
const ERC20_META_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

// --- context resolvers (public, no keys; each failure falls back gracefully)
export async function resolveTokenMeta(address, chainCfg) {
  const provider = new ethers.JsonRpcProvider(chainCfg.rpc);
  const [block, token] = await Promise.all([
    provider.getBlockNumber().catch(() => null),
    (async () => {
      const c = new ethers.Contract(address, ERC20_META_ABI, provider);
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        c.name().catch(() => null),
        c.symbol().catch(() => null),
        c.decimals().catch(() => null),
        c.totalSupply().catch(() => null),
      ]);
      return { name, symbol, decimals, totalSupply: totalSupply?.toString() ?? null };
    })(),
  ]);
  return { block, ...token };
}

export async function resolveDeployer(address, chainCfg) {
  // Blockscout public API (no key): contract creation info.
  if (!chainCfg.blockscout) return { deployer: null, note: `no no-key creation endpoint for ${chainCfg.label}; sanctions check screens the token address itself` };
  try {
    const res = await fetch(
      `${chainCfg.blockscout}/api?module=contract&action=getcontractcreation&contractaddresses=${address}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) return { deployer: null, note: `blockscout HTTP ${res.status}` };
    const d = await res.json();
    const creator = d?.result?.[0]?.contractCreator;
    return creator ? { deployer: creator, note: "via eth.blockscout.com getcontractcreation" } : { deployer: null, note: "blockscout returned no creator" };
  } catch (e) {
    return { deployer: null, note: `blockscout fetch failed: ${e.message}` };
  }
}

export async function resolveCode(address, chainCfg) {
  // Sourcify API v2 (public, no key; v1 was turned off 7 Jul 2026):
  // GET https://sourcify.dev/server/v2/contract/{chainId}/{address}?fields=all
  const base = `https://sourcify.dev/server/v2/contract/${chainCfg.sourcifyChainId}/${address}?fields=all`;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return { code: null, codeUrl: `${chainCfg.explorer}/address/${address}#code`, note: `sourcify v2 HTTP ${res.status}; falling back to explorer link` };
      const d = await res.json();
      const files = d?.sources ? Object.values(d.sources) : [];
      const text = files.map((f) => f?.content || "").filter(Boolean).join("\n");
      if (!text.trim()) return { code: null, codeUrl: `${chainCfg.explorer}/address/${address}#code`, note: "sourcify v2 returned no source text; falling back to explorer link" };
      const match = [d.creationMatch, d.runtimeMatch].filter(Boolean).join("/");
      const code = mainContractSlice(text);
      return { code, codeUrl: `https://repo.sourcify.dev/${chainCfg.sourcifyChainId}/${address}`, note: `sourcify v2 (match: ${match || "?"}), ${text.length} chars, main-contract slice ${code.length} chars` };
    } catch (e) {
      lastErr = e;
      if (attempt === 2) return { code: null, codeUrl: `${chainCfg.explorer}/address/${address}#code`, note: `sourcify v2 fetch failed (2 attempts): ${e.message}; falling back to explorer link` };
    }
  }
  return { code: null, codeUrl: `${chainCfg.explorer}/address/${address}#code`, note: `sourcify v2 fetch failed: ${lastErr?.message}; falling back to explorer link` };
}

// Flattened verified source starts with library/proxy boilerplate; the token
// contract itself is usually last (SQUID.sol: proxy boilerplate 0-6.7k, the
// ERC20 base, then `contract SQUIDToken` at 39,960 of 40,779 chars — the
// first 6,000 chars never show the token logic). Send the main contract:
// start at the last `contract X is ...` declaration, preferring one that
// inherits ERC20/ERC721, and backfill to 6,000 chars so the tail (the token
// contract) is always included.
export function mainContractSlice(text, maxLen = 6000) {
  if (text.length <= maxLen) return text;
  const matches = [...text.matchAll(/contract\s+\w+\s+is\s+[^{]+\{/g)];
  let start = matches.length ? matches[matches.length - 1].index : 0;
  const erc = matches.filter((m) => /ERC20|ERC721/.test(m[0]));
  if (erc.length) start = erc[erc.length - 1].index;
  if (text.length - start < maxLen) start = Math.max(0, text.length - maxLen);
  return text.slice(start, start + maxLen);
}

export async function runDesk({ tokenAddress, handle, name, symbol, chain = "ethereum", outDir = "out", env = loadEnv() }) {
  const startedAt = Date.now();
  const chainCfg = CHAINS[chain];
  if (!chainCfg) throw new Error(`unsupported chain "${chain}"; supported: ${Object.keys(CHAINS).join(", ")}`);
  const client = new TelegraphClient(env);
  const address = ethers.getAddress(tokenAddress);
  const notes = [];

  const [meta, deployerRes, codeRes] = await Promise.all([
    resolveTokenMeta(address, chainCfg),
    resolveDeployer(address, chainCfg),
    resolveCode(address, chainCfg),
  ]);
  notes.push(`token meta: name=${meta.name ?? "?"} symbol=${meta.symbol ?? "?"} block=${meta.block ?? "?"}`);
  notes.push(`deployer: ${deployerRes.deployer ?? "unknown"} (${deployerRes.note})`);
  notes.push(`code: ${codeRes.note}`);

  const ctx = {
    address,
    chain,
    chainLabel: chainCfg.label,
    holderChain: chainCfg.holderChain,
    metricChain: chainCfg.metricChain,
    handle: handle || null,
    name: name || meta.name,
    symbol: symbol || meta.symbol,
    deployer: deployerRes.deployer,
    block: meta.block,
    code: codeRes.code,
    codeUrl: codeRes.codeUrl,
  };
  if (!ctx.handle) throw new Error("a social handle is required for the social-bot check: pass --handle <xHandle>");
  if (ctx.metricChain && !ctx.block) throw new Error("could not read the latest block (needed by ONCHAIN_METRIC_VERIFY); retry later");

  const activeChecks = CHECKS.filter((c) => !c.chains || c.chains.includes(chain));
  if (activeChecks.length < CHECKS.length) {
    notes.push(`skipped for ${chainCfg.label}: ${CHECKS.filter((c) => c.chains && !c.chains.includes(chain)).map((c) => c.id).join(", ")}`);
  }

  // Balance guard: escrow must cover the worst case (all checks at max budget).
  const balances = await client.balances();
  const worstCaseUsd = activeChecks.length * TELEGRAPH.maxBudgetUsdc / 1e6;
  if ((balances.escrowSpendableUsd ?? 0) < worstCaseUsd) {
    throw new Error(
      `escrow spendable is $${balances.escrowSpendableUsd ?? 0}, need $${worstCaseUsd.toFixed(2)} to cover ${activeChecks.length} checks at max budget. ` +
        `Run: node src/fund.js (mints test USDC and deposits into escrow). Wallet: ${balances.address}`,
    );
  }

  // Buy all checks in parallel.
  const results = await Promise.all(
    activeChecks.map(async (check) => {
      const input = check.buildInput(ctx);
      try {
        const ask = await client.ask(input.intent ? { intent: input.intent, params: input.params } : { query: input.query });
        const scored = check.score(ask.result);
        return {
          ...check, miner: ask.miner, result: ask.result,
          signalHash: ask.signalHash, receiptHash: ask.receiptHash,
          costUsd: ask.costUsd, billedUsd: ask.billedUsd, authorizedUsd: ask.authorizedUsd,
          rail: ask.rail, latencyMs: ask.latencyMs, repeated: ask.repeated,
          score: scored.score, veto: !!scored.veto, notes: scored.notes,
          evidence: summarizeEvidence(check.id, ask.result),
        };
      } catch (e) {
        return {
          ...check, miner: null, result: null, error: e.message,
          score: null, notes: [`BUY FAILED: ${e.message}`], evidence: null,
        };
      }
    }),
  );

  const failed = results.filter((r) => r.error);
  if (failed.length) {
    // A failed buy is reported, not hidden: the memo is still issued for the
    // checks that succeeded, and the failures are listed as evidence gaps.
    notes.push(`WARNING: ${failed.length} check(s) failed to buy: ${failed.map((f) => `${f.id} (${f.error})`).join("; ")}`);
  }

  const finishedAt = Date.now();
  const memo = buildMemo({ token: { address, name: ctx.name, symbol: ctx.symbol }, chain, checks: results, startedAt, finishedAt, signer: client.address });
  memo.context_notes = notes;
  const signed = await signMemo(client.wallet, memo);
  const check = verifyMemo(signed);
  if (!check.valid) throw new Error(`memo self-verification failed: ${check.reason}`);

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date(finishedAt).toISOString().replace(/[:.]/g, "-");
  const base = join(outDir, `memo-${address.slice(0, 10)}-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(signed, null, 2));
  writeFileSync(`${base}.txt`, renderMemo(signed));
  const ledgerEntry = {
    at: new Date(finishedAt).toISOString(), token: address, chain, memo_id: signed.memo_id,
    verdict: signed.verdict, mean_score: signed.mean_score, total_usd: signed.cost_line.total_usd,
    checks: signed.checks.map((c) => ({ id: c.id, intent: c.intent, miner: c.miner, signal_hash: c.signal_hash, receipt_hash: c.receipt_hash, cost_usd: c.cost_usd })),
  };
  writeFileSync(join(outDir, "ledger.jsonl"), JSON.stringify(ledgerEntry) + "\n", { flag: "a" });
  return { memo: signed, memoPath: `${base}.json`, memoTextPath: `${base}.txt`, verified: check, balances };
}

function summarizeEvidence(id, result) {
  if (result == null) return null;
  if (typeof result === "string") return result.slice(0, 8000);
  // Keep the typed answer fields; drop nothing the reviewer needs.
  return result;
}

// --- CLI -------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const tokenAddress = args._[0];
  if (!tokenAddress) {
    console.error("Usage: node src/desk.js <tokenAddress> [--handle <xHandle>] [--name <n>] [--symbol <s>] [--chain ethereum] [--out <dir>]");
    process.exit(2);
  }
  runDesk({
    tokenAddress,
    handle: args.handle === true ? undefined : args.handle,
    name: args.name === true ? undefined : args.name,
    symbol: args.symbol === true ? undefined : args.symbol,
    chain: args.chain === true ? "ethereum" : args.chain,
    outDir: args.out === true ? "out" : args.out || "out",
  })
    .then(({ memo, memoPath, memoTextPath, verified }) => {
      console.log(renderMemo(memo));
      console.log(`\nMemo written: ${memoPath}\nText: ${memoTextPath}\nSelf-verification: ${verified.valid ? "VALID" : "INVALID"}`);
    })
    .catch((e) => {
      console.error(`DESK FAILED: ${e.message}`);
      process.exit(1);
    });
}
