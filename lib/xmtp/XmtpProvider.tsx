"use client";

/**
 * Contexto del cliente XMTP (Paso 4).
 *
 * - Crea `Client` con `Client.create(signer, options)` cuando hay wallet conectada.
 * - Respeta `NEXT_PUBLIC_FEATURE_XMTP` (sin crear cliente si está desactivado).
 * - Cierra el cliente con `close()` al desconectar, cambiar cuenta o desmontar (doc XMTP).
 *
 * Debe montarse **dentro** de `WalletProvider`.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 *
 * XMTP's protocol requires an address-shaped inbox identity, which a Stellar
 * `G…` account is not. Rather than demand a second wallet, the connected
 * Stellar wallet signs one fixed message and `lib/xmtp/identity.ts` derives that
 * identity from the signature — deterministically, so the same account gets the
 * same inbox back on any device. That prompt is deliberately behind
 * `isXmtpFeatureEnabled()`: with the flag off, no wallet dialog ever opens.
 *
 * The two failure modes this provider used to report — "the connected wallet is
 * a Stellar account" and "no injected provider" — are gone, because neither is
 * a failure anymore. What can still fail is the derivation signature itself
 * (declined, or a wallet that cannot sign messages at all), which surfaces as
 * `status: "error"` with the message from `XmtpSignerError`.
 *
 * @see https://docs.xmtp.org/chat-apps/core-messaging/create-a-client
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Client, type XmtpEnv } from "@xmtp/browser-sdk";
import { useWallet } from "@/lib/wallet";
import type { XmtpClientInstance } from "@/lib/xmtp/types";
import {
  getXmtpClientCreateOptions,
  isXmtpFeatureEnabled,
} from "@/lib/xmtp/config";
import { clearXmtpIdentityCache } from "@/lib/xmtp/identity";
import {
  createXmtpSignerForStellarAccount,
  XmtpSignerError,
} from "@/lib/xmtp/signer";
import {
  clearXmtpFailure,
  classifyXmtpFailureKind,
  nextXmtpFailure,
  xmtpAutoRetryDelayMs,
  type XmtpFailure,
} from "@/lib/xmtp/failure-state";

export type XmtpClientStatus =
  /** Sin wallet o aún no aplicable */
  | "idle"
  /** `NEXT_PUBLIC_FEATURE_XMTP` no está activo */
  | "disabled"
  /** Creando cliente (puede solicitar firma al registrar inbox) */
  | "initializing"
  | "ready"
  | "error"
  /** XMTP is already active in another tab (OPFS lock conflict) */
  | "blocked_by_tab";

export type XmtpContextValue = {
  /** Instancia lista para `conversations`, etc. Solo con `status === "ready"`. */
  client: XmtpClientInstance | null;
  status: XmtpClientStatus;
  error: Error | null;
  /**
   * Clasificación accionable del fallo actual, o `null` si no hay ninguno.
   * La UI debe mapear `failure.kind` a i18n y usar `failure.technical` solo para
   * soporte; `error` se conserva por compatibilidad y no es para pintar.
   */
  failure: XmtpFailure | null;
  /** Cuenta Stellar con la que se intentó / logró inicializar (null si idle/disabled). */
  activeAddress: string | null;
  /**
   * Inbox identity derived from `activeAddress` — the address XMTP knows this
   * user by. Null until derivation succeeds.
   */
  inboxAddress: string | null;
  /** Indica si la feature flag está encendida (build-time). */
  featureEnabled: boolean;
  /** Reintenta `Client.create` tras un fallo (misma cuenta). */
  retry: () => void;
};

const defaultValue: XmtpContextValue = {
  client: null,
  status: "idle",
  error: null,
  failure: null,
  activeAddress: null,
  inboxAddress: null,
  featureEnabled: false,
  retry: () => {},
};

const XmtpCtx = createContext<XmtpContextValue>(defaultValue);

