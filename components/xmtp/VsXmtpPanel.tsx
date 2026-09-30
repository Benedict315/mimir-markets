"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { VSData } from "@/lib/contract";
import { useWallet } from "@/lib/wallet";
import { useXmtp } from "@/lib/xmtp/XmtpProvider";
import {
  canOpenVsXmtpChat,
  getVsXmtpPeerAddress,
  getVsXmtpUnavailableReason,
  isOneVsOneDemoVs,
  shouldShowXmtpPeerUnreachableChatPreview,
} from "@/lib/xmtp/vs-chat-eligibility";
import { shortenAddress } from "@/lib/constants";
import { Button, Input } from "@/components/ui";
import VsXmtpChatPreviewShell from "@/components/xmtp/VsXmtpChatPreviewShell";
import XmtpFailureNotice from "@/components/xmtp/XmtpFailureNotice";
import {
  isXmtpInstallationsLimitError,
  XMTP_INBOX_TOOLS_URL,
} from "@/lib/xmtp/installation-limit-error";
import { ExternalLink, Lock, MessageCircle, RefreshCw, Trash2 } from "lucide-react";
import { useVsXmtpThread } from "@/hooks/useVsXmtpThread";
import { getDecodedMessageText } from "@/lib/xmtp/chat-thread";
import { nextXmtpFailure, type XmtpFailure } from "@/lib/xmtp/failure-state";import {
  decodedMessageMatchesPending,
  mergeThreadDisplayRows,
  normalizeXmtpMessageId,
  type OptimisticPendingMessage,
} from "@/lib/xmtp/optimistic-send";
import { GlassCard } from "@/components/ui";

const XMTP_PANEL_TITLE_FALLBACK: Record<string, string> = {
  en: "XMTP MESSAGES",
  es: "MENSAJES XMTP",
};

/**
 * IDs de mensajes propios ocultos solo en esta vista (localStorage).
 *
 * The address is used verbatim rather than lowercased: a Stellar strkey is
 * case-sensitive, and a key built from a mangled address is a key nothing else
 * agrees on.
 */
function hiddenMyMessagesStorageKey(peerAddress: string, inboxId: string): string {
  return `proven-xmtp-vs-hidden-my:${peerAddress.trim()}:${inboxId}`;
}

function formatMessageTime(d: Date, locale: string): string {
  const tag = locale.startsWith("es") ? "es-ES" : "en-US";
  return d.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
}

/** Same card width/centering as `/vs/[id]`. Hub passes `embedded` only to drop bottom margin inside its scroll parent. */
function vsPanelPageShell(embedded: boolean) {
  const layout = "w-full lg:mx-auto lg:max-w-[800px]";
  return embedded ? `${layout} mb-0` : `${layout} mb-6 sm:mb-8`;
}

/** Single scroll + padding spec for thread log (hub and VS detail must match). */
const VS_XMTP_PANEL_THREAD_SCROLL_CLASS =
  "max-h-[min(42vh,280px)] min-h-[128px] overflow-y-auto px-3 py-2.5 sm:max-h-[min(48vh,360px)] sm:min-h-[140px] sm:px-3.5 sm:py-3";

export type VsXmtpPanelProps = { vs: VSData; embedded?: boolean };

