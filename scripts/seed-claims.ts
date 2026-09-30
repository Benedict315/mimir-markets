/**
 * Seed Claims Script — creates 15 demo claims across all categories on Stellar
 * Testnet.
 *
 * These claims are designed to be immediately resolvable by the oracle agent, so
 * a fresh deployment has real settled history rather than an empty feed.
 *
 * Run AFTER deploying the contract:
 *   npx tsx --env-file-if-exists=.env.local scripts/seed-claims.ts
 *
 * Or dry-run (no transactions):
 *   DRY_RUN=1 npx tsx scripts/seed-claims.ts
 *
 * Signs with `CREATOR_SECRET` (falling back to `STELLAR_DEPLOYER_SECRET`) — the
 * market-creator agent's own Stellar keypair rather than a deployer key pasted on
 * the command line, so the seeded markets are attributed to the same account that
 * will keep creating them.
 *
 * The staking mechanics are simpler than the EVM version's: no `approve` leg (the
 * invocation carries auth for exactly the stake) and no nonce-collision hazard
 * (Stellar sequence numbers are per-account and read fresh before each build) —
 * the small delay below is kept only to be polite to the public RPC.
 */

import { Keypair } from "@stellar/stellar-sdk";

import { createClaim } from "../lib/contract";
import { readAgentBalances, walletFromKeypair } from "../lib/agent-wallets";
import { requireMarketContractId } from "../lib/stellar";
import { parseSeedAnchor, seedDeadline } from "./lib/seed-claims";

const DRY_RUN             = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
const STAKE_USDC          = 2;
const SHORT_DEADLINE_SECS = 3600;      // 1h — for claims that resolve immediately
const MED_DEADLINE_SECS   = 86400;     // 24h
const LONG_DEADLINE_SECS  = 604800;    // 7d

