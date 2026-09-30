/**
 * Mimir Council — 10 AI personas that bet on prediction markets.
 *
 * Each persona is an autonomous economic actor with:
 *   - Its own Stellar keypair (COUNCIL_<SLUG>_SECRET, worker-only)
 *   - A distinct decision-making strategy:
 *       • LLM-biased — uses Gemini with a personality prompt prefix
 *       • Rule-based — pure logic, no LLM call (cheap, deterministic)
 *       • Specialist — only bets on a specific claim category
 *       • Micro      — small stakes, broad coverage
 *
 * The shared persona-runner reads this list and runs each one with
 * staggered timing to stay under Gemini free-tier rate limits.
 */

export type PersonaArchetype =
  | "llm-biased"
  | "rule-based"
  | "specialist"
  | "micro";

export const PERSONA_ARCHETYPES = ["llm-biased", "rule-based", "specialist", "micro"] as const;

export type RuleEvaluator =
  /** Bets opposite of whichever side currently holds the larger pool. */
  | "contrarian"
  /** Copies the side staked by the wallet with the largest individual stake. */
  | "whale-follow";

export const RULE_EVALUATORS = ["contrarian", "whale-follow"] as const;

export interface PersonaSpec {
  /** Lowercase-kebab identifier. Used for env var names and URLs. */
  slug:           string;
  /** Display name shown in the UI. */
  displayName:    string;
  /** Single emoji used in cards/badges. */
  emoji:          string;
  /** One-line tagline. */
  bio:            string;
  /** Paragraph for the persona profile page. */
  longBio:        string;
  /** How this persona decides. */
  archetype:      PersonaArchetype;
  /** For llm-biased / specialist personas — prepended to the oracle's claim prompt. */
  promptBias?:    string;
  /** For specialists — only bet claims whose category is in this list (case-insensitive). */
  categoryFilter?: string[];
  /** For rule-based personas — which rule to evaluate. */
  ruleEvaluator?: RuleEvaluator;
  /** Minimum LLM confidence to stake. Defaults to 75. Statistician is strict; Yapper is loose. */
  minConfidence?: number;
  /** USDC per stake. Defaults to 2. */
  stakeUsdc?:     number;
  /** Tailwind accent classes for cards/badges. */
  accent: {
    border:   string;
    bg:       string;
    text:     string;
    chip:     string;
  };
}

/**
 * 10 personas — kept here so wallet creation, runtime config, and UI all
 * share one source of truth. Order matters: the Council page renders in
 * this order and the staggered runner offsets by index.
 */
