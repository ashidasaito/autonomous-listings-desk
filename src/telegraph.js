// Telegraph client for the Autonomous Listings Desk.
// Buys intelligence from the Telegraph beta 2 testnet (Ethereum Sepolia)
// through the official Telegraph MCP server's payment flow (MIT):
//   - Payer: POST /engine/v1/ask with the escrow X-PAYMENT signature
//     (a failed ask is never billed; repeats within a minute are not re-billed)
//   - Chain: read-only escrow account view (balances come from the node ledger)
// On-chain writes (mint test USDC, approve + depositUSDC) use ethers directly.
// No real money: Sepolia testnet only, Telegraph's own test USDC.
//
// Payment flow from the official npm package
// @telegraphprotocol/telegraph-protocol-mcp v2.1.1 (MIT) — installed with
// `npm install`, no vendored copy. The npm package `telegraph-protocol-mcp`
// v1.0.0 is the old IP-based flow and is deliberately NOT used.
// One difference from the vendored source the desk was first built against:
// the npm Payer reports no billed amount, so the desk's cost line uses the
// node's reported cost_usd (as the README says), and the daily spend log
// counts the authorized price per ask, which is the conservative side.
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { Payer } from "@telegraphprotocol/telegraph-protocol-mcp/dist/pay.js";
import { Chain } from "@telegraphprotocol/telegraph-protocol-mcp/dist/chain.js";
import { loadConfig } from "@telegraphprotocol/telegraph-protocol-mcp/dist/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Key + home live in the repo root for a standalone clone (.env, .telegraph/).
// This project was built inside a larger workspace where the key lives one
// level up, so the workspace path is kept as a fallback when no repo-root
// .env exists. A clone only ever needs the repo-root files.
const ENV_PATH = existsSync(join(HERE, "..", ".env"))
  ? join(HERE, "..", ".env")
  : join(HERE, "..", "..", "hidden_files", ".env");
const HOME = existsSync(join(HERE, "..", ".env"))
  ? join(HERE, "..", ".telegraph")
  : join(HERE, "..", "..", "hidden_files", "telegraph-home");

// --- minimal .env loader (no dependency) ---------------------------------
export function loadEnv(path = ENV_PATH) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2];
  }
  return out;
}

// --- constants (verified against the live network + official source) -------
export const TELEGRAPH = {
  url: "https://devnode.telegraphprotocol.com",
  chainId: 11155111,
  chainName: "Ethereum Sepolia",
  diamond: "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b", // escrow (ledger diamond)
  usdc: "0xcc194e1a843B658526D0D5C431f670028582Ae17", // Telegraph test USDC (not Circle's)
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  maxBudgetUsdc: 260000, // μUSDC, $0.26 — the most the testnet node takes per ask
  maxAskUsd: 0.5, // refuse to sign for one ask above this
  dailyLimitUsd: 5, // refuse once today's asks reach this (UTC day)
};

