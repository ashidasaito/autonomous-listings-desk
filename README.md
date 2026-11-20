# Autonomous Listings Desk

Telegraph Hackathon Season II — track **Apps & Agents**, **Mission 01 Exchange**.

Give it a token contract address. It buys intelligence checks **in parallel
through Telegraph** (beta 2, Ethereum Sepolia, test USDC, escrow payments)
and issues a **signed listing risk memo** — verdict, evidence per check, and
a total cost line — for a listing venue deciding whether to list that token.

**Status (20 Nov 2026): built, unit-tested (21/21 PASS), and live-run
against the real Telegraph node. First paid purchase done 19 Nov. Full clean
live re-run done 20 Nov, two runs, 2 pass / 0 fail: USDC → LIST, SQUID →
DO NOT LIST.** The history in `out/` includes the early runs that got it
wrong — they are kept as evidence, not deleted. See
[Live results](#live-results) for what was wrong and what changed.

## What it does

A listing team gets a new token and has to answer one question: is this
safe to list? The Desk automates the first pass:

| Dimension | Intent (live catalogue name) | Miners | Input | Score |
|---|---|---|---|---|
| Contract audit | `SMART_CONTRACT_AUDIT_GENERAL` | 19 | contract source (see below) | findings-based heuristic |
| Holder concentration | `TOKEN_HOLDER_COUNT_GENERAL` | 20 | token + chain | log scale (1→0 … 10,000+→100) |
| Sanctions exposure | `SANCTIONS_SCREENING_MATCH_GENERAL` | 28 | deployer address, else token address | match = 0 + hard veto |
| Contributor authenticity | `CODE_REVIEW_GENERAL` | 17 | verified source, else explorer link | verdict mapping |
| Social authenticity | `SOCIAL_BOT_DETECTION_GENERAL` | 16 | X handle | verdict / bot_score |
| Deployer activity (supporting, unscored) | `ONCHAIN_METRIC_VERIFY_GENERAL` | 44 | deployer + latest block + tx_count | evidence only |

Verdict: mean of the five scored dimensions — ≥80 **LIST**, 50–79
**LIST WITH CONDITIONS**, <50 **DO NOT LIST**. Two hard vetoes override the
mean: a sanctions match, or a **critical contract audit** (score <50 —
honeypot/backdoor language, severity-labelled Critical findings, or the
entire supply minted to one address) forces **DO NOT LIST**. The audit veto
exists because of a real failure: in the first live run SQUID scored 96 and
got LIST — holder count and sanctions outvoted an audit that had never seen
the contract.

### The audit ask — send the source, not just a question

The audit check sends the contract source as the `contract` parameter plus
a `question` parameter (both inside `params`). This matters. Verified live
19 Nov 2026: a plain-language question **without** source is routed by the
node to a JavaScript lint miner that analyses the *question text itself*
(0 hotspots) — the audit then scores 100 for any token, clean or scam.
With the source sent, the node routes to a real auditor (openai miner) that
returns severity-labelled findings and a verdict. Without source (Sourcify
unreachable) the desk falls back to the plain question and the scorer treats
an inconclusive answer as neutral (50), never clean.

The source sent is the **main-contract slice**: flattened verified source
starts with library/proxy boilerplate, so the desk slices from the last
`contract X is ...` declaration (preferring one that inherits ERC20/ERC721)
and backfills to 6,000 chars, so the token contract itself is always
included (SQUID.sol: the token contract sits at 39,960 of 40,779 chars —
the first 6,000 chars never show the token logic). Sourcify fetch retries
once on timeout.

### Intent names — verified live, not copied from the mission page

The mission page
([hackathon.telegraphprotocol.com/missions/exchange](https://hackathon.telegraphprotocol.com/missions/exchange))
shows the short names (`SMART_CONTRACT_AUDIT`, …). The live catalogue
(`GET https://devnode.telegraphprotocol.com/engine/v1/intents`, 136 intents,
verified 19 Nov 2026) only accepts the **`_GENERAL`-suffixed** names above.
Two facts from the live schema shaped the design:

- `SMART_CONTRACT_AUDIT_GENERAL` has **no declared request/response schema**
  (lifecycle `registered`), so the desk asks it in plain language plus the
  source.
- `ONCHAIN_METRIC_VERIFY_GENERAL` reads **one address's native balance /
  nonce** — it cannot measure holder concentration. The mission example
  lists it for that dimension, but the live catalogue has
  `TOKEN_HOLDER_COUNT_GENERAL` for exactly that, so the desk buys the latter
  for the holder-concentration dimension and buys the former separately as
  supporting deployer-activity evidence. This substitution is documented in
  the memo's context notes, not hidden.

Full intent list and per-intent schemas: `GET /engine/v1/intents/<NAME>`
(free). Docs: [docs.telegraphprotocol.com](https://docs.telegraphprotocol.com).

## Quick start

Prerequisites: Node.js 20+ and nothing else. No API keys. All data sources
are public; all payments are Sepolia test USDC.

```bash
npm install
npm test                    # offline unit tests (scoring, memo sign/verify) — spends nothing
node test/smoke.mjs         # free live checks: intents, balances, resolvers

node src/fund.js            # mint 10 test USDC, deposit 5 into escrow (needs Sepolia ETH)
npm start -- 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --handle circle
# or: node src/desk.js <tokenAddress> --handle <xHandle> [--chain ethereum|bsc] [--out out]

npm run test:live           # runs the desk on both fixtures, asserts verdicts
```

The desk writes `out/memo-<addr>-<timestamp>.json` (signed memo) and
`.txt` (human-readable), and appends a line to `out/ledger.jsonl` per run
(token, memo_id, verdict, total cost, and every signal/receipt hash).

## How the purchase works

The desk reuses the official Telegraph MCP server's payment flow
([telegraphprotocol/Telegraph-MCP](https://github.com/telegraphprotocol/telegraph-mcp),
v2.1.1, MIT) from the npm package `@telegraphprotocol/telegraph-protocol-mcp`
— installed with `npm install`, no vendored copy; its `Payer` and `Chain`
classes are imported by `src/telegraph.js`. The npm package
`telegraph-protocol-mcp` v1.0.0 is the **old** IP-based flow and is
deliberately **not** used.

- Node: `https://devnode.telegraphprotocol.com`; chain: Ethereum Sepolia
  (11155111); escrow diamond `0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b`;
  test USDC `0xcc194e1a843B658526D0D5C431f670028582Ae17` (Telegraph's own
  test token, **not** Circle's — anyone can `mint(address, uint256)`).
- Ask: `POST /engine/v1/ask` with `{intent, params, max_budget_usdc:
  260000}` ($0.26 max per ask). First POST without payment returns HTTP
  402; the desk signs the escrow challenge (`personal_sign`) and retries
  with the `X-PAYMENT` header. A failed ask is never billed; an identical
  ask within 60 s returns the cached answer without a second charge.
- Spend caps (same defaults as the MCP server): $0.50 max per ask, $5/day.
  The desk also refuses to start unless the escrow covers the worst case
  (all checks at max budget).
- Every purchase is recorded in the memo and `out/ledger.jsonl` with
  miner, cost, latency, `signal_hash` and `receipt_hash`. Verify any signal
  at `GET /engine/v1/signal/<signal_hash>` (returns
  `{"algorithm":"keccak256","commitment":"payload","verified":true}`).

### A note on cost

The cost line in each memo ($0.55–0.56 per verdict in the verified runs)
is the desk's own accounting: the per-check `cost_usd` the node reports,
summed. It is **not** presented as a reading of the exact on-chain escrow
debit. One more detail, stated plainly: in the verified memos the two
checks routed to the openai miner ($0.26 each) carry a `signal_hash` but
`receipt_hash` is null — the node returned no receipt hash for those asks,
so the $0.26 is the node's reported cost, not a receipt-backed debit. The
other checks carry both hashes. One more accounting detail: the npm Payer
reports no billed amount, so the desk's daily spend log counts the
authorized price per ask — the conservative side — while the memo cost
line uses the node's reported `cost_usd`.

## The signed memo

`memo_id = keccak256(canonicalMemo)`; the desk signs the `memo_id` with its
Sepolia wallet key via EIP-191 `personal_sign`. Anyone can verify it:

```js
import { verifyMemo } from "./src/memo.js";
verifyMemo(signedMemo); // { valid: true, signer: "0x..." }
```

Tampering with any field after signing breaks the `memo_id` and the check
fails (covered by a unit test).

## Funding

The desk wallet is a **fresh Sepolia testnet-only wallet** generated for
this entry:

- **Address: `0x4A072CbDa9544869d9639Cb69fF86e8D6b86862d`**
- Private key: `.env` in the repo root (mode 0600, never committed, never shown
  in any report). Create one with `node scripts-gen-wallet.mjs`. Never use
  real wallets/keys for this.

Funding steps (`node src/fund.js [mintUsd=10] [depositUsd=5]`):

1. **Sepolia ETH for gas** — claim from a public faucet (e.g.
   sepoliafaucet.com, Google Cloud Web3 faucet) to the address above.
   **FUNDED 19 Nov 2026 ~16:34 WIB: 0.025 Sepolia ETH arrived via public
   faucet.**
2. Mint test USDC (`mint` on `0xcc19…Ae17`, open to anyone).
3. `approve` + `depositUSDC` into the escrow diamond.
4. Check balances any time: `node -e "import('./src/telegraph.js').then(async m=>{const c=new m.TelegraphClient(m.loadEnv());console.log(await c.balances())})"`.

**Funding receipt (19 Nov ~16:34 WIB):** mint 10 test USDC
(tx `0xe08b69473c33bf51708ab448e2bc087d1d612e9a69249c4a6fe2bd9fb628089c`),
approve
(`0x1f0ca04f42e2b932dfc58bd6358b004ea78509cde7a21e7196775df721295692`),
deposit 5 into escrow
(`0x2c321400f37563d929cf44402c2cb90ac25deb7b8e9c3bd0e5085710603fa9f2`).
Escrow held **$4.33** ($4.32 spendable) when checked 20 Nov, after the
verification runs. Worst case for a run is 6 checks × $0.26 max budget =
$1.56.

All testnet, $0 real value. No real money, no real trades.

## Live results

**First purchase (19 Nov ~16:36 WIB):** the audit check on USDC, bought
through the desk's exact input. Routed by the node to
`SECURITY_REVIEW_GENERAL` (miner ASTSec Published JavaScript Security Rules,
id 719217) — the plain-language question without source was analysed as a
JavaScript block (0 hotspots). Cost **$0.01** (authorized $0.26, escrow
rail), receipt
`0x8d10cb197cc3091b86b18d2904c2d2eb4847d20d936126fcc4d3fd4c4763f29d`,
signal
`0x300a56626ad6e3a7e0272d4c5607aeafbef3b9475f67bd6dc134ba65a73f5411`,
signal verification `verified: true`, latency 30.4 s. This purchase is
what exposed the audit-input flaw (below) — it is kept as evidence, not
hidden.

**Live run 1 — before the fixes (19 Nov):** USDC → **LIST** (mean 89,
$0.31); SQUID → **LIST** (mean 96, $0.05) — WRONG. The audit never saw
either contract (see above), the holder count (150,000) maxed out, and the
code review got an explorer link instead of source and still said "Approve".
The memo is in `out/`; the verdict was not reported as success.

**Fixes applied after run 1 (revision, re-tested):**
- Audit ask now sends the source as the `contract` parameter plus a
  `question` parameter (verified: the node then routes to a real auditor
  returning severity-labelled findings + verdict).
- `resolveCode` now sends the main-contract slice (last ERC20-ish
  contract, backfilled to 6,000 chars) and retries Sourcify once.
- Audit scorer rewritten: findings-based (severity labels, explicit
  verdict, non-negated honeypot/backdoor, entire-supply-to-one-address),
  with negation + heading guards so checklist echoes and hypothetical
  discussion do not count; inconclusive answers score neutral (50).
- Code-review scorer: an "Approve" that evaluated nothing (link, no
  source) scores neutral (50).
- Verdict rule: a critical audit (score <50) is a hard veto.
- Memo now records failed buys (`error` field — previously dropped, so a
  refused buy looked like a check with no receipt) and keeps up to 8,000
  chars of string evidence (was 2,000 — the run-2 SQUID audit text was cut
  off mid-finding in the stored memo).
- Offline unit tests: **21/21 PASS** (15 checks + 6 memo; re-run 20 Nov
  with `npm test`: 21 pass, 0 fail).

**Live run 2 — after the fixes (19 Nov ~17:09 WIB):** USDC → **LIST**,
SQUID → **DO NOT LIST** (audit veto, audit score 40) — both verdicts
correct, **but on partial data**: the payer refused 7 of 11 buys because
the **$5/day spend cap was hit** ("Today's asks have cost $4.86; this one
($0.26) would pass the $5 daily limit"). The `openai` miner bills the full
$0.26 max budget per ask when routed there, and the day's experiments +
runs burned the budget. The desk's spend guard worked as designed
(nothing was paid past the cap; the refused buys are recorded as errors in
the memos).

**Full clean live re-run (20 Nov, after the UTC-day reset) — two runs,
2 pass / 0 fail** (`npm run test:live`):

| Run | Token | Verdict | Mean | Cost (desk accounting) | Wall-clock |
|---|---|---|---|---|---|
| 20 Nov 01:37:11 UTC | USDC `0xA0b8…6eB48` | **LIST** | 80 | $0.56 | 53.6 s |
| 20 Nov 01:37:49 UTC | SQUID `0x8723…e9Bc5` | **DO NOT LIST** | 60 | $0.55 | 37.6 s |

SQUID's mean was 68 in the earlier 01:25 UTC run the same morning, 60 in
the 01:37 run — the verdict was DO NOT LIST both times, on the same veto:
"Contract audit: critical findings (score 0)". Per-check scores in the
01:37 memos: USDC — audit 100, holders 100 (9,612,659 holders), sanctions
100, code review 50 (neutral), social 50 (inconclusive). SQUID — audit 0,
holders 100 (101,562 holders), sanctions 100, code review 50 (neutral),
social 50 (inconclusive). Memo IDs: USDC
`0xba4190fea9419d9f42d74cebc5c9e77ca55c21c953c41c0f7b9654dd7b2c8e2f`,
SQUID
`0x0cad57e2d28abd1a3e0f4a96e8993af28252837b54b16242f16a2d3a26d265fc`.

Do **not** cite the intermediate SQUID memo at 01:26:52 UTC — it shows LIST
(mean 80). It was written before the scorer fix landed in the running
code, and it is exactly the failure the fix exists for.

## For reviewers — run it, check it, break it

**(a) Run it with a new realistic input.** Any ERC-20 contract address on
Ethereum or BSC works. For example, a token you pick yourself:

```bash
node src/desk.js <tokenAddress> --handle <the project's X handle> [--chain ethereum|bsc]
```

The `--handle` is required — the social-bot check needs a handle to screen.
If the token is unverified on Sourcify, the audit and code-review checks
fall back to the explorer link and score neutral (50) instead of clean;
the memo says so in its context notes.

**(b) Check the result.** Read the `.txt` memo next to the `.json` — it
prints the verdict, every score, and the cost line in plain text. To check
the signature yourself, run `node test/smoke.mjs` for the free checks and
`npm run test:live`, which asserts the memo self-verification on every run.
`out/ledger.jsonl` has one line per run for a quick scan.

**(c) Inspect the real Telegraph request and its evidence.** Each check in
the memo records intent, miner name and id, `signal_hash`, `receipt_hash`,
cost, and latency. Re-fetch any answer from storage:

```bash
curl https://devnode.telegraphprotocol.com/engine/v1/signal/<signal_hash>
```

The raw miner answer is stored as `evidence` in the memo (up to 8,000
chars for text answers). The request itself is reproducible: intent +
params are built in `src/checks.js` (`buildInput`), sent by
`src/telegraph.js` (`ask`), and the context the desk resolved (token meta,
deployer, source slice) is in the memo's `context_notes`.

**(d) Break it.** These are verified behaviours, not guesses:

- **Invalid address** — `node src/desk.js 0x123 --handle test` fails
  before any spend: `DESK FAILED: invalid address
  (argument="address", value="0x123", code=INVALID_ARGUMENT,
  version=6.17.0)`.
- **Missing handle** — `node src/desk.js 0xA0b8…6eB48` fails before any
  spend: `DESK FAILED: a social handle is required for the social-bot
  check: pass --handle <xHandle>`.
- **Unsupported chain** — `--chain solana` fails before any spend:
  `DESK FAILED: unsupported chain "solana"; supported: ethereum, bsc`.
- **Unfunded escrow** — the desk refuses to start and names the shortfall:
  `escrow spendable is $X, need $Y to cover N checks at max budget. Run:
  node src/fund.js ...` (balance guard in `src/desk.js`; `npm run
  test:live` skips instead of failing when this fires). Verified in code
  and in the live test's skip path.
- **Daily cap hit** — the payer refuses buys past $5/day and the desk
  records each refusal as an error in the memo instead of hiding it. The
  19 Nov 10:12 UTC ledger entries show runs where every buy was refused:
  verdict DO NOT LIST, mean 0, total $0, all checks failed. A memo with
  failed checks is a memo with holes in it — read the `error` fields
  before trusting the verdict.
- **Scam token** — SQUID → DO NOT LIST, audit veto, in both clean runs
  (means 60 and 68). But note what did *not* catch it: holder concentration
  scored 100 (101,562 holders) and sanctions scored 100. A big holder
  count is not evidence a token is legitimate.

**(e) Reproduce it.** `npm run test:live` re-runs both fixtures against
the live node and asserts the verdicts. It needs a funded escrow
(`node src/fund.js`); without one it skips with a clear message instead of
failing. Offline, `npm test` (21/21) reproduces the scoring and
sign/verify behaviour with no spending. Miner answers are free-form text,
so per-check scores can vary run to run — SQUID's mean moved 60↔68 between
two runs the same morning. The verdicts held; the exact means may not.

## Test fixtures

| Fixture | Token | Chain | Expect |
|---|---|---|---|
| `usdc-clean` | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, handle `circle` | ethereum | **LIST** |
| `squid-scam` | SQUID `0x87230146E138d3F296a9a77e497A2A83012e9Bc5`, handle `SquidGameBSC` | bsc | **DO NOT LIST** |

SQUID is the 2021 Squid Game rug/honeypot (BscScan-verified, 800M supply,
~101k holders, buyers could not sell). Its address was corrected during
testing: the commonly quoted `…A830E40684` string is 39 hex chars and
invalid; the real contract is `…A83012e9Bc5` (verified on-chain via
`bsc-dataseed`: name "Squid Game", symbol "SQUID", code present).

`npm run test:live` runs the desk on both fixtures and asserts the verdicts,
the memo self-verification, a receipt hash + cost on every paid check, and
that the cost line equals the sum of the per-check costs. Without a funded
escrow it skips both tests with a clear message (verified 19 Nov).

## Context resolvers (public, no keys)

- Token name/symbol/totalSupply + latest block: public RPC
  (`ethereum-rpc.publicnode.com`, `bsc-dataseed.binance.org`).
- Deployer: Blockscout `getcontractcreation` (Ethereum only — no no-key
  creation endpoint was found for BSC, so the sanctions check screens the
  token address itself there; the memo says so).
- Verified source: **Sourcify API v2**
  (`GET https://sourcify.dev/server/v2/contract/{chainId}/{address}?fields=all`;
  v1 was turned off 7 Jul 2026 — the old `/contracts/full_match/…/sources/`
  path now 308-redirects to an HTML page). Falls back to the explorer
  `#code` link, which `CODE_REVIEW` accepts as "a link to the change".
- `ONCHAIN_METRIC_VERIFY`'s chain enum is ethereum/polygon/arbitrum only,
  so BSC runs skip the deployer-activity check (5 buys instead of 6).

## Limitations — read before trusting a verdict

- **The audit score is a heuristic.** The intent declares no answer schema;
  the miner returns free-form judgment text and the desk scores it with
  text rules. Scores move between runs (SQUID 60↔68). The memo keeps the
  raw answer as evidence so you can judge for yourself — never treat the
  score as a deterministic measurement.
- **Proxy tokens are audited on the proxy, not the implementation.** The
  USDC memo's own audit evidence says it plainly: the proxy contract was
  reviewed, and "without the source code for the FiatToken implementation,
  it's impossible to definitively say" whether minting is possible. The
  audit still scored 100. If the token behind the proxy is the risk, this
  desk does not see it.
- **Two of five dimensions added no signal in the verified runs.** Code
  review and social bot detection both scored neutral 50 for USDC *and*
  for SQUID. A LIST verdict here effectively rests on three dimensions
  (audit, holders, sanctions).
- **Holder count measures breadth, not legitimacy.** SQUID's 101,562
  holders scored 100. A popular scam is still a scam; only the audit veto
  caught it.
- **The sanctions check screens a name string.** The desk passes the
  deployer address (the intent description accepts a wallet), falling back
  to the token address when the deployer is unknown — which is always the
  case on BSC, where no no-key creation endpoint was found.
- **Miner routing is the node's choice, not the desk's.** The same ask can
  land on different miners on different runs, at different prices ($0.01
  vs the $0.26 max). That is why the same token's mean moved between runs.
- **Cost is desk accounting, not an escrow-bank-statement figure.**
  See [A note on cost](#a-note-on-cost). The openai-routed checks have no
  receipt hash in the memos.
- **No latency benchmark is claimed.** Run wall-clock was 38–54 s in the
  verified runs; per-check latencies are in each memo. Nothing else was
  measured.
- **Testnet only.** Sepolia, test USDC, a throwaway wallet. Nothing in this
  repo touches mainnet or real money, and the verdicts have only been
  verified on two fixtures. A new token type — proxy-heavy, unverified
  source, thin holder data — can produce a memo that looks confident and
  isn't.
- **CLI only, no UI.** A reviewer runs commands; there is nothing to click
  through yet.

## Honesty notes

- The desk never registers, signs up, or pays for anything outside the
  Telegraph testnet flow, and never uploads project files anywhere.
- `out/` keeps the full run history, including the wrong early verdicts
  (run 1: SQUID → LIST) and the intermediate pre-fix memo. If a memo in
  `out/` disagrees with the verdicts in this README, check its timestamp:
  only the 20 Nov 01:37 UTC memos are the verified clean runs.

## Layout

```
.
  src/
    telegraph.js   # Telegraph client (Payer/Chain reuse + ethers funding)
    checks.js      # the 6 checks: inputs, scorers, verdict rule
    memo.js        # memo build / EIP-191 sign / verify / render
    desk.js        # CLI + context resolvers + parallel buys
    fund.js        # mint test USDC + deposit into escrow
  test/
    checks.test.js # 15 offline unit tests (npm test; live.test.js is NOT in npm test — it spends escrow, run it only via npm run test:live)
    memo.test.js   # 6 offline unit tests (sign/verify, tamper detection, veto)
    fixtures.json  # USDC (clean) + SQUID (scam)
    live.test.js   # end-to-end, needs funded escrow (npm run test:live)
    smoke.mjs      # free live checks (intents, balances, resolvers)
  out/             # memos + ledger.jsonl (created on run)
```

Wallet key: `.env` in the repo root (0600). Never commit it.

## Maintainer

Yuki (solo) — yukimanaa25@gmail.com, Discord mahadayagita. Built for
Telegraph Hackathon Season II. Demo video recorded 20 Nov (2 min 13 s,
real USDC run — see the submission for the link).