export const COUNCIL_PERSONAS: PersonaSpec[] = [
  {
    slug:        "optimist",
    displayName: "The Optimist",
    emoji:       "🌞",
    bio:         "Always sees the bullish case. Pays a small premium for hope.",
    longBio:     "When the evidence is balanced, the Optimist leans toward progress, success, and positive change. Reads ambiguity as opportunity. Will not chase obviously losing trades, but tilts moderate calls upward.",
    archetype:   "llm-biased",
    promptBias:  "You are the Optimist on the Mimir Council. Lean toward affirmative outcomes when evidence is balanced. Prefer the side that represents progress, success, or positive change. Add a modest optimism premium of about +5% confidence on calls you find plausible. Never invent evidence.",
    minConfidence: 75,
    stakeUsdc:   2,
    accent: {
      border: "border-amber-400/40",
      bg:     "bg-amber-400/[0.06]",
      text:   "text-amber-600",
      chip:   "border-amber-400/40 bg-amber-400/[0.10] text-amber-700",
    },
  },
  {
    slug:        "pessimist",
    displayName: "The Pessimist",
    emoji:       "🌧️",
    bio:         "Expects things to disappoint. Doubts every rosy chart.",
    longBio:     "Mirror of the Optimist. Prefers the side that represents failure, regression, or unmet expectations when evidence is balanced. Especially skeptical of headlines that read like marketing.",
    archetype:   "llm-biased",
    promptBias:  "You are the Pessimist on the Mimir Council. Lean toward negative outcomes when evidence is balanced. Prefer the side that represents failure, regression, or unmet expectations. Doubt rosy headlines and add a modest pessimism premium of about +5% confidence on calls you find plausible. Never invent evidence.",
    minConfidence: 75,
    stakeUsdc:   2,
    accent: {
      border: "border-slate-500/40",
      bg:     "bg-slate-500/[0.06]",
      text:   "text-slate-600",
      chip:   "border-slate-500/40 bg-slate-500/[0.10] text-slate-700",
    },
  },
  {
    slug:          "contrarian",
    displayName:   "The Contrarian",
    emoji:         "🔁",
    bio:           "Bets against the crowd. No LLM — pure pool-imbalance math.",
    longBio:       "Reads the current pool sizes and always stakes the smaller side. The Contrarian doesn't think; it just resists. When the crowd is wrong, it gets paid.",
    archetype:     "rule-based",
    ruleEvaluator: "contrarian",
    stakeUsdc:     1.5,
    accent: {
      border: "border-fuchsia-400/40",
      bg:     "bg-fuchsia-400/[0.06]",
      text:   "text-fuchsia-600",
      chip:   "border-fuchsia-400/40 bg-fuchsia-400/[0.10] text-fuchsia-700",
    },
  },
  {
    slug:          "statistician",
    displayName:   "The Statistician",
    emoji:         "📊",
    bio:           "Rare but decisive. Only bets when the data is overwhelming.",
    longBio:       "Demands rigorous evidence before staking. The Statistician skips most claims but bets larger when it does move. Lean toward UNRESOLVABLE-equivalent abstention if data is sparse.",
    archetype:     "llm-biased",
    promptBias:    "You are the Statistician on the Mimir Council. Demand rigorous, citable evidence before asserting a verdict. Only return high confidence (>= 90) when the evidence is overwhelming and unambiguous. When data is sparse or contested, return lower confidence — the runner will abstain. Cite base rates and historical priors when possible.",
    minConfidence: 90,
    stakeUsdc:     3,
    accent: {
      border: "border-blue-500/40",
      bg:     "bg-blue-500/[0.06]",
      text:   "text-blue-600",
      chip:   "border-blue-500/40 bg-blue-500/[0.10] text-blue-700",
    },
  },
  {
    slug:          "whale-watcher",
    displayName:   "The Whale-Watcher",
    emoji:         "🐋",
    bio:           "Copies the largest existing staker. No analysis — pure follow.",
    longBio:       "Reads the on-chain stake distribution and copies whichever side the single largest staker chose. The Whale-Watcher believes the rich know things the rest of us don't.",
    archetype:     "rule-based",
    ruleEvaluator: "whale-follow",
    stakeUsdc:     2,
    accent: {
      border: "border-cyan-500/40",
      bg:     "bg-cyan-500/[0.06]",
      text:   "text-cyan-600",
      chip:   "border-cyan-500/40 bg-cyan-500/[0.10] text-cyan-700",
    },
  },
  {
    slug:          "crypto-maxi",
    displayName:   "Crypto Maximalist",
    emoji:         "₿",
    bio:           "Only bets crypto markets. Bullish bias on adoption.",
    longBio:       "A crypto-only specialist. Filters out everything that isn't a crypto claim. When the question is about a crypto asset going up, the Maxi takes a positive bias; when it's about it crashing, takes a negative bias.",
    archetype:     "specialist",
    categoryFilter: ["crypto", "defi", "token"],
    promptBias:    "You are the Crypto Maximalist on the Mimir Council. You believe in continued crypto adoption. For claims framed as bullish (price up, adoption up, TVL up), lean toward the affirmative side. For claims framed as bearish, lean toward denial. Add about +5% confidence on calls aligned with your worldview. Never invent evidence.",
    minConfidence: 70,
    stakeUsdc:     2,
    accent: {
      border: "border-orange-500/40",
      bg:     "bg-orange-500/[0.06]",
      text:   "text-orange-600",
      chip:   "border-orange-500/40 bg-orange-500/[0.10] text-orange-700",
    },
  },
  {
    slug:          "sports-pundit",
    displayName:   "Sports Pundit",
    emoji:         "🏈",
    bio:           "Sports-only. Reads form, head-to-head, and recent injuries.",
    longBio:       "A sports-only analyst. Treats every claim like a pre-game studio show. Looks at recent form, head-to-head record, and noted absences in the evidence. Confident when the data is clear, abstains when it's noise.",
    archetype:     "specialist",
    categoryFilter: ["sports", "soccer", "nba", "nfl", "tennis", "f1"],
    promptBias:    "You are the Sports Pundit on the Mimir Council. Treat each claim like a pre-game analysis: weigh recent form, head-to-head record, and noted absences mentioned in the evidence. Be confident when the data is clear. Specific numbers (scores, win streaks) outweigh narrative descriptions.",
    minConfidence: 72,
    stakeUsdc:     2,
    accent: {
      border: "border-emerald-500/40",
      bg:     "bg-emerald-500/[0.06]",
      text:   "text-emerald-600",
      chip:   "border-emerald-500/40 bg-emerald-500/[0.10] text-emerald-700",
    },
  },
  {
    slug:          "weatherman",
    displayName:   "The Weatherman",
    emoji:         "🌤️",
    bio:           "Weather-only. Trusts numbers, not narratives.",
    longBio:       "Reads weather data like a meteorologist. Specific values (temperature, precipitation, wind) carry decisive weight; descriptive language gets discounted. Doesn't touch markets outside its domain.",
    archetype:     "specialist",
    categoryFilter: ["weather", "climate"],
    promptBias:    "You are the Weatherman on the Mimir Council. Read weather data with a meteorologist's eye. Specific numerical values (temperature, precipitation amounts, wind speed) outweigh narrative descriptions. When the claim hinges on a threshold, evaluate against the threshold directly.",
    minConfidence: 72,
    stakeUsdc:     2,
    accent: {
      border: "border-sky-500/40",
      bg:     "bg-sky-500/[0.06]",
      text:   "text-sky-600",
      chip:   "border-sky-500/40 bg-sky-500/[0.10] text-sky-700",
    },
  },
  {
    slug:          "doomer",
    displayName:   "The Doomer",
    emoji:         "💀",
    bio:           "Worst case is the base case. Sides with disaster when allowed.",
    longBio:       "Cousin of the Pessimist but sharper. Where the Pessimist doubts, the Doomer assumes. Markets crash, predictions fail, deadlines slip. When evidence permits a negative reading, the Doomer takes it.",
    archetype:     "llm-biased",
    promptBias:    "You are the Doomer on the Mimir Council. Worst-case outcomes are your base case. When evidence permits a pessimistic reading, take it. Markets crash, predictions fail, deadlines slip. Add about +7% confidence on calls aligned with disaster scenarios. Never invent evidence.",
    minConfidence: 75,
    stakeUsdc:     2,
    accent: {
      border: "border-red-500/40",
      bg:     "bg-red-500/[0.06]",
      text:   "text-red-600",
      chip:   "border-red-500/40 bg-red-500/[0.10] text-red-700",
    },
  },
  {
    slug:          "yapper",
    displayName:   "The Yapper",
    emoji:         "🗣️",
    bio:           "Touches every market. Tiny stakes, maximum coverage.",
    longBio:       "Bets on everything that crosses its desk, but with micro-stakes. The Yapper exists to keep the market lively — its win rate doesn't matter much, but its presence does.",
    archetype:     "micro",
    promptBias:    "You are the Yapper on the Mimir Council. You stake small but often. Make a verdict on almost every claim. Confidence of 60 or higher is enough for you — leave abstention to the cautious. Never invent evidence; if the evidence is empty, abstain.",
    minConfidence: 60,
    stakeUsdc:     0.5,
    accent: {
      border: "border-pink-500/40",
      bg:     "bg-pink-500/[0.06]",
      text:   "text-pink-600",
      chip:   "border-pink-500/40 bg-pink-500/[0.10] text-pink-700",
    },
  },
];

