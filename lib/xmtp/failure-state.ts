/**
 * Estados de fallo y reintento de XMTP (UI de fallo + feedback de reintento).
 *
 * Sin dependencia de `@xmtp/browser-sdk` (mismo criterio que
 * `vs-chat-eligibility.ts`): seguro para tests de node e imports ligeros de servidor.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * Antes, cada capa hacia su propio manejo de errores: el provider volcaba el
 * `Error` crudo del SDK en pantalla (puede contener el InboxID, que es un
 * identificador estable y no debe mostrarse como titular), el panel volcaba el
 * error crudo de `sendText` bajo el input, y el fallo del stream solo llegaba a
 * `console.warn` — el hilo se quedaba congelado sin ningún aviso. `blocked_by_tab`
 * no tenía botón de reintento y su copy prometía una reconexión automática que
 * solo ocurre si la otra pestaña emite el evento de cierre.
 *
 * Este módulo es la única fuente de verdad de *qué* falló y *qué se puede hacer al
 * respecto*: una clasificación pura de `kind` más la política de reintento. La capa
 * React solo traduce `kind` a i18n y dibuja el botón.
 *
 * ── Límites de seguridad (no negociables) ────────────────────────────────────
 *
 * - El detalle técnico **nunca** es el titular de la UI: va a un `<details>` de
 *   soporte. El texto crudo del SDK puede filtrar el InboxID o rutas OPFS.
 * - Un reintento desatendido solo existe para fallos *transitorios*. Nada que
 *   implique volver a abrir el diálogo de firma de la wallet se reintenta solo:
 *   `signature_declined` es una decisión del usuario, no una avería.
 * - Ningún camino toca dinero, permisos ni contrato. Esto es transporte de
 *   mensajes; el libro mayor sigue siendo la cadena.
 */

import { isXmtpInstallationsLimitError } from "@/lib/xmtp/installation-limit-error";

/** Sentinel que `ensureVsDmThread` lanza cuando el rival aún no está en XMTP. */
const PEER_UNREACHABLE_SENTINEL = "XMTP_PEER_UNREACHABLE";

/** Códigos de `XmtpSignerError` (`lib/xmtp/signer.ts`), leídos por duck-typing. */
const SIGNER_REJECTED_CODES = new Set(["rejected"]);
const SIGNER_UNSUPPORTED_CODES = new Set(["unsupported_wallet"]);
const SIGNER_INVALID_CODES = new Set(["invalid_address", "invalid_signature"]);

const TIMEOUT_PATTERN = /\btime(?:d)?[ _-]?out\b/i;
const NETWORK_PATTERN =
  /failed to fetch|network|econnreset|enotfound|socket hang up|offline|load failed/i;
const RATE_LIMIT_PATTERN = /429|rate limit|too many requests/i;

export type XmtpFailureKind =
  /** El usuario rechazó (o cerró) la firma de derivación de identidad. */
  | "signature_declined"
  /** La wallet conectada no puede firmar mensajes off-chain. */
  | "unsupported_wallet"
  /** Identidad derivada mal formada — no se arregla reintentando. */
  | "invalid_identity"
  /** Tope de instalaciones del inbox alcanzado; requiere acción fuera de la app. */
  | "installations_limit"
  /** Otra pestaña tiene el lock de OPFS. */
  | "blocked_by_tab"
  /** El rival todavía no derivó su inbox XMTP. */
  | "peer_unreachable"
  | "rate_limit"
  | "network"
  | "timeout"
  /** El stream de mensajes se cayó con el hilo ya abierto. */
  | "stream_lost"
  /** `sendText` falló; el texto sigue en el draft del usuario. */
  | "send_failed"
  | "unknown";

export type XmtpFailure = {
  kind: XmtpFailureKind;
  /** Fallos consecutivos de este mismo `kind`; 1 en el primero. */
  attempt: number;
  /** Reintentar puede funcionar sin cambiar nada más. */
  retryable: boolean;
  /** El reintento desatendido es seguro: nunca reabre un diálogo de wallet. */
  autoRetryable: boolean;
  /** El usuario tiene que cambiar algo fuera de la app antes de reintentar. */
  needsExternalFix: boolean;
  /** `attempt` alcanzó el umbral de escalado: hace falta una acción distinta. */
  escalated: boolean;
  /**
   * Texto crudo del SDK / wallet. Solo logs y soporte — nunca el titular de la UI:
   * puede contener el InboxID (identificador estable) o rutas OPFS.
   */
  technical: string;
};

/** Intentos consecutivos a partir de los cuales la copia pide una acción distinta. */
export const XMTP_FAILURE_ESCALATION_ATTEMPT = 3;

/** Reintentos desatendidos, como máximo, por fallo. */
export const XMTP_MAX_AUTO_RETRIES = 2;

/**
 * Backoff de reintento desatendido. El índice es el intento ya fallido (1-based).
 * `null` significa: no reintentar solo; esperar al usuario.
 */
export const XMTP_RETRY_DELAYS_MS: readonly number[] = [1_500, 6_000, 20_000];

const RETRYABLE_KINDS = new Set<XmtpFailureKind>([
  "signature_declined",
  "installations_limit",
  "blocked_by_tab",
  "peer_unreachable",
  "rate_limit",
  "network",
  "timeout",
  "stream_lost",
  "send_failed",
  "unknown",
]);

const AUTO_RETRYABLE_KINDS = new Set<XmtpFailureKind>([
  "blocked_by_tab",
  "rate_limit",
  "network",
  "timeout",
  "stream_lost",
]);

const EXTERNAL_FIX_KINDS = new Set<XmtpFailureKind>([
  "installations_limit",
  "blocked_by_tab",
  "peer_unreachable",
  "unsupported_wallet",
]);