// ── Claim definitions ─────────────────────────────────────────────────────────
interface SeedClaim {
  question:        string;
  creatorPosition: string;
  counterPosition: string;
  resolutionUrl:   string;
  category:        string;
  settlementRule:  string;
  deadlineSecs:    number;
  label:           string;
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const SEED_CLAIMS: SeedClaim[] = [
  // ── CRYPTO (5 claims) ─────────────────────────────────────────────────────
  {
    label: "BTC price threshold",
    question: "Will Bitcoin (BTC) be above $95,000 USD at the end of today (UTC midnight)?",
    creatorPosition: "Yes — BTC stays above $95k today",
    counterPosition: "No — BTC drops below $95k today",
    resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
    category: "crypto",
    settlementRule: "Resolve YES if the CoinGecko price for Bitcoin is ≥ $95,000 at UTC midnight on the deadline date.",
    deadlineSecs: SHORT_DEADLINE_SECS,
  },
  {
    label: "ETH price threshold",
    question: "Will Ethereum (ETH) be above $3,000 USD in the next 24 hours?",
    creatorPosition: "Yes — ETH holds above $3k",
    counterPosition: "No — ETH falls below $3k",
    resolutionUrl: "https://www.coingecko.com/en/coins/ethereum",
    category: "crypto",
    settlementRule: "Resolve YES if ETH price on CoinGecko is ≥ $3,000 at the deadline.",
    deadlineSecs: MED_DEADLINE_SECS,
  },
  {
    label: "BTC market cap #1",
    question: "Will Bitcoin maintain the #1 market cap ranking for the next 7 days?",
    creatorPosition: "Yes — Bitcoin stays #1",
    counterPosition: "No — another asset overtakes Bitcoin",
    resolutionUrl: "https://coinmarketcap.com/",
    category: "crypto",
    settlementRule: "Resolve YES if Bitcoin is ranked #1 by market cap on CoinMarketCap at the deadline.",
    deadlineSecs: LONG_DEADLINE_SECS,
  },
  {
    label: "Crypto total market cap",
    question: "Will global crypto market cap exceed $3 trillion this week?",
    creatorPosition: "Yes — market cap breaks $3T",
    counterPosition: "No — stays below $3T",
    resolutionUrl: "https://www.coingecko.com/en/global-charts",
    category: "crypto",
    settlementRule: "Resolve YES if CoinGecko global market cap exceeds $3,000,000,000,000 at any point before deadline.",
    deadlineSecs: LONG_DEADLINE_SECS,
  },
  {
    label: "SOL price",
    question: "Will Solana (SOL) be above $170 USD at the end of this week?",
    creatorPosition: "Yes — SOL closes above $170",
    counterPosition: "No — SOL closes below $170",
    resolutionUrl: "https://www.coingecko.com/en/coins/solana",
    category: "crypto",
    settlementRule: "Resolve YES if SOL price on CoinGecko is ≥ $170 at the deadline.",
    deadlineSecs: LONG_DEADLINE_SECS,
  },

  // ── SPORTS (5 claims) ─────────────────────────────────────────────────────
  {
    label: "NBA playoff game",
    question: "Will the team with home court advantage win in the next NBA playoff game?",
    creatorPosition: "Yes — home court wins",
    counterPosition: "No — away team wins",
    resolutionUrl: "https://www.espn.com/nba/scoreboard",
    category: "sports",
    settlementRule: "Resolve YES if the home team wins the next scheduled NBA playoff game on ESPN scoreboard.",
    deadlineSecs: MED_DEADLINE_SECS,
  },
  {
    label: "Sports total score over/under",
    question: "Will the next NBA game have a combined score over 220 points?",
    creatorPosition: "Yes — over 220 combined",
    counterPosition: "No — under 220 combined",
    resolutionUrl: "https://www.espn.com/nba/scoreboard",
    category: "sports",
    settlementRule: "Resolve YES if total combined points in the next NBA game on ESPN exceeds 220.",
    deadlineSecs: MED_DEADLINE_SECS,
  },
  {
    label: "Soccer match result",
    question: "Will the next Premier League match end in a draw?",
    creatorPosition: "Yes — it's a draw",
    counterPosition: "No — one team wins",
    resolutionUrl: "https://www.bbc.com/sport/football/scores-fixtures",
    category: "sports",
    settlementRule: "Resolve YES if the next Premier League game listed on BBC Sport ends level (equal score) at full time.",
    deadlineSecs: MED_DEADLINE_SECS,
  },
  {
    label: "UFC winner bet",
    question: "Will the next UFC main event be decided by knockout or TKO?",
    creatorPosition: "Yes — KO/TKO finish",
    counterPosition: "No — decision or submission",
    resolutionUrl: "https://www.ufc.com/events",
    category: "sports",
    settlementRule: "Resolve YES if the next UFC main event ends via KO or TKO per the official UFC event page.",
    deadlineSecs: LONG_DEADLINE_SECS,
  },
  {
    label: "Tennis Grand Slam",
    question: "Will the top seed win the next tennis Grand Slam final?",
    creatorPosition: "Yes — top seed wins",
    counterPosition: "No — upset victory",
    resolutionUrl: "https://www.atptour.com/en/scores/current",
    category: "sports",
    settlementRule: "Resolve YES if the #1 ranked player wins the next ATP Grand Slam final per the ATP Tour results page.",
    deadlineSecs: LONG_DEADLINE_SECS,
  },

  // ── WEATHER (2 claims) ─────────────────────────────────────────────────────
  {
    label: "NYC weather",
    question: "Will New York City temperature exceed 25°C (77°F) tomorrow?",
    creatorPosition: "Yes — NYC exceeds 25°C tomorrow",
    counterPosition: "No — stays at or below 25°C",
    resolutionUrl: "https://forecast.weather.gov/MapClick.php?CityName=New+York&state=NY&site=OKX",
    category: "weather",
    settlementRule: "Resolve YES if the NWS forecast high temperature for NYC tomorrow is above 25°C / 77°F.",
    deadlineSecs: MED_DEADLINE_SECS,
  },
  {
    label: "London rain",
    question: "Will it rain in London tomorrow according to the official UK Met Office forecast?",
    creatorPosition: "Yes — rain in London tomorrow",
    counterPosition: "No — dry day in London",
    resolutionUrl: "https://www.metoffice.gov.uk/weather/forecast/gcpvj0v07",
    category: "weather",
    settlementRule: "Resolve YES if the Met Office forecast for London tomorrow shows any precipitation probability above 50%.",
    deadlineSecs: MED_DEADLINE_SECS,
  },

  // ── CULTURE (3 claims) ────────────────────────────────────────────────────
  {
    label: "Box office #1",
    question: "Will the current #1 box office movie retain its top spot next weekend?",
    creatorPosition: "Yes — same #1 next weekend",
    counterPosition: "No — a new movie takes #1",
    resolutionUrl: "https://www.boxofficemojo.com/weekend/",
    category: "culture",
    settlementRule: "Resolve YES if the same movie ranked #1 this weekend retains the #1 position next weekend on Box Office Mojo.",
    deadlineSecs: LONG_DEADLINE_SECS,
  },
  {
    label: "Spotify #1",
    question: "Will the current Spotify Global #1 song remain #1 for 7 more days?",
    creatorPosition: "Yes — same song stays #1",
    counterPosition: "No — dethroned within 7 days",
    resolutionUrl: "https://charts.spotify.com/charts/view/regional-global-weekly/latest",
    category: "culture",
    settlementRule: "Resolve YES if the same song holds the #1 position on Spotify Global Weekly chart at the deadline.",
    deadlineSecs: LONG_DEADLINE_SECS,
  },
  {
    label: "Tech announcement",
    question: "Will Apple release a new product announcement this week?",
    creatorPosition: "Yes — Apple announces something new",
    counterPosition: "No — no Apple announcement this week",
    resolutionUrl: "https://www.apple.com/newsroom/",
    category: "culture",
    settlementRule: "Resolve YES if Apple's Newsroom page shows a new product/service announcement published this week (not software updates).",
    deadlineSecs: LONG_DEADLINE_SECS,
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const at = optionValue("--at");
  if (at !== undefined && !DRY_RUN) {
    throw new Error("--at is preview-only; live seed deadlines always use the current time");
  }
  const anchor = parseSeedAnchor(at);

  if (DRY_RUN) {
    console.log("═".repeat(47));
    console.log("  Mimir Seed Claims — DRY RUN (USDC stakes)");
    console.log(`  Anchor: ${new Date(anchor * 1000).toISOString()}`);
    console.log(`  ${SEED_CLAIMS.length} claims would be created`);
    console.log(`  Each stake: ${STAKE_USDC} USDC`);
    console.log(`  Total USDC needed: ~${SEED_CLAIMS.length * STAKE_USDC} USDC`);
    console.log("═".repeat(47) + "\n");
    SEED_CLAIMS.forEach((c, i) => {
      console.log(`${i + 1}. [${c.category.toUpperCase()}] ${c.label}`);
      console.log(`   Q: ${c.question.slice(0, 80)}...`);
      console.log(`   URL: ${c.resolutionUrl}`);
      console.log(
        `   Deadline: ${new Date(seedDeadline(anchor, c.deadlineSecs) * 1000).toISOString()}\n`,
      );
    });
    return;
  }

  const secret = process.env.CREATOR_SECRET?.trim();
  if (!secret) {
    console.error("CREATOR_SECRET is required. Use --dry-run to preview without secrets or network access.");
    process.exit(1);
  }
  const wallet = walletFromKeypair(Keypair.fromSecret(secret));
  const contractId = requireMarketContractId();
  const balances = await readAgentBalances(wallet.address);

  console.log("═".repeat(47));
  console.log("  Mimir Seed Claims (Stellar Testnet, USDC)");
  console.log(`  Contract : ${contractId}`);
  console.log(`  Creator  : ${wallet.address}`);
  console.log(`  Fee XLM  : ${(balances.xlm ?? 0).toFixed(4)}`);
  console.log(`  USDC     : ${balances.usdc === null ? "no trustline" : balances.usdc.toFixed(4)}`);
  console.log(`  Claims   : ${SEED_CLAIMS.length}`);
  console.log(`  Stake/ea : ${STAKE_USDC} USDC`);
  console.log("═".repeat(47) + "\n");

  if (!balances.exists) {
    console.error("Creator account does not exist on the ledger — run: npm run agents:fund");
    process.exit(1);
  }
  if (balances.usdc === null) {
    console.error("Creator holds no USDC trustline — run: npm run agents:fund");
    process.exit(1);
  }
  const needed = STAKE_USDC * SEED_CLAIMS.length;
  if (balances.usdc < needed) {
    console.error(`Insufficient USDC! Need ~${needed}, have ${balances.usdc.toFixed(4)}`);
    process.exit(1);
  }

  let created = 0;
  let failed  = 0;

  for (const [i, seed] of SEED_CLAIMS.entries()) {
    console.log(`[${i + 1}/${SEED_CLAIMS.length}] Creating: ${seed.label}`);
    console.log(`  Q: ${seed.question.slice(0, 70)}...`);

    try {
      // `create_claim` returns the new id, so there is no "read claimCount
      // afterwards and hope" step to learn the market's own identifier.
      const result = await createClaim(wallet.signer, {
        question:         seed.question,
        creator_position: seed.creatorPosition,
        counter_position: seed.counterPosition,
        resolution_url:   seed.resolutionUrl,
        deadline:         seedDeadline(anchor, seed.deadlineSecs),
        stake_amount:     STAKE_USDC,
        category:         seed.category,
        market_type:      "binary",
        odds_mode:        "pool",
        settlement_rule:  seed.settlementRule,
        max_challengers:  100,
        visibility:       "public",
      });

      console.log(`  ✓ #${result.claimId} — ${result.explorerUrl ?? result.txHash}`);
      created++;
    } catch (err: unknown) {
      console.error(`  ✗ Failed: ${err instanceof Error ? err.message : err}`);
      failed++;
    }

    // Small delay so a burst of 15 invocations does not trip the public RPC's
    // per-client rate limit.
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("\n" + "═".repeat(47));
  console.log(`  Done: ${created} created, ${failed} failed`);
  console.log(`  Now run the oracle to auto-settle expired claims:`);
  console.log(`  npm run oracle`);
  console.log("═".repeat(47));
}

main().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
