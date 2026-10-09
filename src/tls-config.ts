/**
 * Frictionless TLS bootstrap for enterprise gateways whose HTTPS certificates
 * are issued by a private (internal) CA installed in the OS trust store.
 *
 * Node.js ships a fixed snapshot of Mozilla's root CAs and ignores the OS
 * certificate store unless explicitly told otherwise, so a gateway signed by
 * an internal CA fails TLS validation inside the plugin's login and chat
 * flows even though browsers and the OS itself trust it ("certificate
 * installed on Windows" is not enough for Node).
 *
 * This module unions Node's bundled CAs with whatever the OS system store
 * exposes and installs the merged set as the process-wide default. It is
 * strictly additive (bundled CAs always stay), idempotent per session,
 * fail-open (any TLS API failure leaves the process untouched), and can be
 * disabled with ACTSIS_LITELLM_NO_SYSTEM_CA=1.
 *
 * Runtime requirements: node:tls getCACertificates + setDefaultCACertificates
 * (v22.19.0+ for the 'system' source). On older runtimes this reports
 * `unsupported` and the plugin keeps working exactly as before. When a TLS
 * trust failure still happens at request time, `tlsTrustRemediationMessage`
 * returns the per-platform remediation steps for the reported error.
 */

export type SystemCaOutcomeKind =
  | "configured"
  | "already-configured"
  | "unsupported"
  | "disabled"
  | "empty-system"
  | "failed";

export interface SystemCaOutcome {
  kind: SystemCaOutcomeKind;
  /** Certificates added by the system store on top of the bundled set. */
  addedCertificates?: number;
  /** populated for kind="failed"/"unsupported": why no merge happened. */
  reason?: string;
}

/**
 * Opt-out env for the system-CA merge. Value is treated as opt-out when it is
 * "1"/"true"/"yes" (case-insensitive) — matching the other ACTSIS_LITELLM_*
 * flags in the README.
 */
export const SYSTEM_CA_OPT_OUT_ENV = "ACTSIS_LITELLM_NO_SYSTEM_CA";

interface MinimalTls {
  getCACertificates(type: "system" | "bundled" | "extra" | "default"): string[];
  setDefaultCACertificates(certs: string[]): void;
}

export interface ConfigureSystemCaOptions {
  /** Idempotency key; repeats report already-configured without re-merging. */
  onceKey?: string;
  /** Opt-out env value; see parseOptOutEnv for the accepted truthy values. */
  optOutEnv?: string;
  /** Test hook: overrides the real node:tls module. */
  tlsOverride?: MinimalTls;
}

const ONE_SHOT_ATTEMPTS = new Set<string>();

/** Normalizes a PEM block for comparison (collapses whitespace variants). */
function normalizePem(cert: string): string {
  return cert.replace(/\r/g, "").replace(/\s+/g, "\n").trim();
}

export function parseOptOutEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

export function unionCertificates(
  primary: string[],
  secondary: string[],
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const cert of [...primary, ...secondary]) {
    const key = normalizePem(cert);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cert);
  }
  return merged;
}

// Comparison helper: normalized PEM identity set (bounded, few hundred CAs).
function normalizedSet(certs: string[]): Set<string> {
  const set = new Set<string>();
  for (const cert of certs) set.add(normalizePem(cert));
  return set;
}

async function loadTls(): Promise<MinimalTls> {
  const mod = (await import("node:tls")) as unknown as {
    getCACertificates?: MinimalTls["getCACertificates"];
    setDefaultCACertificates?: MinimalTls["setDefaultCACertificates"];
  };
  if (
    typeof mod.getCACertificates !== "function" ||
    typeof mod.setDefaultCACertificates !== "function"
  ) {
    throw new Error("runtime lacks node:tls CA management APIs");
  }
  return mod as MinimalTls;
}

export async function configureSystemCa(
  options: ConfigureSystemCaOptions = {},
): Promise<SystemCaOutcome> {
  const onceKey = options.onceKey ?? "default";
  if (parseOptOutEnv(options.optOutEnv)) {
    return { kind: "disabled" };
  }
  if (ONE_SHOT_ATTEMPTS.has(onceKey)) {
    return { kind: "already-configured" };
  }
  ONE_SHOT_ATTEMPTS.add(onceKey);

  let tlsApi: MinimalTls;
  try {
    tlsApi = options.tlsOverride ?? (await loadTls());
  } catch (err) {
    return {
      kind: "unsupported",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const bundled = tlsApi.getCACertificates("bundled");
    let system: string[];
    try {
      system = tlsApi.getCACertificates("system");
    } catch (err) {
      // The API exists but the platform store read failed (OpenSSL/OS error):
      // this is a runtime failure, not an unsupported runtime. Fail open.
      return {
        kind: "failed",
        reason:
          err instanceof Error
            ? `node:tls rejected the "system" source: ${err.message}`
            : String(err),
      };
    }

    const bundledSet = normalizedSet(bundled);
    const systemSet = normalizedSet(system);
    const added = [...systemSet].filter((c) => !bundledSet.has(c));
    if (added.length === 0) {
      return { kind: "empty-system", addedCertificates: 0 };
    }

    const merged = unionCertificates(bundled, system);
    tlsApi.setDefaultCACertificates(merged);
    return { kind: "configured", addedCertificates: added.length };
  } catch (err) {
    return {
      kind: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// TLS trust failure classification + remediation message port
// ---------------------------------------------------------------------------

/**
 * OpenSSL/Node error codes that signal the gateway's TLS certificate was not
 * trusted, plus any `ERR_SSL_*` code. Order mirrors the pi remediator's
 * decision tree; only the first matching hint is ever appended to a message.
 */
const TLS_TRUST_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_SIGNATURE_FAILURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function isTlsTrustIssueCode(code: string | undefined): boolean {
  if (code === undefined) return false;
  return TLS_TRUST_ERROR_CODES.has(code) || code.startsWith("ERR_SSL");
}

/**
 * Single-line remediation message for a TLS trust failure, ported verbatim
 * from the pi remediator: the fix is per platform (Windows `setx
 * NODE_USE_SYSTEM_CA 1` or a PEM conversion for NODE_EXTRA_CA_CERTS; Linux
 * `--use-openssl-ca` / `SSL_CERT_FILE`), and the bootstrap stays opt-out-able
 * via ACTSIS_LITELLM_NO_SYSTEM_CA. Returns null when the code is not a TLS
 * trust failure (the caller should append nothing).
 */
export function tlsTrustRemediationMessage(
  code: string | undefined,
): string | null {
  if (!isTlsTrustIssueCode(code)) return null;
  return "the gateway's TLS certificate is not trusted by Node (Node ignores the OS certificate store by default). This plugin auto-loads OS system CAs at startup (--use-system-ca equivalent); to opt out set ACTSIS_LITELLM_NO_SYSTEM_CA=1. If trust still fails: on Windows run `setx NODE_USE_SYSTEM_CA 1` (Node \u2265 22.19.0, CA present in certmgr.msc) or export the CA to PEM (`certutil -encode ca.cer ca.pem`) and set NODE_EXTRA_CA_CERTS to it; on Linux use --use-openssl-ca / SSL_CERT_FILE.";
}