/* ── OPFS tab-lock via BroadcastChannel ── */
const XMTP_TAB_LOCK_CHANNEL = "proven-xmtp-tab-lock";
const XMTP_TAB_LOCK_KEY = "proven-xmtp-tab-owner";

function isXmtpOpfsStorageError(error: unknown) {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error ?? "");

  return /NoModificationAllowedError|sync access handle|createSyncAccessHandle|FileSystemSyncAccessHandle|OPFS/i.test(
    message
  );
}

function createXmtpInitTimeout(timeoutMs: number) {
  return new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            "XMTP client initialization timed out. Try closing other tabs or clearing site data."
          )
        ),
      timeoutMs
    )
  );
}

function acquireTabLock(tabId: string): { acquired: boolean; release: () => void } {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return { acquired: true, release: () => {} };
  }

  const existing = sessionStorage.getItem(XMTP_TAB_LOCK_KEY);
  // If this tab already owns the lock, allow it
  if (existing === tabId) {
    return { acquired: true, release: () => sessionStorage.removeItem(XMTP_TAB_LOCK_KEY) };
  }

  // Try to claim via localStorage (cross-tab)
  const now = Date.now();
  const raw = localStorage.getItem(XMTP_TAB_LOCK_KEY);
  if (raw) {
    try {
      const lock = JSON.parse(raw) as { tabId: string; ts: number };
      // If the lock is from another tab and still fresh (< 30s), we're blocked
      if (lock.tabId !== tabId && now - lock.ts < 30_000) {
        return { acquired: false, release: () => {} };
      }
    } catch { /* corrupt, overwrite */ }
  }

  // Claim the lock
  localStorage.setItem(XMTP_TAB_LOCK_KEY, JSON.stringify({ tabId, ts: now }));
  sessionStorage.setItem(XMTP_TAB_LOCK_KEY, tabId);

  // Keep the lock alive with a heartbeat
  const heartbeat = setInterval(() => {
    localStorage.setItem(XMTP_TAB_LOCK_KEY, JSON.stringify({ tabId, ts: Date.now() }));
  }, 10_000);

  // Notify other tabs
  try {
    const ch = new BroadcastChannel(XMTP_TAB_LOCK_CHANNEL);
    ch.postMessage({ type: "xmtp-lock-acquired", tabId });
    ch.close();
  } catch { /* BroadcastChannel not supported */ }

  const release = () => {
    clearInterval(heartbeat);
    try {
      const current = localStorage.getItem(XMTP_TAB_LOCK_KEY);
      if (current) {
        const parsed = JSON.parse(current) as { tabId: string };
        if (parsed.tabId === tabId) localStorage.removeItem(XMTP_TAB_LOCK_KEY);
      }
    } catch { /* ignore */ }
    sessionStorage.removeItem(XMTP_TAB_LOCK_KEY);
  };

  return { acquired: true, release };
}

function getTabId(): string {
  if (typeof window === "undefined") return "";
  let id = sessionStorage.getItem("proven-tab-id");
  if (!id) {
    id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem("proven-tab-id", id);
  }
  return id;
}
/* ── end tab-lock ── */

