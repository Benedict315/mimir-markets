/**
 * Actor identity for analytics.
 *
 * A wallet address is a permanent, cross-site, on-chain identity. Sending it as
 * a PostHog distinct_id would make every funnel row a link between someone's
 * analytics profile and their entire on-chain history. So the address never
 * leaves the app: it is hashed with a server-held salt into a stable actor id.
 *
 * Stable, because funnels need the same user to be the same row across a
 * session. Not reversible without the salt, and rotating the salt severs the
 * link permanently.
 *
 * `actor_type` is carried separately so agent traffic can be filtered out of
 * human conversion metrics — an autonomous worker staking every cycle would
 * otherwise dominate the numbers.
 */

import { createHmac } from "node:crypto";
import { parseAddressParam } from "@/lib/server/api-validation";
import type { ActorType } from "./events";

export const ANON_ACTOR_ID = "anon";
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/**
 * A Stellar strkey in the account, muxed or contract flavours.
 *
 * Checked separately from {@link SAFE_AGENT_ID} as defence in depth: a wallet
 * address used as an agent id is a permanent cross-site identity, and that must
 * never reach `distinct_id` even if the charset check is loosened again. The id is used
 * verbatim, and `distinct_id` sits outside the properties redactor, so nothing
 * downstream would catch it.
 */
const RAW_IDENTITY = /^[GCM][A-Z2-7]{55}$/;

/**
 * Salt for the actor hash. Server-side only — a public salt would make the hash
 * trivially reversible by anyone who can enumerate addresses (which, on a public
 * chain, is everyone).
 */
function actorSalt(): string | null {
  const salt = process.env.ANALYTICS_ACTOR_SALT?.trim();
  return salt && salt.length >= 16 ? salt : null;
}

/**
 * Salted, truncated hash of an address. Returns null when no salt is configured
 * so the caller falls back to anonymous rather than sending a raw address.
 *
 * 128 bits of the digest is far beyond collision risk for this population and
 * keeps the id short enough to read in a PostHog table.
 */
export function opaqueAnalyticsId(value: string, salt = actorSalt()): string | null {
  if (!salt || salt.length < 16 || !value || value.length > 512) return null;
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, 32);
}

export function actorIdForAddress(address: string, salt = actorSalt()): string | null {
  // Trimmed but NOT case-folded, and validated as a strkey rather than as 0x-hex.
  // The EVM form this replaced rejected every Stellar address, so every event was
  // degraded to anonymous; folding case would additionally hash two different
  // accounts to the same actor id.
  const trimmed = parseAddressParam(address);
  if (!trimmed) return null;
  return opaqueAnalyticsId(trimmed, salt);
}

export interface ResolvedActor {
  actorId: string;
  actorType: ActorType;
  /** True when the address could not be hashed and the event is anonymous. */
  degraded: boolean;
}

/**
 * Resolve an address into the identity analytics may see. An unhashable address
 * degrades to anonymous — never to the raw address.
 */
export function resolveActor(args: {
  address?: string | null;
  isAgent?: boolean;
  agentId?: string;
  salt?: string | null;
}): ResolvedActor {
  const actorType: ActorType = args.isAgent ? "agent" : args.address ? "human" : "anonymous";

  if (args.isAgent) {
    // Agents are already public identities with published addresses, so their
    // registry id needs no salting. Reject missing or arbitrary values:
    // distinct_id is outside the properties redactor and has its own contract.
    if (!args.agentId || !SAFE_AGENT_ID.test(args.agentId) || RAW_IDENTITY.test(args.agentId.trim())) {
      return { actorId: ANON_ACTOR_ID, actorType: "anonymous", degraded: true };
    }
    return { actorId: `agent:${args.agentId}`, actorType, degraded: false };
  }
  if (!args.address) {
    return { actorId: ANON_ACTOR_ID, actorType: "anonymous", degraded: false };
  }
  const hashed = actorIdForAddress(args.address, args.salt === undefined ? actorSalt() : args.salt);
  if (!hashed) {
    return { actorId: ANON_ACTOR_ID, actorType: "anonymous", degraded: true };
  }
  return { actorId: hashed, actorType, degraded: false };
}

/**
 * Internal test wallets, so their traffic can be cohorted out of product
 * metrics instead of quietly inflating conversion.
 */
export function internalActorIds(salt = actorSalt()): string[] {
  const raw = process.env.ANALYTICS_INTERNAL_ADDRESSES?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((address) => actorIdForAddress(address, salt))
    .filter((id): id is string => id !== null);
}

export function isInternalActor(actorId: string, salt = actorSalt()): boolean {
  return internalActorIds(salt).includes(actorId);
}
