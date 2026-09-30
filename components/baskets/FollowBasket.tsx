"use client";

/**
 * Follow a basket by mirroring it from your own wallet.
 *
 * Deliberately not called "deposit" or "invest": nothing is transferred here, and
 * calling it investing would promise custody Mimir does not offer and its own ADR
 * forbids. What the user signs says the same thing in the wallet prompt.
 */

import { useState } from "react";

import { FeeBreakdown } from "@/components/fees/FeeBreakdown";
import { useWallet } from "@/lib/wallet";

/**
 * Mirrors the server's message byte for byte.
 *
 * The address is interpolated VERBATIM. The EVM version lowercased it, which was
 * free there and is destructive here: a Stellar strkey is case-sensitive base32,
 * so a lowercased `G…` is a different (invalid) string and the signature would
 * never verify.
 */
function subscribeMessage(args: { basketId: string; subscriber: string; perMarketUsdc: number }): string {
  return [
    "Mimir basket subscription",
    `basket: ${args.basketId}`,
    `subscriber: ${args.subscriber}`,
    `per market: ${args.perMarketUsdc} USDC`,
    "Mimir never holds your funds. Every stake is signed by you.",
  ].join("\n");
}

export function FollowBasket({
  basketId, creatorWallet,
}: { basketId: string; creatorWallet?: string }) {
  const { address, isConnected, connect, signMessage, canSignMessages } = useWallet();

  const [perMarket, setPerMarket] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);

  // Your own basket charges you no basket fee, so say so before they pay attention
  // to the fee line rather than after. Exact comparison, not a lowercased one:
  // strkeys are case-sensitive.
  const isOwn = Boolean(address && creatorWallet && address.trim() === creatorWallet.trim());

  async function toggle() {
    if (!address) return void connect();
    if (!canSignMessages) {
      setError(
        "This wallet cannot sign off-chain messages. Reconnect with Freighter, xBull or Hana to follow a basket.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const signature = await signMessage(
        subscribeMessage({ basketId, subscriber: address, perMarketUsdc: following ? 0 : perMarket }),
      );
      const response = await fetch(`/api/baskets/${basketId}/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscriber: address,
          perMarketUsdc: following ? 0 : perMarket,
          unsubscribe: following,
          signature,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "could not update subscription");
      setFollowing(Boolean(payload.subscribed));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(/user rejected|denied/i.test(message) ? "Signature rejected in your wallet." : message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-pv-ink/[0.12] bg-pv-surface/40 p-4">
      <h3 className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">Follow this basket</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-pv-muted">
        Mirror its members from your own wallet, up to the amount you set per market.
        Nothing is deposited and Mimir never holds your funds — each stake is a
        transaction you sign.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">Per market</span>
          <input
            type="number" min={1} max={100} step={1}
            value={perMarket}
            disabled={following}
            onChange={(e) => setPerMarket(Math.max(1, Math.min(100, Number(e.target.value))))}
            className="w-20 border border-pv-ink/[0.14] bg-pv-bg px-2 py-1.5 text-right font-mono text-[13px] text-pv-text outline-none focus:border-pv-emerald/50 disabled:opacity-50"
          />
          <span className="font-mono text-[11px] text-pv-muted">USDC</span>
        </label>
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          className={following
            ? "border border-pv-ink/[0.14] px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-pv-muted transition-colors hover:text-pv-text"
            : "btn-compact-primary px-3.5 py-1.5 text-[12px]"}
        >
          {!isConnected ? "Connect to follow"
            : busy ? "Waiting for signature…"
            : following ? "Unfollow"
            : "Follow"}
        </button>
      </div>

      {error && <p className="mt-2 text-[12px] text-pv-danger">{error}</p>}

      <FeeBreakdown context="follow" isOwn={isOwn} />
    </div>
  );
}