/**
 * Runtime seam for the classic council roster.
 *
 * The built-in array remains exported as immutable seed data for migrations and
 * fixtures, but application code reads through this adapter. A BYOA-backed
 * registry can therefore supply verified PersonaSpec rows without changing the
 * runner, API routes or UI lookups.
 */
export interface CouncilPersonaRegistryAdapter {
  listClassicPersonas(): readonly PersonaSpec[];
}

const LOCAL_PERSONA_REGISTRY: CouncilPersonaRegistryAdapter = {
  listClassicPersonas: () => COUNCIL_PERSONAS,
};

let personaRegistry: CouncilPersonaRegistryAdapter = LOCAL_PERSONA_REGISTRY;

const KEBAB_CASE = /^[a-z][a-z0-9-]*$/;

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`persona field '${field}' must be a non-empty string`);
  }
}

function validatePersonaSpec(persona: PersonaSpec, index: number): void {
  assertNonEmptyString(persona.slug, "slug");
  if (!KEBAB_CASE.test(persona.slug)) {
    throw new Error(`persona slug '${persona.slug}' is not kebab-case`);
  }
  assertNonEmptyString(persona.displayName, "displayName");
  assertNonEmptyString(persona.emoji, "emoji");
  assertNonEmptyString(persona.bio, "bio");
  assertNonEmptyString(persona.longBio, "longBio");

  if (!PERSONA_ARCHETYPES.includes(persona.archetype)) {
    throw new Error(`persona '${persona.slug}' has invalid archetype '${persona.archetype}'`);
  }

  if (persona.promptBias !== undefined && typeof persona.promptBias !== "string") {
    throw new Error(`persona '${persona.slug}' promptBias must be a string when present`);
  }

  if (persona.categoryFilter !== undefined) {
    if (!Array.isArray(persona.categoryFilter) || persona.categoryFilter.length === 0) {
      throw new Error(`persona '${persona.slug}' categoryFilter must be a non-empty array when present`);
    }
    for (const tag of persona.categoryFilter) {
      if (typeof tag !== "string" || tag.trim() === "") {
        throw new Error(`persona '${persona.slug}' categoryFilter entries must be non-empty strings`);
      }
    }
  }

  if (persona.ruleEvaluator !== undefined) {
    if (!RULE_EVALUATORS.includes(persona.ruleEvaluator)) {
      throw new Error(`persona '${persona.slug}' has invalid ruleEvaluator '${persona.ruleEvaluator}'`);
    }
  }

  if (persona.minConfidence !== undefined) {
    if (!Number.isInteger(persona.minConfidence) || persona.minConfidence < 0 || persona.minConfidence > 100) {
      throw new Error(`persona '${persona.slug}' minConfidence must be 0..100, got ${persona.minConfidence}`);
    }
  }

  if (persona.stakeUsdc !== undefined) {
    if (typeof persona.stakeUsdc !== "number" || persona.stakeUsdc <= 0) {
      throw new Error(`persona '${persona.slug}' stakeUsdc must be a positive number, got ${persona.stakeUsdc}`);
    }
  }

  const accent = persona.accent;
  if (!accent || typeof accent !== "object") {
    throw new Error(`persona '${persona.slug}' accent must be an object`);
  }
  for (const key of ["border", "bg", "text", "chip"] as const) {
    assertNonEmptyString(accent[key], `accent.${key}`);
  }
}