const USDC_ABI = [
  "function mint(address to, uint256 amount)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];
const DIAMOND_ABI = ["function depositUSDC(uint256 amount)", "function usdcToken() view returns (address)"];

export class TelegraphClient {
  constructor(env = loadEnv()) {
    this.env = env;
    if (!env.TELEGRAPH_PRIVATE_KEY) throw new Error("TELEGRAPH_PRIVATE_KEY missing — run scripts/gen-wallet first (see README).");
    mkdirSync(HOME, { recursive: true });
    const cfgEnv = {
      ...process.env,
      TELEGRAPH_URL: env.TELEGRAPH_URL || TELEGRAPH.url,
      TELEGRAPH_PRIVATE_KEY: env.TELEGRAPH_PRIVATE_KEY,
      TELEGRAPH_DIAMOND: env.TELEGRAPH_DIAMOND || TELEGRAPH.diamond,
      TELEGRAPH_CHAIN_ID: String(env.TELEGRAPH_CHAIN_ID || TELEGRAPH.chainId),
      TELEGRAPH_RPC_URL: env.TELEGRAPH_RPC_URL || TELEGRAPH.rpcUrl,
      TELEGRAPH_HOME: HOME,
      TELEGRAPH_PAYMENT: env.TELEGRAPH_PAYMENT || "escrow",
      TELEGRAPH_MAX_ASK_USD: String(TELEGRAPH.maxAskUsd),
      TELEGRAPH_DAILY_LIMIT_USD: String(TELEGRAPH.dailyLimitUsd),
      TELEGRAPH_MAX_BUDGET_USDC: String(TELEGRAPH.maxBudgetUsdc),
    };
    this.cfg = loadConfig(cfgEnv);
    this.payer = new Payer(this.cfg, this.cfg.privateKey);
    this.chain = new Chain(this.cfg);
    this.provider = new ethers.JsonRpcProvider(this.cfg.rpcUrl);
    this.wallet = new ethers.Wallet(this.cfg.privateKey, this.provider);
    this.address = this.wallet.address;
    this.usdc = new ethers.Contract(TELEGRAPH.usdc, USDC_ABI, this.wallet);
    this.diamond = new ethers.Contract(TELEGRAPH.diamond, DIAMOND_ABI, this.wallet);
  }

  // --- free discovery ------------------------------------------------------
  async listIntents() {
    const res = await fetch(`${this.cfg.url}/engine/v1/intents`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET /engine/v1/intents failed: HTTP ${res.status}`);
    const d = await res.json();
    // The node returns intent_name / miner_count / lifecycle_state (not "name").
    return (d.intents || []).map((i) => ({
      name: i.intent_name,
      miner_count: i.miner_count ?? null,
      description: i.description ?? "",
      lifecycle_state: i.lifecycle_state ?? null,
      canonical: !!i.canonical,
    }));
  }

  async intentDetail(intent) {
    const res = await fetch(`${this.cfg.url}/engine/v1/intents/${encodeURIComponent(intent)}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET /engine/v1/intents/${intent} failed: HTTP ${res.status}`);
    return res.json();
  }

  async ledger() {
    const res = await fetch(`${this.cfg.url}/v1/ledger/account/${this.address}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET /v1/ledger/account failed: HTTP ${res.status}`);
    return res.json();
  }

  async account() {
    return this.chain.account(this.address);
  }

  async verifySignal(signalHash) {
    const res = await fetch(`${this.cfg.url}/engine/v1/signal/${encodeURIComponent(signalHash)}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET /engine/v1/signal/${signalHash} failed: HTTP ${res.status}`);
    return res.json();
  }

  // --- one paid ask --------------------------------------------------------
  // body: { query?, intent?, params? }. Returns the normalized purchase.
  async ask({ query, intent, params }) {
    if (params && !intent) throw new Error("params need an intent");
    if (!query && !params) throw new Error("give a query, or an intent with params");
    const started = Date.now();
    const body = {
      ...(query ? { query } : {}),
      ...(intent ? { intent: intent.trim().toUpperCase() } : {}),
      ...(params ? { params } : {}),
      max_budget_usdc: TELEGRAPH.maxBudgetUsdc,
    };
    const r = await this.payer.post("/engine/v1/ask", body);
    const latencyMs = Date.now() - started;
    if (r.status < 200 || r.status >= 300) {
      const b = r.body && typeof r.body === "object" ? r.body : { error: String(r.body) };
      const err = new Error(`ask failed: HTTP ${r.status}: ${b.error || b.reason || b.message || "no reason given"}`);
      err.status = r.status;
      err.body = b;
      err.escrowRefused = r.escrowRefused;
      throw err;
    }
    const b = r.body || {};
    const receipt = r.receipt || {};
    return {
      ok: true,
      intent: b.intent || intent,
      miner: b.miner_name ? `${b.miner_name} (id ${b.miner_id})` : b.miner_id ? `id ${b.miner_id}` : "unknown",
      minerId: b.miner_id ?? null,
      result: b.result ?? null,
      resultShape: b.result_shape ?? null,
      fieldStatus: b.field_status ?? null,
      fulfillment: b.fulfillment ?? null,
      costUsd: b.cost_usd ?? r.billedUsd ?? null,
      billedUsd: r.billedUsd ?? null,
      authorizedUsd: r.priceUsd ?? null,
      rail: r.rail ?? null,
      receipt,
      signalHash: receipt.signal_hash || receipt.signalHash || b.signal_hash || null,
      receiptHash: receipt.receipt_hash || receipt.receiptHash || b.receipt_hash || null,
      repeated: !!r.repeated,
      latencyMs,
      warnings: b.warnings ?? [],
    };
  }

  // --- funding (on-chain, Sepolia testnet only) -----------------------------
  async balances() {
    const [eth, usdc] = await Promise.all([this.provider.getBalance(this.address), this.usdc.balanceOf(this.address)]);
    const ledger = await this.ledger().catch(() => null);
    return {
      address: this.address,
      eth: Number(ethers.formatEther(eth)),
      usdc: Number(ethers.formatUnits(usdc, 6)),
      escrowSpendableUsd: ledger ? Number(ledger.available ?? 0) / 1e6 : null,
      escrowBalanceUsd: ledger ? Number(ledger.balance ?? 0) / 1e6 : null,
    };
  }

  // Mint Telegraph test USDC directly (mint(address,uint256) is open to anyone).
  async mintUsdc(amountUsd) {
    const amount = ethers.parseUnits(amountUsd.toFixed(6), 6);
    const tx = await this.usdc.mint(this.address, amount);
    const receipt = await tx.wait();
    if (receipt.status !== 1n && receipt.status !== 1) throw new Error(`mint reverted (tx ${tx.hash})`);
    return { txHash: tx.hash, amountUsd };
  }

  // approve (if short) then depositUSDC into the Telegraph escrow.
  async deposit(amountUsd) {
    const amount = ethers.parseUnits(amountUsd.toFixed(6), 6);
    const have = await this.usdc.balanceOf(this.address);
    if (have < amount) throw new Error(`wallet holds ${ethers.formatUnits(have, 6)} test USDC, less than ${amountUsd}`);
    const txs = [];
    const allowance = await this.usdc.allowance(this.address, TELEGRAPH.diamond);
    if (allowance < amount) {
      const tx = await this.usdc.approve(TELEGRAPH.diamond, amount);
      const rc = await tx.wait();
      if (rc.status !== 1) throw new Error(`approve reverted (tx ${tx.hash})`);
      txs.push({ step: "approve", txHash: tx.hash });
    }
    const tx = await this.diamond.depositUSDC(amount);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`depositUSDC reverted (tx ${tx.hash})`);
    txs.push({ step: "depositUSDC", txHash: tx.hash });
    const after = await this.balances();
    return { amountUsd, transactions: txs, escrowSpendableUsd: after.escrowSpendableUsd };
  }
}
