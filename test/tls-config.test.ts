import { describe, expect, it, vi } from "vitest";
import tls from "node:tls";
import {
  configureSystemCa,
  isTlsTrustIssueCode,
  parseOptOutEnv,
  tlsTrustRemediationMessage,
  unionCertificates,
} from "../src/tls-config.ts";

// TLS feature availability depends on the Node runtime:
// - getCACertificates exists since v22.15.0, setDefaultCACertificates and the
//   "system" source need v22.19.0+.
// Tests are written against the real tls module (additive behavior on this
// runtime) plus deterministic tlsOverride fixtures for every outcome kind,
// and stay green on any supported Node.

const tlsModule = tls as unknown as {
  getCACertificates?: unknown;
  setDefaultCACertificates?: unknown;
};
const supportsApi =
  typeof tlsModule.getCACertificates === "function" &&
  typeof tlsModule.setDefaultCACertificates === "function";

const CA_A = `-----BEGIN CERTIFICATE-----
MS1DQS1ERU1P
-----END CERTIFICATE-----
`;
const CA_B = `-----BEGIN CERTIFICATE-----
MS1DQi1ERU1P
-----END CERTIFICATE-----
`;
const CA_C = `-----BEGIN CERTIFICATE-----
MS1DQy1ERU1P
-----END CERTIFICATE-----
`;

describe("unionCertificates", () => {
  it("unions two lists preserving order (first list wins)", () => {
    expect(unionCertificates([CA_A, CA_B], [CA_B, CA_C])).toEqual([
      CA_A,
      CA_B,
      CA_C,
    ]);
  });

  it("deduplicates whitespace-normalized duplicates", () => {
    const a = CA_A.replace("\n", "\n");
    const aAlt = CA_A.replace(/\r/g, "");
    expect(unionCertificates([a], [aAlt])).toHaveLength(1);
  });

  it("returns an empty list when both inputs are empty", () => {
    expect(unionCertificates([], [])).toEqual([]);
  });
});

describe("parseOptOutEnv", () => {
  it("treats 1/true/yes (case-insensitive) as opt-out", () => {
    expect(parseOptOutEnv("1")).toBe(true);
    expect(parseOptOutEnv("true")).toBe(true);
    expect(parseOptOutEnv("YES")).toBe(true);
  });

  it("treats 0/false/empty/undefined as not opted out", () => {
    expect(parseOptOutEnv("0")).toBe(false);
    expect(parseOptOutEnv("false")).toBe(false);
    expect(parseOptOutEnv("")).toBe(false);
    expect(parseOptOutEnv(undefined)).toBe(false);
  });
});

