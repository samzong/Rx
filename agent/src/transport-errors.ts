import { constants } from "node:os";
import type { Api, SimpleStreamOptions } from "@earendil-works/pi-ai";

const FETCH_APIS = new Set<Api>([
  "openai-completions", "openai-responses", "azure-openai-responses",
  "openai-codex-responses", "anthropic-messages", "mistral-conversations", "pi-messages",
]);
const ERROR_CODES = new Set([
  ...Object.keys(constants.errno),
  "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA",
  "ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket", "ConnectionTimedOut",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_ABORTED", "UND_ERR_DESTROYED", "UND_ERR_CLOSED",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
  "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
]);
const ERROR_NAMES = new Set(["Error", "TypeError", "SystemError", "AggregateError", "AbortError", "TimeoutError"]);
const SYSCALLS = new Set(["connect", "getaddrinfo", "getnameinfo", "read", "write", "recv", "send", "recvfrom", "sendto", "shutdown", "socket"]);

function transportCause(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const causes: string[] = [];
  while (pending.length && seen.size < 8) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const value = current as Record<string, unknown>;
    const fields: string[] = [];
    if (typeof value.name === "string" && ERROR_NAMES.has(value.name)) fields.push(value.name);
    if (typeof value.code === "string" && ERROR_CODES.has(value.code)) fields.push(`code=${value.code}`);
    if (typeof value.errno === "number" && value.errno !== 0 && Number.isSafeInteger(value.errno)) fields.push(`errno=${value.errno}`);
    if (typeof value.syscall === "string" && SYSCALLS.has(value.syscall)) fields.push(`syscall=${value.syscall}`);
    if (fields.length) causes.push(fields.join(" "));
    pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 8));
  }
  return causes.join("; ") || "cause unavailable";
}

export function transportDiagnostics(): {
  streamOptions: (api: Api, options: SimpleStreamOptions | undefined) => SimpleStreamOptions | undefined;
  takeFailure: () => string | undefined;
} {
  let failure: string | undefined;
  let requestFetch: typeof globalThis.fetch | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    failure = undefined;
    try {
      return await (requestFetch ?? globalThis.fetch)(input, init);
    } catch (error) {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (!signal?.aborted) failure = `Model connection failed: ${transportCause(error)}`;
      throw error;
    }
  };
  return {
    streamOptions: (api, options) => {
      failure = undefined;
      requestFetch = options?.fetch;
      return FETCH_APIS.has(api) ? { ...options, fetch } : options;
    },
    takeFailure: () => {
      const previous = failure;
      failure = undefined;
      return previous;
    },
  };
}