export default function VsXmtpPanel({ vs, embedded = false }: VsXmtpPanelProps) {
  const locale = useLocale();
  const t = useTranslations("xmtpVs");
  const panelTitle = useMemo(() => {
    const v = t("title");
    if (typeof v === "string" && v.startsWith("xmtpVs.")) {
      return XMTP_PANEL_TITLE_FALLBACK[locale] ?? XMTP_PANEL_TITLE_FALLBACK.en;
    }
    return v;
  }, [t, locale]);
  const { address, isConnected, connect } = useWallet();
  const {
    client,
    status: xmtpStatus,
    failure: xmtpFailure,
    featureEnabled,
    retry,
  } = useXmtp();

  const [sendFailure, setSendFailure] = useState<XmtpFailure | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingSends, setPendingSends] = useState<OptimisticPendingMessage[]>(
    []
  );
  const [hiddenMyMessageIds, setHiddenMyMessageIds] = useState<Set<string>>(
    () => new Set()
  );
  const [isThreadRetrying, setIsThreadRetrying] = useState(false);

  const peerAddress = useMemo(
    () => getVsXmtpPeerAddress(vs, address),
    [vs, address]
  );

  useEffect(() => {
    setPendingSends([]);
    setSendFailure(null);
    setDraft("");
  }, [peerAddress]);

  useEffect(() => {
    if (!peerAddress || !client?.inboxId) {
      setHiddenMyMessageIds(new Set());
      return;
    }
    try {
      const raw = localStorage.getItem(
        hiddenMyMessagesStorageKey(peerAddress, client.inboxId)
      );
      if (!raw) {
        setHiddenMyMessageIds(new Set());
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        setHiddenMyMessageIds(new Set());
        return;
      }
      setHiddenMyMessageIds(
        new Set(
          parsed
            .map((id) => normalizeXmtpMessageId(id))
            .filter(Boolean)
        )
      );
    } catch {
      setHiddenMyMessageIds(new Set());
    }
  }, [peerAddress, client?.inboxId]);

  const showChrome = featureEnabled && canOpenVsXmtpChat(vs);

  const threadEligible =
    showChrome &&
    isConnected &&
    Boolean(address) &&
    Boolean(peerAddress) &&
    xmtpStatus === "ready" &&
    Boolean(client);

  const {
    phase: threadPhase,
    dm,
    messages,
    threadError,
    threadFailure,
    streamFailure,
    isRefreshing,
    refreshThread,
    retryOpenThread,
    clearThreadError,
  } = useVsXmtpThread({
    threadEligible,
    client: client ?? null,
    peerAddress: peerAddress ?? "",
  });

  const isXmtpBoot = xmtpStatus === "initializing";
  /** El mismo estado, leído por el aviso como "hay un intento en vuelo". */
  const isXmtpRetrying = isXmtpBoot;

  /**
   * Fallo de arranque. `ready` sin `client` es un invariante roto (el provider
   * nunca publica ese par), así que se clasifica en vez de quedar mudo: el panel
   * tiene que poder reintentar aunque el estado venga inconsistente.
   */
  const xmtpProviderFailure = useMemo<XmtpFailure | null>(() => {
    if (xmtpFailure) return xmtpFailure;
    if (xmtpStatus === "ready" && !client) {
      return nextXmtpFailure(
        null,
        "unknown",
        "XMTP_READY_WITHOUT_CLIENT"
      );
    }
    if (xmtpStatus === "blocked_by_tab") {
      return nextXmtpFailure(null, "blocked_by_tab", "XMTP_TAB_LOCK_HELD");
    }
    return null;
  }, [xmtpFailure, xmtpStatus, client]);

  const innerLoading =
    threadEligible &&
    (threadPhase === "loading" || threadPhase === "idle");

  const innerReady = threadEligible && threadPhase === "ready" && dm;
  const innerThreadError =
    threadEligible && threadPhase === "error" && threadError;

  const showPeerUnreachablePreview =
    Boolean(threadError) &&
    shouldShowXmtpPeerUnreachableChatPreview(vs, threadError?.kind);

  const showInboxToolsForInstallLimit = useMemo(
    () => xmtpProviderFailure?.kind === "installations_limit",
    [xmtpProviderFailure]
  );

  /** Reset thread retrying state when thread phase leaves loading/idle. */
  useEffect(() => {
    if (threadPhase === "ready" || threadPhase === "error") {
      setIsThreadRetrying(false);
    }
  }, [threadPhase]);

  /** Cuando el stream incorpora el mensaje real, quita la burbuja optimista. */
  useEffect(() => {
    const myInboxId = client?.inboxId;
    setPendingSends((prev) =>
      prev.filter((p) => {
        if (!p.serverMessageId) return true;
        return !messages.some((m) =>
          decodedMessageMatchesPending(m, p, { myInboxId })
        );
      })
    );
  }, [messages, client?.inboxId]);

  const displayRows = useMemo(() => {
    const merged = mergeThreadDisplayRows(messages, pendingSends, {
      myInboxId: client?.inboxId,
    });
    const myInbox = client?.inboxId;
    if (!myInbox) return merged;
    return merged.filter((row) => {
      if (row.kind === "pending") return true;
      if (row.message.senderInboxId !== myInbox) return true;
      return !hiddenMyMessageIds.has(normalizeXmtpMessageId(row.message.id));
    });
  }, [messages, pendingSends, client?.inboxId, hiddenMyMessageIds]);

  const hasMyVisibleToClear = useMemo(() => {
    const myInbox = client?.inboxId;
    if (!myInbox) return false;
    if (pendingSends.length > 0) return true;
    return messages.some((m) => {
      if (m.senderInboxId !== myInbox) return false;
      return !hiddenMyMessageIds.has(normalizeXmtpMessageId(m.id));
    });
  }, [client?.inboxId, messages, pendingSends, hiddenMyMessageIds]);

  const threadScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = threadScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [displayRows]);

  const handleSend = useCallback(async () => {
    if (!dm) return;
    const text = draft.trim();
    if (!text) return;
    clearThreadError();
    setSendFailure(null);
    const clientTempId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sentAt = new Date();
    setDraft("");
    setIsSending(true);
    setPendingSends((prev) => [
      ...prev,
      { clientTempId, text, sentAt, status: "sending" },
    ]);
    try {
      const rawId = await dm.sendText(text, true);
      const serverMessageId =
        rawId == null ? undefined : String(rawId);
      setPendingSends((prev) =>
        prev.map((p) =>
          p.clientTempId === clientTempId
            ? { ...p, serverMessageId, status: "sent" as const }
            : p
        )
      );
    } catch (e) {
      setPendingSends((prev) =>
        prev.filter((p) => p.clientTempId !== clientTempId)
      );
      const technical = e instanceof Error ? e.message : String(e);
      // El texto vuelve al draft solo si el usuario no ha escrito otra cosa: un
      // envío fallido nunca debe perder lo que la persona escribió.
      setDraft((prev) => (prev.trim() ? prev : text));
      setSendFailure((prev) =>
        nextXmtpFailure(prev, "send_failed", technical)
      );
    } finally {
      setIsSending(false);
    }
  }, [dm, draft, clearThreadError]);

  const handleClearMyMessages = useCallback(() => {
    const myInbox = client?.inboxId;
    if (!myInbox || !peerAddress) return;
    if (!hasMyVisibleToClear) return;
    if (typeof window !== "undefined" && !window.confirm(t("clearMyMessagesConfirm"))) {
      return;
    }
    const idsFromThread = messages
      .filter((m) => m.senderInboxId === myInbox)
      .map((m) => normalizeXmtpMessageId(m.id))
      .filter(Boolean);
    setHiddenMyMessageIds((prev) => {
      const next = new Set(prev);
      idsFromThread.forEach((id) => next.add(id));
      try {
        localStorage.setItem(
          hiddenMyMessagesStorageKey(peerAddress, myInbox),
          JSON.stringify(Array.from(next))
        );
      } catch { /* quota / private mode */ }
      return next;
    });
    setPendingSends([]);
    setSendFailure(null);
  }, [
    client?.inboxId,
    peerAddress,
    messages,
    hasMyVisibleToClear,
    t,
  ]);

  const unavailableCopy = useMemo(() => {
    if (canOpenVsXmtpChat(vs)) return null;
    const reason = getVsXmtpUnavailableReason(vs);
    if (reason === "multi_challenger") return t("unavailableMultiChallenger");
    if (reason === "waiting_opponent") return t("unavailableWaitingOpponent");
    if (reason === "not_accepted") return t("unavailableNotAccepted");
    return t("needsAccepted");
  }, [vs, t]);

  if (!featureEnabled) {
    if (isOneVsOneDemoVs(vs)) {
      return (
        <div
          className={`card border border-pv-ink/[0.08] p-5 ${vsPanelPageShell(embedded)}`}
        >
          <div className="flex min-w-0 gap-3 sm:gap-3.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-pv-muted/15 text-pv-muted"
              aria-hidden
            >
              <MessageCircle size={16} strokeWidth={2} />
            </span>
            <div className="min-w-0 space-y-1">
              <h3 className="font-display text-xs font-bold uppercase tracking-[0.18em] text-pv-text sm:tracking-[0.2em]">
                {t("featureOffTitle")}
              </h3>
              <p className="text-[10px] leading-relaxed text-pv-muted sm:text-[11px]">
                {t("featureOffDesc")}
              </p>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  if (!canOpenVsXmtpChat(vs)) {
    return (
      <GlassCard
        glass
        glow="none"
        noPad
        className={`!rounded-2xl border border-pv-ink/[0.12] ${vsPanelPageShell(embedded)}`}
      >
        <div className="flex w-full min-w-0 items-start gap-3 px-5 py-5 sm:gap-3.5 sm:px-8 sm:py-6">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-pv-emerald/10 text-pv-emerald"
            aria-hidden
          >
            <MessageCircle size={16} strokeWidth={2} />
          </span>
          <div className="min-w-0 space-y-1">
            <h3 className="font-display text-xs font-bold uppercase tracking-[0.18em] text-pv-text sm:tracking-[0.2em]">
              {panelTitle}
            </h3>
            <p className="text-[10px] leading-relaxed text-pv-muted sm:text-[11px]">
              {unavailableCopy}
            </p>
          </div>
        </div>
      </GlassCard>
    );
  }

  if (!isConnected || !address) {
    return (
      <div
        className={`card border border-pv-ink/[0.08] p-5 ${vsPanelPageShell(embedded)}`}
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 gap-3 sm:gap-3.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-pv-emerald/10 text-pv-emerald"
              aria-hidden
            >
              <MessageCircle size={16} strokeWidth={2} />
            </span>
            <div className="min-w-0 space-y-1">
              <h3 className="font-display text-xs font-bold uppercase tracking-[0.18em] text-pv-text sm:tracking-[0.2em]">
                {panelTitle}
              </h3>
              <p className="text-[10px] leading-relaxed text-pv-muted sm:text-[11px]">
                {t("needsWallet")}
              </p>
            </div>
          </div>
          <Button type="button" variant="primary" fullWidth={false} onClick={connect}>
            {t("connectToChat")}
          </Button>
        </div>
      </div>
    );
  }

  if (!peerAddress) {
    return (
      <div
        className={`card border border-pv-ink/[0.08] p-5 ${vsPanelPageShell(embedded)}`}
      >
        <div className="flex min-w-0 gap-3 sm:gap-3.5">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-pv-emerald/10 text-pv-emerald"
            aria-hidden
          >
            <MessageCircle size={16} strokeWidth={2} />
          </span>
          <div className="min-w-0 space-y-1">
            <h3 className="font-display text-xs font-bold uppercase tracking-[0.18em] text-pv-text sm:tracking-[0.2em]">
              {panelTitle}
            </h3>
            <p className="text-[10px] leading-relaxed text-pv-muted sm:text-[11px]">
              {t("participantOnly")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`card overflow-hidden rounded-xl border border-pv-ink/[0.1] p-0 ${vsPanelPageShell(embedded)}`}
    >
      <div className="border-b border-pv-ink/[0.08] bg-pv-bg/25 px-5 py-3.5 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 gap-3 sm:gap-3.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-pv-emerald/10 text-pv-emerald"
              aria-hidden
            >
              <MessageCircle size={16} strokeWidth={2} />
            </span>
            <div className="min-w-0 space-y-1">
              <h3 className="font-display text-xs font-bold uppercase tracking-[0.18em] text-pv-text sm:tracking-[0.2em]">
                {panelTitle}
              </h3>
              <p className="text-[10px] leading-relaxed text-pv-muted sm:text-[11px]">
                {t("withPeer", { address: shortenAddress(peerAddress) })}
              </p>
            </div>
          </div>
          {innerReady && (
            <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                fullWidth={false}
                disabled={!hasMyVisibleToClear}
                onClick={handleClearMyMessages}
                className="text-pv-muted hover:bg-pv-ink/[0.04] hover:text-pv-text disabled:opacity-40"
                aria-label={t("clearMyMessagesAria")}
                title={t("clearMyMessagesAria")}
              >
                <Trash2 size={16} aria-hidden />
                <span className="hidden sm:inline">{t("clearMyMessages")}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                fullWidth={false}
                disabled={isRefreshing}
                onClick={() => void refreshThread()}
                className="shrink-0 text-pv-muted hover:bg-pv-ink/[0.04] hover:text-pv-text"
                aria-busy={isRefreshing}
              >
                <RefreshCw
                  size={16}
                  className={isRefreshing ? "animate-spin" : undefined}
                  aria-hidden
                />
                {isRefreshing ? t("syncingMessages") : t("refreshThread")}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4 px-5 py-4 sm:px-6 sm:py-5">
      {isXmtpBoot && (
        <p className="text-xs text-pv-muted animate-pulse">{t("initializingXmtp")}</p>
      )}

      {xmtpProviderFailure && (
        <XmtpFailureNotice
          failure={xmtpProviderFailure}
          tone={xmtpProviderFailure.kind === "blocked_by_tab" ? "warning" : "danger"}
          isRetrying={isXmtpRetrying}
          eyebrow={t("providerErrorEyebrow")}
          onRetry={() => {
            retry();
            clearThreadError();
          }}
          action={
            showInboxToolsForInstallLimit ? (
              <div className="rounded-lg border border-pv-ink/[0.1] bg-pv-bg/40 px-3 py-2.5 sm:px-3.5 sm:py-3">
                <div className="flex flex-row items-center justify-between gap-3">
                  <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-pv-muted">
                    {t("installationsLimitGuide")}
                  </p>
                  <a
                    href={XMTP_INBOX_TOOLS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-pv-ink/[0.12] bg-pv-ink/[0.04] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-pv-muted transition-[border-color,background-color,color] hover:border-pv-ink/[0.18] hover:bg-pv-ink/[0.06] hover:text-pv-text/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-ink/15 whitespace-nowrap"
                  >
                    <ExternalLink size={12} className="shrink-0 opacity-70" aria-hidden />
                    {t("openInboxTools")}
                  </a>
                </div>
              </div>
            ) : null
          }
        />
      )}

      {!xmtpProviderFailure && innerLoading && (
        <div
          className="space-y-2.5"
          role="status"
          aria-live="polite"
          aria-label={t("loadingConversation")}
        >
          <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-pv-muted/80">
            {t("loadingConversation")}
          </p>
          <div className="flex flex-col gap-2.5 rounded-lg border border-pv-ink/[0.08] bg-pv-bg/35 p-3.5">
            <div className="h-3.5 w-[68%] max-w-[220px] animate-pulse rounded-lg bg-pv-ink/[0.07]" />
            <div className="ml-auto h-3.5 w-[52%] max-w-[160px] animate-pulse rounded-lg bg-pv-emerald/15" />
            <div className="h-3.5 w-[58%] max-w-[180px] animate-pulse rounded-lg bg-pv-ink/[0.06]" />
          </div>
        </div>
      )}

      {!xmtpProviderFailure &&
        innerThreadError &&
        threadFailure &&
        showPeerUnreachablePreview && (
          <div className="space-y-3">
            <XmtpFailureNotice
              failure={threadFailure}
              tone="warning"
              eyebrow={t("chatPreviewEyebrow")}
              isRetrying={isThreadRetrying}
              onRetry={() => {
                setIsThreadRetrying(true);
                retryOpenThread();
                setSendFailure(null);
                setPendingSends([]);
              }}
            />
            <VsXmtpChatPreviewShell
              peerShort={shortenAddress(peerAddress)}
              viewerShort={shortenAddress(address)}
            />
          </div>
        )}

      {!xmtpProviderFailure &&
        innerThreadError &&
        threadFailure &&
        !showPeerUnreachablePreview && (
          <XmtpFailureNotice
            failure={threadFailure}
            isRetrying={isThreadRetrying}
            onRetry={() => {
              setIsThreadRetrying(true);
              retryOpenThread();
              setSendFailure(null);
              setPendingSends([]);
            }}
          />
        )}

      {!xmtpProviderFailure && innerReady && dm && client && streamFailure && (
        <XmtpFailureNotice
          failure={streamFailure}
          tone="warning"
          isRetrying={isThreadRetrying}
          eyebrow={t("streamLostEyebrow")}
          onRetry={() => {
            setIsThreadRetrying(true);
            retryOpenThread();
            setPendingSends([]);
          }}
        >
          {t("streamLostStaleHint")}
        </XmtpFailureNotice>
      )}

      {!xmtpProviderFailure && innerReady && dm && client && (
        <>
          <div className="overflow-hidden rounded-lg border border-pv-ink/[0.08] bg-pv-bg/40">
            <div className="flex items-center justify-between gap-3 border-b border-pv-ink/[0.08] px-3 py-2.5 sm:px-3.5">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-pv-muted">
                {shortenAddress(peerAddress)}
              </p>
              <Link
                href={`/vs/create?duelWith=${encodeURIComponent(peerAddress)}&fromConversation=${vs.id}`}
                className="focus-ring rounded-md border border-pv-emerald/25 bg-pv-emerald/[0.07] px-2.5 py-1.5 font-display text-[9px] font-bold uppercase tracking-[0.12em] text-pv-emerald transition hover:bg-pv-emerald/[0.12]"
              >
                {t("createDuel")}
              </Link>
            </div>
            <div
              ref={threadScrollRef}
              className={VS_XMTP_PANEL_THREAD_SCROLL_CLASS}
              role="log"
              aria-label={t("chatScrollAria")}
              aria-live="polite"
              aria-relevant="additions"
            >
              {displayRows.length === 0 ? (
                <div className="flex min-h-[112px] flex-col items-center justify-center gap-2.5 px-3 py-7 text-center sm:min-h-[128px]">
                  <div
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-pv-ink/[0.08] bg-pv-bg/30 text-pv-emerald/80"
                    aria-hidden
                  >
                    <MessageCircle size={18} strokeWidth={1.75} />
                  </div>
                  <div className="space-y-0.5">
                    <p className="font-display text-[10px] font-bold uppercase tracking-[0.12em] text-pv-text/85">
                      {t("emptyThread")}
                    </p>
                    <p className="mx-auto max-w-[240px] text-[10px] leading-relaxed text-pv-muted/70">
                      {t("emptyThreadHint")}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {displayRows.map((row) => {
                    if (row.kind === "decoded") {
                      const m = row.message;
                      const mine =
                        Boolean(client.inboxId) &&
                        m.senderInboxId === client.inboxId;
                      const peerShort = shortenAddress(peerAddress);
                      const label = mine ? t("messageFromYou") : peerShort;
                      return (
                        <div
                          key={m.id}
                          className={`flex w-full ${mine ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-[min(92%,20rem)] rounded-lg px-3 py-2 ${
                              mine
                                ? "border border-pv-emerald/20 bg-pv-emerald/[0.08] text-pv-text"
                                : "border border-pv-ink/[0.07] bg-pv-surface2/90 text-pv-text/90"
                            }`}
                          >
                            <p
                              className={`mb-1 text-[10px] tabular-nums text-pv-muted/80 ${
                                mine ? "text-right" : "text-left"
                              }`}
                            >
                              <span className="font-mono">{label}</span>
                              <span className="mx-1 opacity-40" aria-hidden>
                                ·
                              </span>
                              <time dateTime={m.sentAt.toISOString()}>
                                {formatMessageTime(m.sentAt, locale)}
                              </time>
                            </p>
                            <p className="text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                              {getDecodedMessageText(m)}
                            </p>
                          </div>
                        </div>
                      );
                    }
                    const { pending } = row;
                    return (
                      <div
                        key={pending.clientTempId}
                        className="flex w-full justify-end"
                        aria-live="polite"
                      >
                        <div className="max-w-[min(92%,20rem)] rounded-lg border border-transparent bg-pv-emerald/[0.06] px-3 py-2 text-pv-text">
                          <p className="mb-1 text-right text-[10px] tabular-nums text-pv-muted/80">
                            <span className="font-mono">{t("messageFromYou")}</span>
                            <span className="mx-1 opacity-40" aria-hidden>
                              ·
                            </span>
                            <time dateTime={pending.sentAt.toISOString()}>
                              {formatMessageTime(pending.sentAt, locale)}
                            </time>
                          </p>
                          <p className="text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                            {pending.text}
                          </p>
                          <p className="mt-1.5 text-[10px] text-pv-muted/75">
                            {pending.status === "sending"
                              ? t("sendingMessage")
                              : t("messageQueued")}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="bg-pv-bg/[0.08] px-3 pb-2.5 pt-1.5 sm:px-3.5 sm:pb-3 sm:pt-2">
              {sendFailure ? (
                <div className="mb-2">
                  <XmtpFailureNotice
                    failure={sendFailure}
                    isRetrying={isSending}
                    eyebrow={t("sendFailedEyebrow")}
                    onRetry={() => void handleSend()}
                  >
                    {t("sendFailedDraftKept")}
                  </XmtpFailureNotice>
                </div>
              ) : null}
              <div className="flex w-full min-w-0 items-center gap-2 sm:gap-2.5">
                <div className="min-w-0 flex-1 [&_input]:w-full">
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={t("placeholderInput")}
                    className="h-[46px] rounded-lg border-pv-ink/[0.08] bg-pv-bg/35 text-[13px] placeholder:text-pv-muted/45 focus-visible:border-pv-emerald/25"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                  />
                </div>
                <Button
                  type="button"
                  variant="primary"
                  fullWidth={false}
                  className="h-[46px] shrink-0 px-5 !py-0 text-[13px] font-semibold sm:min-w-[5.25rem]"
                  disabled={!draft.trim()}
                  onClick={() => void handleSend()}
                >
                  {t("send")}
                </Button>
              </div>
            </div>
          </div>

          <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-pv-muted/55">
            <Lock
              size={11}
              className="mt-0.5 shrink-0 opacity-60"
              aria-hidden
            />
            <span>{t("disclaimer")}</span>
          </p>
        </>
      )}
      </div>
    </div>
  );
}