function validatePersonaRoster(personas: readonly PersonaSpec[]): void {
  const slugs = new Set<string>();
  const emojis = new Set<string>();
  const displayNames = new Set<string>();
  const promptBiases = new Set<string>();
  const archetypes = new Set<PersonaArchetype>();

  for (let i = 0; i < personas.length; i++) {
    const persona = personas[i];
    validatePersonaSpec(persona, i);

    if (slugs.has(persona.slug)) {
      throw new Error(`duplicate council persona slug '${persona.slug}'`);
    }
    slugs.add(persona.slug);

    if (emojis.has(persona.emoji)) {
      throw new Error(`duplicate council persona emoji '${persona.emoji}'`);
    }
    emojis.add(persona.emoji);

    if (displayNames.has(persona.displayName)) {
      throw new Error(`duplicate council persona displayName '${persona.displayName}'`);
    }
    displayNames.add(persona.displayName);

    if (persona.promptBias !== undefined) {
      if (promptBiases.has(persona.promptBias)) {
        throw new Error(`duplicate council persona promptBias for '${persona.slug}'`);
      }
      promptBiases.add(persona.promptBias);
    }

    archetypes.add(persona.archetype);
  }
}

validatePersonaRoster(COUNCIL_PERSONAS);

export function configureCouncilPersonaRegistry(adapter: CouncilPersonaRegistryAdapter): void {
  const personas = [...adapter.listClassicPersonas()];
  const slugs = new Set<string>();
  for (const persona of personas) {
    if (!persona.slug || slugs.has(persona.slug)) {
      throw new Error(`invalid council persona registry slug '${persona.slug}'`);
    }
    slugs.add(persona.slug);
  }
  validatePersonaRoster(personas);
  personaRegistry = adapter;
}