/** Claves de `messages/en.json` → `xmtpVs` que describen cada fallo. */
export type XmtpFailureMessageKey =
  | "peerUnreachable"
  | "rateLimited"
  | "errorGeneric"
  | "failureSignatureDeclined"
  | "failureUnsupportedWallet"
  | "failureInvalidIdentity"
  | "failureInstallationsLimit"
  | "failureBlockedByTab"
  | "failureNetwork"
  | "failureTimeout"
  | "failureStreamLost"
  | "failureSendFailed";

const MESSAGE_KEYS: Record<XmtpFailureKind, XmtpFailureMessageKey> = {
  signature_declined: "failureSignatureDeclined",
  unsupported_wallet: "failureUnsupportedWallet",
  invalid_identity: "failureInvalidIdentity",
  installations_limit: "failureInstallationsLimit",
  blocked_by_tab: "failureBlockedByTab",
  peer_unreachable: "peerUnreachable",
  rate_limit: "rateLimited",
  network: "failureNetwork",
  timeout: "failureTimeout",
  stream_lost: "failureStreamLost",
  send_failed: "failureSendFailed",
  unknown: "errorGeneric",
};

/** Copy localizada de un fallo. La UI no decide esto inline. */
export function xmtpFailureMessageKey(
  kind: XmtpFailureKind
): XmtpFailureMessageKey {
  return MESSAGE_KEYS[kind];
}

export type XmtpFailureStatusHint =
  | "initializing"
  | "error"
  | "blocked_by_tab"
  | "ready";

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return String(error);
}

function readErrorCode(error: unknown): string {
  if (error == null || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/**
 * Clasifica cualquier fallo de XMTP en un `kind` accionable.
 *
 * `signerCode` se pasa explícitamente (en vez de leer `error.code` a ciegas) para
 * que el provider distinga un `XmtpSignerError` de un error del SDK que comparta
 * ese campo; el duck-typing se queda solo para leer el mensaje.
 */
export function classifyXmtpFailureKind(
  error: unknown,
  opts: { status?: XmtpFailureStatusHint; signerCode?: string } = {}
): XmtpFailureKind {
  if (opts.status === "blocked_by_tab") return "blocked_by_tab";

  const code = opts.signerCode ?? readErrorCode(error);
  if (SIGNER_REJECTED_CODES.has(code)) return "signature_declined";
  if (SIGNER_UNSUPPORTED_CODES.has(code)) return "unsupported_wallet";
  if (SIGNER_INVALID_CODES.has(code)) return "invalid_identity";

  const message = readErrorMessage(error).trim();
  if (!message) return "unknown";
  if (message === PEER_UNREACHABLE_SENTINEL) return "peer_unreachable";
  if (isXmtpInstallationsLimitError(message)) return "installations_limit";
  if (RATE_LIMIT_PATTERN.test(message)) return "rate_limit";
  if (TIMEOUT_PATTERN.test(message)) return "timeout";
  if (NETWORK_PATTERN.test(message)) return "network";
  return "unknown";
}

/**
 * Registra un fallo, encadenando el intento con el anterior **solo si es del mismo
 * `kind`**. Un fallo distinto (o un success, vía `clearXmtpFailure`) reinicia el
 * contador: así un `timeout` viejo seguido de un `rate_limit` no se presenta como
 * el quinto intento de algo que nadie ha reintentado.
 */
export function nextXmtpFailure(
  previous: XmtpFailure | null,
  kind: XmtpFailureKind,
  technical: string
): XmtpFailure {
  const attempt = previous && previous.kind === kind ? previous.attempt + 1 : 1;
  return {
    kind,
    attempt,
    retryable: RETRYABLE_KINDS.has(kind),
    autoRetryable: AUTO_RETRYABLE_KINDS.has(kind),
    needsExternalFix: EXTERNAL_FIX_KINDS.has(kind),
    escalated: attempt >= XMTP_FAILURE_ESCALATION_ATTEMPT,
    technical,
  };
}

/** Cierre explícito del estado de fallo: el próximo fallo vuelve a intento 1. */
export function clearXmtpFailure(): null {
  return null;
}

/**
 * Espera antes del siguiente reintento desatendido, o `null` si no debe haber uno.
 *
 * `attempt` viene ya en el fallo registrado (1-based). Se corta en
 * `XMTP_MAX_AUTO_RETRIES` para que un fallo persistente no se reintente para
 * siempre por debajo de la pantalla, y devuelve `null` para cualquier `kind` que no
 * sea seguro auto-reintentar — sobre todo `signature_declined`, que reabriría el
 * diálogo de la wallet sin que nadie lo pidiera.
 */
export function xmtpAutoRetryDelayMs(
  failure: XmtpFailure | null
): number | null {
  if (!failure) return null;
  if (!failure.autoRetryable) return null;
  if (failure.attempt > XMTP_MAX_AUTO_RETRIES) return null;
  const delay = XMTP_RETRY_DELAYS_MS[failure.attempt - 1];
  return delay ?? null;
}

/**
 * El botón de reintento está deshabilitado si no hay nada que reintentar, si el
 * fallo no es recuperable, o si ya hay un intento en vuelo. Un reintento en vuelo
 * se cancelaría a mitad de `Client.create`, así que la UI lo serializa en vez de
 * exponer un botón que se puede pulsar dos veces.
 */
export function isXmtpRetryDisabled(
  failure: XmtpFailure | null,
  isRetrying: boolean
): boolean {
  if (!failure) return true;
  if (isRetrying) return true;
  return !failure.retryable;
}

/** ¿El fallo lleva ya demasiados intentos como para que "Retry" sea la respuesta? */
export function shouldEscalateXmtpFailure(
  failure: XmtpFailure | null
): boolean {
  return failure?.escalated ?? false;
}
