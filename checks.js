// The five Telegraph checks the listings desk buys in parallel, one per
// risk dimension, plus one supporting on-chain read.
// Intent names are the LIVE catalogue names (verified 2026-11-19 against
// GET https://devnode.telegraphprotocol.com/engine/v1/intents, 136 intents).
// The mission page shows the same intents without the _GENERAL suffix;
// the live API only accepts the suffixed names.
//
// Mapping note (documented honestly): the mission example lists
// ONCHAIN_METRIC_VERIFY for holder concentration, but that intent reads ONE
// address's native balance / nonce — it cannot measure holder concentration.
// The live catalogue has TOKEN_HOLDER_COUNT_GENERAL for exactly that, so the
// desk buys it for the holder-concentration dimension and buys
// ONCHAIN_METRIC_VERIFY separately as supporting deployer-activity evidence.

export const AUDIT_QUESTION =
  "Audit this smart contract source for a token listing review. Check: (1) can the owner mint unlimited tokens or drain funds, " +
  "(2) can holders sell freely or is selling restricted, (3) is the entire supply held by one address, " +
  "(4) reentrancy, access control flaws, hidden mint, blacklist or honeypot behaviour. " +
  "Report each finding with its severity and give an overall verdict: SAFE, RISKY or UNSAFE.";

export const CHECKS = [
  {
    id: "contract_audit",
    dimension: "Contract audit",
    intent: "SMART_CONTRACT_AUDIT_GENERAL",
    miners: 19,
    // This intent has no declared request schema (lifecycle: registered, no
    // input/output format). Verified live 19 Nov 2026: sending the contract
    // source as the `contract` parameter (plus a `question` parameter) gets
    // a real source audit with severity-labelled findings and a verdict;
    // a plain-language question WITHOUT source is routed to a JavaScript
    // lint miner that analyses the question text itself (0 hotspots) — the
    // audit then scores 100 for any token, clean or scam. Without source
    // (Sourcify unreachable) the desk falls back to the plain question.
    buildInput: (ctx) =>
      ctx.code
        ? { intent: "SMART_CONTRACT_AUDIT_GENERAL", params: { contract: ctx.code, question: AUDIT_QUESTION } }
        : {
            query:
              `Audit the smart contract at ${ctx.address} on ${ctx.chainLabel} for a token listing review. ` +
              `Check for reentrancy, access control flaws, integer overflow/underflow, hidden mint or blacklist ` +
              `functions, honeypot or backdoor behaviour, and owner privileges that could drain funds or block sells. ` +
              `Report each finding with severity, and give an overall verdict: SAFE, RISKY or UNSAFE.`,
          },
    score: (answer) => scoreAuditText(answer),
  },
  {
    id: "holder_concentration",
    dimension: "Holder concentration",
    intent: "TOKEN_HOLDER_COUNT_GENERAL",
    miners: 20,
    buildInput: (ctx) => ({ intent: "TOKEN_HOLDER_COUNT_GENERAL", params: { token: ctx.address, chain: ctx.holderChain } }),
    score: (answer) => scoreHolders(answer),
  },
  {
    id: "sanctions",
    dimension: "Sanctions exposure",
    intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
    miners: 28,
    buildInput: (ctx) => ({
      intent: "SANCTIONS_SCREENING_MATCH_GENERAL",
      params: { name: ctx.deployer || ctx.address },
    }),
    score: (answer) => scoreSanctions(answer),
  },
  {
    id: "code_review",
    dimension: "Contributor authenticity",
    intent: "CODE_REVIEW_GENERAL",
    miners: 17,
    buildInput: (ctx) => ({
      intent: "CODE_REVIEW_GENERAL",
      params: { code: ctx.code || ctx.codeUrl },
    }),
    score: (answer) => scoreCodeReview(answer),
  },
  {
    id: "social_bot",
    dimension: "Social authenticity",
    intent: "SOCIAL_BOT_DETECTION_GENERAL",
    miners: 16,
    buildInput: (ctx) => ({
      intent: "SOCIAL_BOT_DETECTION_GENERAL",
      params: { account: ctx.handle },
    }),
    score: (answer) => scoreSocialBot(answer),
  },
  {
    id: "deployer_activity",
    dimension: "Deployer activity (supporting evidence, unscored)",
    intent: "ONCHAIN_METRIC_VERIFY_GENERAL",
    miners: 44,
    buildInput: (ctx) => ({
      intent: "ONCHAIN_METRIC_VERIFY_GENERAL",
      params: { address: ctx.deployer || ctx.address, block: ctx.block, chain: ctx.metricChain, metric: "tx_count" },
    }),
    score: () => ({ score: null, notes: ["supporting evidence only; not scored"] }),
    // ONCHAIN_METRIC_VERIFY's chain enum is ethereum/polygon/arbitrum only;
    // chains outside it (e.g. BSC) skip this check.
    chains: ["ethereum", "polygon", "arbitrum"],
  },
];