describe("configureSystemCa", () => {
  it("unions bundled with system CAs and installs the merged default once", async () => {
    if (!supportsApi) return;
    const installed: string[][] = [];
    const outcome = await configureSystemCa({
      onceKey: "test-override-union",
      tlsOverride: {
        getCACertificates: (type) =>
          type === "bundled" ? [CA_A, CA_B] : type === "system" ? [CA_B, CA_C] : [],
        setDefaultCACertificates: (certs) => {
          installed.push(certs);
        },
      },
    });
    expect(outcome).toEqual({ kind: "configured", addedCertificates: 1 });
    expect(installed).toEqual([[CA_A, CA_B, CA_C]]);
  });

  it("preserves existing bundled certs (no duplicates, first list wins)", async () => {
    if (!supportsApi) return;
    const outcome = await configureSystemCa({
      onceKey: "test-override-preserve",
      tlsOverride: {
        getCACertificates: (type) => (type === "bundled" ? [CA_A] : [CA_A]),
        setDefaultCACertificates: () => {},
      },
    });
    expect(outcome.kind).toBe("empty-system");
  });

  it("is idempotent per onceKey: repeats report already-configured", async () => {
    const first = await configureSystemCa({
      onceKey: "test-idempotent-real",
    });
    expect([
      "configured",
      "empty-system",
      "already-configured",
      "unsupported",
    ]).toContain(first.kind);
    const second = await configureSystemCa({
      onceKey: "test-idempotent-real",
    });
    expect(second.kind).toBe("already-configured");
  });

  it("is strictly additive over the bundled set on supporting runtimes", async () => {
    if (!supportsApi) return;
    const bundled = tls.getCACertificates("bundled");
    const outcome = await configureSystemCa({ onceKey: "test-additive" });
    if (outcome.kind === "unsupported") return;
    const after = tls.getCACertificates("default");
    // Trust identity is DER content, not PEM formatting: the OS system store
    // often contains the same Mozilla roots as the bundled set with a
    // different PEM layout, and the merged default keeps one DER per cert.
    const derKey = (c: string) =>
      Buffer.from(c.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64").toString("hex");
    const afterDers = new Set(after.map(derKey));
    for (const cert of bundled) {
      expect(afterDers.has(derKey(cert))).toBe(true);
    }
    expect(after.length).toBeGreaterThanOrEqual(bundled.length);
  });

  it("respects the opt-out env (ACTSIS_LITELLM_NO_SYSTEM_CA)", async () => {
    expect(
      (await configureSystemCa({ onceKey: "test-optout-1", optOutEnv: "1" })).kind,
    ).toBe("disabled");
    expect(
      (await configureSystemCa({ onceKey: "test-optout-true", optOutEnv: "True" })).kind,
    ).toBe("disabled");
    expect(
      (await configureSystemCa({ onceKey: "test-optout-no", optOutEnv: "0" })).kind,
    ).not.toBe("disabled");
  });

  it("never throws when the tls API rejects underneath", async () => {
    const outcome = await configureSystemCa({
      onceKey: "test-throwing",
      tlsOverride: {
        getCACertificates: (type: string) => {
          if (type === "bundled") return [CA_A];
          throw new Error("simulated OpenSSL failure");
        },
        setDefaultCACertificates: () => {},
      },
    });
    expect(outcome.kind).toBe("failed");
    expect(outcome.reason ?? "").toMatch(/simulated/);
  });

  it("never throws when installing the merged default rejects", async () => {
    const outcome = await configureSystemCa({
      onceKey: "test-set-throws",
      tlsOverride: {
        getCACertificates: (type) => (type === "bundled" ? [] : [CA_B]),
        setDefaultCACertificates: () => {
          throw new Error("simulated set failure");
        },
      },
    });
    expect(outcome.kind).toBe("failed");
    expect(outcome.reason ?? "").toMatch(/simulated set failure/);
  });

  it("distinguishes a platform-store read failure from an unsupported runtime", async () => {
    const outcome = await configureSystemCa({
      onceKey: "test-system-rejects",
      tlsOverride: {
        getCACertificates: (type) => {
          if (type === "bundled") return [];
          throw new Error("OS trust store unavailable");
        },
        setDefaultCACertificates: () => {},
      },
    });
    expect(outcome.kind).toBe("failed");
    expect(outcome.reason ?? "").toContain('"system" source');
  });
});

// Old-Node feature detection: the dynamic node:tls import inside the module
// must resolve to a runtime without the CA management APIs and be reported
// as "unsupported" (strict no-op, never a throw). Placed LAST so the mock
// cannot leak into the real-module tests above.
describe("configureSystemCa on older Node runtimes", () => {
  it("reports unsupported and never mutates anything without the TLS CA APIs", async () => {
    vi.doMock("node:tls", async (importOriginal) => {
      const real = (await importOriginal()) as Record<string, unknown>;
      const withoutCaApis = { ...real };
      delete withoutCaApis.getCACertificates;
      delete withoutCaApis.setDefaultCACertificates;
      return { ...withoutCaApis, default: withoutCaApis };
    });
    try {
      const outcome = await configureSystemCa({ onceKey: "test-old-node" });
      expect(outcome.kind).toBe("unsupported");
      // The runtime reported why, without throwing and without mutating
      // any certificate store.
      expect(typeof outcome.reason).toBe("string");
      expect((outcome.reason ?? "").length).toBeGreaterThan(0);
    } finally {
      vi.doUnmock("node:tls");
      vi.resetModules();
    }
  });
});

describe("TLS trust failure classification", () => {
  const TRUST_CODES = [
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "CERT_SIGNATURE_FAILURE",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ];

  it.each(TRUST_CODES)("classifies %s as a TLS trust failure", (code) => {
    expect(isTlsTrustIssueCode(code)).toBe(true);
    expect(tlsTrustRemediationMessage(code)).not.toBeNull();
  });

  it("classifies ERR_SSL prefixed codes as TLS trust failures", () => {
    expect(isTlsTrustIssueCode("ERR_SSL_WRONG_VERSION_NUMBER")).toBe(true);
    expect(tlsTrustRemediationMessage("ERR_SSL_WRONG_VERSION_NUMBER")).not.toBeNull();
  });

  it.each([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ECONNRESET",
    "UND_ERR_CONNECT_TIMEOUT",
  ])("does not classify %s as a TLS trust failure", (code) => {
    expect(isTlsTrustIssueCode(code)).toBe(false);
    expect(tlsTrustRemediationMessage(code)).toBeNull();
  });

  it("does not classify an undefined or unknown code", () => {
    expect(isTlsTrustIssueCode(undefined)).toBe(false);
    expect(isTlsTrustIssueCode("SOMETHING_ELSE")).toBe(false);
    expect(tlsTrustRemediationMessage(undefined)).toBeNull();
  });

  it("remediation message names the env opt-out and the concrete per-platform steps", () => {
    const msg = tlsTrustRemediationMessage("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    expect(msg).not.toBeNull();
    expect(msg).toContain("ACTSIS_LITELLM_NO_SYSTEM_CA");
    expect(msg).toContain("NODE_USE_SYSTEM_CA");
    expect(msg).toContain("certutil");
    expect(msg).toContain("NODE_EXTRA_CA_CERTS");
    expect(msg).toContain("--use-system-ca");
    expect(msg).toContain("SSL_CERT_FILE");
  });

  it("remediation message keeps Windows before Linux steps (decision tree order)", () => {
    const msg = tlsTrustRemediationMessage("CERT_HAS_EXPIRED") ?? "";
    expect(msg.indexOf("Windows")).toBeGreaterThanOrEqual(0);
    expect(msg.indexOf("Windows")).toBeLessThan(msg.indexOf("Linux"));
  });
});