export function XmtpProvider({ children }: { children: React.ReactNode }) {
  const { address, isConnected, signMessage } = useWallet();
  const featureEnabled = useMemo(() => isXmtpFeatureEnabled(), []);

  const [client, setClient] = useState<XmtpClientInstance | null>(null);
  const [status, setStatus] = useState<XmtpClientStatus>(
    featureEnabled ? "idle" : "disabled"
  );
  const [error, setError] = useState<Error | null>(null);
  const [failure, setFailure] = useState<XmtpFailure | null>(null);
  const [activeAddress, setActiveAddress] = useState<string | null>(null);
  const [inboxAddress, setInboxAddress] = useState<string | null>(null);
  const [retryTrigger, setRetryTrigger] = useState(0);
  /**
   * Fallo anterior inmediato, sin filtrar por `kind`. El contador de intentos vive
   * en `nextXmtpFailure`; este ref solo existe para que el temporizador de
   * reintento desatendido sepa qué clase de fallo acaba de ocurrir, incluso si el
   * estado ya se limpió.
   */
  const failureRef = useRef<XmtpFailure | null>(null);

  const recordFailure = useCallback((next: XmtpFailure) => {
    failureRef.current = next;
    setFailure(next);
  }, []);

  const dropFailure = useCallback(() => {
    failureRef.current = clearXmtpFailure();
    setFailure(clearXmtpFailure());
  }, []);

  // `signMessage` from the wallet context is a stable `useCallback`, but the
  // init effect must not re-run if that ever stops being true: re-running it
  // would mean a second wallet prompt.
  const signMessageRef = useRef(signMessage);
  signMessageRef.current = signMessage;

  const clientRef = useRef<XmtpClientInstance | null>(null);
  const initGenRef = useRef(0);
  const tabId = useMemo(() => getTabId(), []);
  const lockReleaseRef = useRef<(() => void) | null>(null);

  const retry = useCallback(() => {
    setRetryTrigger((n) => n + 1);
  }, []);

  /**
   * Reintento desatendido con backoff, solo para fallos transitorios.
   *
   * `signature_declined` queda fuera a propósito: reintentarlo por debajo de la
   * pantalla reabriría el diálogo de la wallet sin que nadie lo pidiera, y una
   * firma rechazada es una decisión, no una avería. El corte en
   * `xmtpAutoRetryDelayMs` evita además un bucle infinito con la UI cerrada.
   */
  useEffect(() => {
    if (!failure || !featureEnabled) return;
    // While an attempt is in flight the notice stays on screen with a busy Retry
    // button; scheduling another unattended retry then would double up with it.
    if (status === "initializing") return;
    const delay = xmtpAutoRetryDelayMs(failure);
    if (delay == null) return;
    const id = window.setTimeout(() => {
      if (failureRef.current !== failure) return;
      retry();
    }, delay);
    return () => window.clearTimeout(id);
  }, [failure, featureEnabled, status, retry]);

  // Listen for lock releases from other tabs so we can auto-retry
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined" || !featureEnabled) return;
    const ch = new BroadcastChannel(XMTP_TAB_LOCK_CHANNEL);
    ch.onmessage = (ev) => {
      if (ev.data?.type === "xmtp-lock-released" && status === "blocked_by_tab") {
        retry();
      }
    };
    return () => ch.close();
  }, [featureEnabled, status, retry]);

  // Release lock on unmount / page unload
  useEffect(() => {
    const handleUnload = () => {
      lockReleaseRef.current?.();
      try {
        const ch = new BroadcastChannel(XMTP_TAB_LOCK_CHANNEL);
        ch.postMessage({ type: "xmtp-lock-released", tabId });
        ch.close();
      } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      handleUnload();
    };
  }, [tabId]);

  useEffect(() => {
    if (!featureEnabled) {
      setStatus("disabled");
      setClient(null);
      setActiveAddress(null);
      setInboxAddress(null);
      setError(null);
      dropFailure();
      if (clientRef.current) {
        try {
          clientRef.current.close();
        } catch {
          /* ignore */
        }
        clientRef.current = null;
      }
      return;
    }

    if (!isConnected || !address) {
      initGenRef.current += 1;
      if (clientRef.current) {
        try {
          clientRef.current.close();
        } catch {
          /* ignore */
        }
        clientRef.current = null;
      }
      lockReleaseRef.current?.();
      lockReleaseRef.current = null;
      setClient(null);
      setActiveAddress(null);
      setInboxAddress(null);
      setError(null);
      dropFailure();
      setStatus("idle");
      // The derived key is memory-only; dropping it on disconnect means the next
      // account signs for its own identity instead of inheriting this one.
      clearXmtpIdentityCache();
      return;
    }

    // Check tab lock before attempting Client.create
    const lock = acquireTabLock(tabId);
    if (!lock.acquired) {
      setClient(null);
      setActiveAddress(address);
      const technical =
        "Chat is active in another tab. Close it to use chat here.";
      setError(new Error(technical));
      recordFailure(
        nextXmtpFailure(failureRef.current, "blocked_by_tab", technical)
      );
      setStatus("blocked_by_tab");
      return;
    }
    lockReleaseRef.current = lock.release;

    const myGen = ++initGenRef.current;
    setStatus("initializing");
    setError(null);
    // The failure is deliberately NOT cleared here: a retry attempt has to keep
    // showing why it is retrying, with the button busy, until the attempt lands.
    // It is dropped on success (and on disconnect / flag-off) below.
    setActiveAddress(address);

    (async () => {
      let newClient: XmtpClientInstance | null = null;
      try {
        // One Stellar-wallet signature the first time this account uses chat;
        // cached per account afterwards, so a remount does not re-prompt.
        const { signer, identity } = await createXmtpSignerForStellarAccount(
          address,
          (message) => signMessageRef.current(message),
        );
        if (myGen !== initGenRef.current) return;
        setInboxAddress(identity.address);

        const opts = getXmtpClientCreateOptions();
        const XMTP_INIT_TIMEOUT_MS = 15_000;
        const clientOptions = {
          env: opts.env as XmtpEnv,
          appVersion: opts.appVersion,
        } as Parameters<typeof Client.create>[1];
        const clientPromise = Client.create(signer, clientOptions);
        try {
          newClient = await Promise.race([
            clientPromise,
            createXmtpInitTimeout(XMTP_INIT_TIMEOUT_MS),
          ]);
        } catch (initializationError) {
          if (!isXmtpOpfsStorageError(initializationError)) {
            throw initializationError;
          }

          console.warn(
            "XMTP OPFS storage unavailable, retrying with in-memory storage.",
            initializationError
          );

          newClient = await Promise.race([
            Client.create(signer, {
              ...clientOptions,
              dbPath: null,
            } as Parameters<typeof Client.create>[1]),
            createXmtpInitTimeout(XMTP_INIT_TIMEOUT_MS),
          ]);
        }

        if (myGen !== initGenRef.current) {
          newClient.close();
          return;
        }

        if (clientRef.current && clientRef.current !== newClient) {
          try {
            clientRef.current.close();
          } catch {
            /* ignore */
          }
        }

        clientRef.current = newClient;
        setClient(newClient);
        setStatus("ready");
        setError(null);
        dropFailure();
      } catch (e) {
        if (myGen !== initGenRef.current) {
          newClient?.close();
          return;
        }
        newClient?.close();
        clientRef.current = null;
        setClient(null);
        setInboxAddress(null);
        const err =
          e instanceof Error ? e : new Error(String(e ?? "XMTP init failed"));
        setError(err);
        recordFailure(
          nextXmtpFailure(
            failureRef.current,
            classifyXmtpFailureKind(err, {
              status: "error",
              signerCode: e instanceof XmtpSignerError ? e.code : undefined,
            }),
            err.message
          )
        );
        setStatus("error");
      }
    })();

    return () => {
      initGenRef.current += 1;
      if (clientRef.current) {
        try {
          clientRef.current.close();
        } catch {
          /* ignore */
        }
        clientRef.current = null;
      }
      setClient(null);
    };
  }, [
    featureEnabled,
    isConnected,
    address,
    retryTrigger,
    tabId,
    recordFailure,
    dropFailure,
  ]);

  const value = useMemo<XmtpContextValue>(
    () => ({
      client,
      status,
      error,
      failure,
      activeAddress,
      inboxAddress,
      featureEnabled,
      retry,
    }),
    [
      client,
      status,
      error,
      failure,
      activeAddress,
      inboxAddress,
      featureEnabled,
      retry,
    ]
  );

  return <XmtpCtx.Provider value={value}>{children}</XmtpCtx.Provider>;
}

export function useXmtp(): XmtpContextValue {
  return useContext(XmtpCtx);
}