// --- scorers (pure functions; unit-tested) ---------------------------------
export function textOf(answer) {
  if (answer == null) return "";
  if (typeof answer === "string") return answer;
  return JSON.stringify(answer);
}

function firstField(answer, names) {
  if (!answer || typeof answer !== "object") return undefined;
  for (const n of names) if (answer[n] !== undefined) return answer[n];
  return undefined;
}

// Audit answers are free-form judgment text (the intent declares no schema).
// Scored on FINDINGS, not on keyword mentions: auditors discuss risks
// hypothetically ("if the admin key is compromised, an attacker could drain
// funds"), so a bare keyword count scores a clean proxy as critical. Only
// severity-labelled findings, explicit verdicts, and declarative statements
// about this contract count. An answer that could not audit the code scores
// neutral, never clean.
export function scoreAuditText(answer) {
  if (answer != null && typeof answer === "object") {
    // ASTSec-style structured answer: "Needs changes" with 0 findings means
    // the miner analysed the question text, not a contract — inconclusive.
    const v = String(answer.verdict ?? "").toLowerCase();
    if (v === "needs changes" && (answer.vulnerability_count === 0 || answer.vulnerability_count == null)) {
      return { score: 50, notes: ["miner verdict 'Needs changes' with 0 findings; audit inconclusive, scored neutral"] };
    }
  }
  const t = textOf(answer);
  const notes = [];
  if (!t.trim()) return { score: 50, notes: ["audit miner returned no text; scored neutral"] };
  // The miner never saw code (routed to a lint miner / asked for the source).
  if (/impossible to (fully )?audit|snippet is incomplete|please provide the complete contract code|need the .* source code to perform an audit/i.test(t)) {
    return { score: 50, notes: ["miner could not audit the contract (incomplete or missing code); scored neutral"] };
  }
  // Explicit overall verdict sets the base (the miner's own judgment).
  let score = 100;
  const verdict = t.match(/overall verdict:\W{0,10}(safe|risky|unsafe)|verdict:\W{0,10}(safe|risky|unsafe)/i);
  const v = (verdict?.[1] || verdict?.[2] || "").toLowerCase();
  if (v === "safe") notes.push("miner verdict: SAFE");
  else if (v === "risky") { score = 50; notes.push("miner verdict: RISKY"); }
  else if (v === "unsafe") { score = 20; notes.push("miner verdict: UNSAFE"); }
  if (/caveat/i.test(t)) notes.push("miner verdict carries a caveat (see evidence)");
  // Severity-labelled findings ("Severity: Critical/High/Medium/Low"), each
  // counted once per level, ignoring negated mentions ("Severity: None" is
  // not a level; "no critical issues" has no "Severity:" label at all).
  const sev = { critical: 30, high: 15, medium: 10, low: 5 };
  for (const [level, cost] of Object.entries(sev)) {
    const re = new RegExp(`severity:\\s*\\*?\\*?${level}`, "gi");
    const hits = [...t.matchAll(re)].filter((m) => !isNegated(t, m.index));
    if (hits.length) {
      const n = Math.min(hits.length, 2);
      score -= cost * n;
      notes.push(`${n}x ${level}-severity finding${n > 1 ? "s" : ""}`);
    }
  }
  // Honeypot / backdoor stated as a finding about this contract — not a
  // section heading ("8. Honeypot Behaviour:") and not a negated mention
  // ("does not exhibit typical honeypot characteristics").
  for (const kw of ["honeypot", "backdoor"]) {
    const re = new RegExp(kw, "gi");
    const hits = [...t.matchAll(re)].filter((m) => isFindingKeyword(t, m.index, kw.length));
    if (hits.length) {
      score -= 60;
      notes.push(`critical language found: ${kw}`);
      break;
    }
  }
  // The entire supply minted to / held by a single address is a critical
  // listing risk (the SQUID pattern: 800M minted to the deployer). Only a
  // declarative statement counts — a question ("Is the entire supply held
  // by one address?") does not.
  // Live miners phrase this three ways; all three must match (regression,
  // 20 Nov 2026: two live SQUID audits both stated the mint-to-deployer
  // fact but neither used the "held by" wording, so the rule never fired
  // and one run scored the honeypot 100 -> LIST):
  //   "the entire initial supply will be held by the owner"
  //   "the INITIAL_TOTAL_SUPPLY is minted to msg.sender"
  //   "that owner will initially hold the entire supply"
  if (
    /(entire|whole|total|full)\s+(initial\s+)?supply\s+(will be|is)\s+held by\s+(the\s+)?(owner|deployer|one address)/i.test(t) ||
    /supply[`*_]?\s+(is|was)\s+minted\s+to\s+[`*_]?(msg\.sender|the\s+owner|the\s+deployer|a single address|one address)/i.test(t) ||
    /\b(owner|deployer|entity|msg\.sender)\b[^.]{0,40}\bholds?\s+the\s+(entire|whole|total|full)\s+(initial\s+)?supply/i.test(t)
  ) {
    score -= 60;
    notes.push("entire supply minted to / held by a single address (critical concentration)");
  }
  return { score: Math.max(0, Math.min(100, score)), notes };
}