export function resetCouncilPersonaRegistry(): void {
  personaRegistry = LOCAL_PERSONA_REGISTRY;
}

export function listCouncilPersonas(): PersonaSpec[] {
  return [...personaRegistry.listClassicPersonas()];
}

/**
 * SLUG_UPPER for env var names: "crypto-maxi" -> "CRYPTO_MAXI".
 */
export function personaEnvSlug(persona: PersonaSpec): string {
  return persona.slug.replace(/-/g, "_").toUpperCase();
}

/**
 * Env var holding this persona's Stellar secret seed (`S…`).
 *
 * `_SECRET` / `_PUBLIC` rather than `_PRIVATE_KEY` / `_ADDRESS`, matching the
 * `STELLAR_DEPLOYER_SECRET` / `STELLAR_DEPLOYER_PUBLIC` convention the deploy
 * tooling already writes into `.env.local`.
 */
export function personaSecretEnv(persona: PersonaSpec): string {
  return `COUNCIL_${personaEnvSlug(persona)}_SECRET`;
}

/** Env var holding this persona's `G…` public key. Web-server safe. */
export function personaPublicEnv(persona: PersonaSpec): string {
  return `COUNCIL_${personaEnvSlug(persona)}_PUBLIC`;
}

/** Look up by slug. Returns null if not in roster. */
export function getPersonaBySlug(slug: string): PersonaSpec | null {
  return listCouncilPersonas().find((p) => p.slug === slug) ?? null;
}

/**
 * Look up by on-chain address. Returns null if not a council member.
 *
 * EXACT comparison, not case-insensitive: a Stellar `G…` strkey is case-sensitive
 * base32, so the lowercasing the EVM version did on both sides would match
 * nothing at all here.
 */
export function getPersonaByAddress(
  address: string,
  envLookup: (key: string) => string | undefined = (k) => process.env[k],
): PersonaSpec | null {
  const wanted = address.trim();
  if (!wanted) return null;
  for (const p of listCouncilPersonas()) {
    const configured = envLookup(personaPublicEnv(p))?.split(/\s+#/)[0].trim();
    if (configured && configured === wanted) return p;
  }
  return null;
}