// A keyword is negated when "no / not / never / cannot / does not / without"
// appears in the SAME SENTENCE before it ("The proxy contract cannot
// exhibit ... or honeypot behaviour", "does not exhibit typical honeypot
// characteristics"). A fixed char window is too short: "cannot" can sit
// 60+ chars before the keyword in the same sentence.
function isNegated(t, index) {
  const before = t.slice(Math.max(0, index - 200), index);
  const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf(".\n"), before.lastIndexOf("\n"));
  const sentence = cut === -1 ? before : before.slice(cut + 1);
  return /\b(no|not|never|cannot|can't|does not|do not|without)\b/i.test(sentence);
}

// A honeypot/backdoor mention counts as a finding only if it is not a
// section heading (the miner echoes the question's checklist as headings,
// e.g. "**4. Reentrancy, ... or honeypot behaviour.**"), not negated
// before it, and not negated shortly after it ("does not exhibit typical
// honeypot characteristics") — and not a generic definition of the term
// ("A honeypot is typically created by having a contract that allows
// users to deposit funds but prevents them from withdrawing"), which
// describes the concept, not this contract (live SQUID audit, 20 Nov 2026:
// that sentence alone cost a clean token -60).
function isFindingKeyword(t, index, kwLen) {
  if (isNegated(t, index)) return false;
  const after = t.slice(index + kwLen, index + kwLen + 120);
  if (/\b(no|not|never|cannot|can't|does not|do not|without)\b/i.test(after)) return false;
  if (/^\s*(a|an)\s+(honeypot|backdoor)s?\s+is\b/i.test(sentenceAt(t, index))) return false;
  // Heading line: optional bold/number lead-in, no sentence inside, ends
  // with a bold close (optionally + ":", optionally preceded by ".").
  const lineStart = t.lastIndexOf("\n", index) + 1;
  const lineEnd = t.indexOf("\n", index + kwLen);
  const line = t.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  if (/^\s*(\*+\s*)?\d*\.?\s*[^.]*\.?\*{2}:?\s*$/.test(line)) return false;
  return true;
}

// The sentence containing the character at `index`: from the last
// sentence/line boundary before it to the next sentence end after it.
function sentenceAt(t, index) {
  const start = Math.max(t.lastIndexOf(". ", index), t.lastIndexOf(".\n", index), t.lastIndexOf("\n", index)) + 1;
  let end = t.length;
  for (const sep of [". ", ".\n", "!\n", "?\n"]) {
    const i = t.indexOf(sep, index);
    if (i !== -1) end = Math.min(end, i + 1);
  }
  return t.slice(start, end);
}

export function scoreHolders(answer) {
  const n = Number(firstField(answer, ["holders_count", "holders", "count"]));
  if (!Number.isFinite(n) || n < 0) return { score: 50, notes: ["holders_count missing from answer; scored neutral"] };
  // log scale: 1 holder -> 0, 10 -> 25, 100 -> 50, 1,000 -> 75, 10,000+ -> 100
  const score = Math.round(Math.max(0, Math.min(100, (100 * Math.log10(Math.max(n, 1))) / 4)));
  const notes = [`holders_count = ${n}`];
  if (n < 100) notes.push("highly concentrated: fewer than 100 holders");
  else if (n < 1000) notes.push("moderately concentrated: fewer than 1,000 holders");
  return { score, notes };
}

export function scoreSanctions(answer) {
  const matched = firstField(answer, ["matched", "match"]);
  const matches = firstField(answer, ["matches"]);
  if (matched === true || matched === "true" || matched === "yes" || matched === 1) {
    return { score: 0, veto: true, notes: [`sanctions MATCH: ${JSON.stringify(matches ?? []).slice(0, 300)}`] };
  }
  if (matched === false || matched === "false" || matched === "no" || matched === 0) {
    return { score: 100, notes: ["no sanctions match"] };
  }
  return { score: 50, notes: ["sanctions answer has no clear matched field; scored neutral"] };
}

export function scoreCodeReview(answer) {
  const verdict = String(firstField(answer, ["verdict"]) ?? "").toLowerCase();
  const findings = firstField(answer, ["findings"]);
  const summary = String(firstField(answer, ["summary"]) ?? "");
  const n = Array.isArray(findings) ? findings.length : 0;
  const notes = [`verdict = ${verdict || "unknown"}`, `findings = ${n}`];
  // "Approve" with no findings AND a summary saying nothing was evaluated
  // (the miner got an explorer link, not source) is inconclusive, not clean.
  if (verdict === "approve" && findings == null && /without the source code|can.?not be evaluated|no concrete .* can be evaluated|rather than an explicit code change/i.test(summary)) {
    return { score: 50, notes: [...notes, "miner could not evaluate (no source supplied); scored neutral"] };
  }
  let score;
  if (verdict === "approve") score = 100;
  else if (verdict === "comment") score = 70;
  else if (verdict.includes("request change")) score = 30;
  else return { score: 50, notes: [...notes, "no recognised verdict; scored neutral"] };
  return { score: Math.max(0, score - 5 * Math.min(n, 4)), notes };
}

export function scoreSocialBot(answer) {
  const verdict = String(firstField(answer, ["verdict"]) ?? "").toLowerCase();
  const botScore = Number(firstField(answer, ["bot_score", "botScore"]));
  const map = { human: 100, likely_human: 80, inconclusive: 50, likely_bot: 20, bot: 0 };
  if (verdict in map) {
    const notes = [`verdict = ${verdict}`];
    if (Number.isFinite(botScore)) notes.push(`bot_score = ${botScore}`);
    return { score: map[verdict], notes };
  }
  if (Number.isFinite(botScore)) {
    return { score: Math.round(100 * (1 - Math.max(0, Math.min(1, botScore)))), notes: [`bot_score = ${botScore}`] };
  }
  return { score: 50, notes: ["no verdict or bot_score; scored neutral"] };
}

// --- verdict ---------------------------------------------------------------
export function verdictFor(scored) {
  // scored: [{id, dimension, score}] — only scored dimensions (score != null).
  const xs = scored.filter((s) => typeof s.score === "number");
  const total = xs.reduce((a, s) => a + s.score, 0);
  const mean = xs.length ? total / xs.length : 0;
  const vetoes = scored.filter((s) => s.veto).map((s) => `${s.dimension}: ${s.notes.join("; ")}`);
  // A critical contract audit blocks the listing outright: a token whose
  // audit finds critical issues must not list no matter how many holders
  // it has or how clean its sanctions screen is — the mean alone cannot
  // express this (holders + sanctions + social can outvote a 0 audit).
  const audit = scored.find((s) => s.id === "contract_audit" && typeof s.score === "number" && s.score < 50);
  if (audit) vetoes.push(`Contract audit: critical findings (score ${audit.score})`);
  let verdict;
  if (vetoes.length) verdict = "DO NOT LIST";
  else if (mean >= 80) verdict = "LIST";
  else if (mean >= 50) verdict = "LIST WITH CONDITIONS";
  else verdict = "DO NOT LIST";
  return { mean: Math.round(mean * 10) / 10, verdict, vetoes };
}
