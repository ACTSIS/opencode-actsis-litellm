/**
 * Tests for the fetch-failure root-cause classifier (port of pi's
 * test/network-error.test.ts) plus the wiring at the plugin's gateway fetch
 * sites: opaque `TypeError: fetch failed` transport errors must surface with
 * their deep cause (DNS failure, connection refused, TLS trust, timeouts).
 */
import { describe, it, expect } from "vitest";
import { fetchFailureMessage } from "../src/network-error.ts";
import {
  fetchCliAuthDiscovery,
  fetchModels,
  refreshGrant,
} from "../src/client.ts";
import { fetchModelUsage } from "../src/usage.ts";
import { fetchGatewayBudget } from "../src/budget.ts";
import { CatalogError, AuthError, DiscoveryError } from "../src/errors.ts";

const BASE_URL = "https://gateway.example.com";

/** Real undici shape: opaque TypeError wrapping a coded cause Error. */
function undiciTypeError(code: string, message: string): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(message), { code }),
  });
}

function makeDomException(name: string, domCode: number, message: string) {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, { code: domCode });
  return err;
}

/** Awaits a promise expected to reject and returns the caught error. */
async function rejectionOf<T>(p: Promise<T>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("Expected promise to reject but it resolved");
}

describe("fetchFailureMessage", () => {
  it("returns a plain no-cause error message verbatim", () => {
    expect(fetchFailureMessage(new Error("network failure"))).toBe(
      "network failure",
    );
  });

  it("returns String(input) for non-Error input", () => {
    expect(fetchFailureMessage("boom")).toBe("boom");
    expect(fetchFailureMessage(42)).toBe("42");
    expect(fetchFailureMessage(null)).toBe("null");
  });

  it("reports DNS failure (ENOTFOUND) with hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError(
        "ENOTFOUND",
        "getaddrinfo ENOTFOUND gateway.example.com",
      ),
    );
    expect(msg).toContain("fetch failed");
    expect(msg).toContain("ENOTFOUND");
    expect(msg).toContain("getaddrinfo ENOTFOUND gateway.example.com");
    expect(msg).toContain("DNS/VPN");
  });

  it("reports EAI_AGAIN with the DNS hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("EAI_AGAIN", "getaddrinfo EAI_AGAIN gateway.example.com"),
    );
    expect(msg).toContain("EAI_AGAIN");
    expect(msg).toContain("could not be resolved");
  });

  it("reports ECONNREFUSED with hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:49999"),
    );
    expect(msg).toContain("ECONNREFUSED");
    expect(msg).toContain("connection was refused");
  });

  it("reports TLS trust failure (UNABLE_TO_GET_ISSUER_CERT_LOCALLY) with hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError(
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "unable to get local issuer certificate",
      ),
    );
    expect(msg).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    expect(msg).toContain("--use-system-ca");
    expect(msg).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("reports expired certificate (CERT_HAS_EXPIRED) with the TLS hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("CERT_HAS_EXPIRED", "certificate has expired"),
    );
    expect(msg).toContain("CERT_HAS_EXPIRED");
    expect(msg).toContain("TLS certificate is not trusted");
  });

  it("reports hostname mismatch (ERR_TLS_CERT_ALTNAME_INVALID) with the TLS hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError(
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "Hostname/IP does not match certificate's altnames",
      ),
    );
    expect(msg).toContain("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(msg).toContain("TLS certificate is not trusted");
  });

  it("reports ERR_SSL wildcard codes with the TLS hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("ERR_SSL_WRONG_VERSION_NUMBER", "wrong version number"),
    );
    expect(msg).toContain("ERR_SSL_WRONG_VERSION_NUMBER");
    expect(msg).toContain("TLS certificate is not trusted");
  });

  it("does not give the TLS hint for an unrelated code", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443"),
    );
    expect(msg).not.toContain("TLS certificate is not trusted");
  });

  it("reports ETIMEDOUT with the timeout hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1:443"),
    );
    expect(msg).toContain("ETIMEDOUT");
    expect(msg).toContain("timed out before the gateway responded");
  });

  it("reports UND_ERR_CONNECT_TIMEOUT with the timeout hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"),
    );
    expect(msg).toContain("UND_ERR_CONNECT_TIMEOUT");
    expect(msg).toContain("timed out before the gateway responded");
  });

  it("reports ECONNRESET with the reset hint", () => {
    const msg = fetchFailureMessage(
      undiciTypeError("ECONNRESET", "read ECONNRESET"),
    );
    expect(msg).toContain("ECONNRESET");
    expect(msg).toContain("reset by the peer");
  });

  it("reports a DOMException TimeoutError (code 23) with the timeout hint", () => {
    const err = makeDomException(
      "TimeoutError",
      23,
      "The operation was aborted due to timeout",
    );
    const msg = fetchFailureMessage(err);
    expect(msg).toContain("The operation was aborted due to timeout");
    expect(msg).toContain("(23:");
    expect(msg).toContain("timed out before the gateway responded");
  });

  it("does NOT treat an explicit abort (DOM code 20) as a timeout", () => {
    const err = makeDomException("AbortError", 20, "This operation was aborted");
    const msg = fetchFailureMessage(err);
    expect(msg).not.toContain("timed out before the gateway responded");
  });

  it("terminates on a cyclic cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;
    const msg = fetchFailureMessage(a);
    expect(msg).toContain("a");
    expect(msg).toContain("b");
  });

  it("does not go deeper than 5 cause links", () => {
    const leaf = Object.assign(new Error("leaf"), { code: "ECONNREFUSED" });
    let err: Error = leaf;
    for (let i = 0; i < 4; i++) {
      err = Object.assign(new Error(`layer-${i}`), { cause: err });
    }
    const msg = fetchFailureMessage(err);
    expect(msg).toContain("ECONNREFUSED");

    // Beyond the 5-link cap the coded leaf is no longer reachable; the
    // message must still be produced without hanging.
    let far: Error = leaf;
    for (let i = 0; i < 20; i++) {
      far = Object.assign(new Error(`deep-${i}`), { cause: far });
    }
    const farMsg = fetchFailureMessage(far);
    expect(typeof farMsg === "string" && farMsg.length > 0).toBe(true);
  });

  it("keeps the top-level message as a substring", () => {
    const err = undiciTypeError("ECONNREFUSED", "connect ECONNREFUSED");
    expect(fetchFailureMessage(err).startsWith("fetch failed")).toBe(true);
  });
});

describe("client network-error wiring", () => {
  it("fetchModels rejects with CatalogError naming the cause", async () => {
    const fetchImpl = async () => {
      throw undiciTypeError(
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "unable to get local issuer certificate",
      );
    };

    const err = await rejectionOf(fetchModels(BASE_URL, "sk-test", 5000, fetchImpl as typeof fetch));
    expect(err).toBeInstanceOf(CatalogError);
    expect((err as CatalogError).code).toBe("CATALOG_ERROR");
    expect(err.message).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    expect(err.message).toContain("--use-system-ca");
  });

  it("fetchCliAuthDiscovery rejects with DiscoveryError carrying the enriched message", async () => {
    const fetchImpl = async () => {
      throw undiciTypeError(
        "ENOTFOUND",
        "getaddrinfo ENOTFOUND host",
      );
    };

    const err = await rejectionOf(
      fetchCliAuthDiscovery(
        BASE_URL,
        5000,
        undefined,
        fetchImpl as typeof fetch,
      ),
    );
    expect(err).toBeInstanceOf(DiscoveryError);
    expect((err as DiscoveryError).code).toBe("DISCOVERY_ERROR");
    expect(err.message.startsWith("Failed to fetch CLI auth discovery:")).toBe(true);
    expect(err.message).toContain("ENOTFOUND");
  });

  it("preserves verbatim message for a plain no-cause network error", async () => {
    const fetchImpl = async () => {
      throw new Error("network failure");
    };
    await expect(
      fetchCliAuthDiscovery(BASE_URL, 5000, undefined, fetchImpl as typeof fetch),
    ).rejects.toThrow(/network failure/);
  });

  it("refreshGrant rejects with AuthError naming the cause", async () => {
    const discovery = {
      contractVersion: 1,
      issuer: BASE_URL,
      authorizationEndpoint: `${BASE_URL}/auth/authorize`,
      tokenEndpoint: `${BASE_URL}/auth/token`,
      registrationEndpoint: `${BASE_URL}/auth/register`,
      revocationEndpoint: `${BASE_URL}/auth/revoke`,
      resource: `${BASE_URL}/v1`,
      codeChallengeMethods: ["S256"],
      grantTypes: ["authorization_code", "refresh_token"],
      tokenEndpointAuthMethods: ["none"],
    };
    const fetchImpl = async () => {
      throw undiciTypeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:49999");
    };

    const err = await rejectionOf(
      refreshGrant(
        discovery,
        { refreshToken: "rt", clientId: "cid" },
        5000,
        fetchImpl as typeof fetch,
      ),
    );
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("AUTH_ERROR");
    expect(err.message).toContain("ECONNREFUSED");
    expect(err.message).toContain("connection was refused");
  });
});

describe("usage / budget network-error wiring", () => {
  it("fetchModelUsage rejects with a CatalogError naming the cause", async () => {
    const fetchImpl = async () => {
      throw undiciTypeError("ENOTFOUND", "getaddrinfo ENOTFOUND host");
    };
    const err = await rejectionOf(
      fetchModelUsage(
        "https://gw.example",
        "sk-x",
        5000,
        {},
        {},
        fetchImpl as typeof fetch,
      ),
    );
    expect(err).toBeInstanceOf(CatalogError);
    expect(err.message).toContain("ENOTFOUND");
    expect(err.message).toContain("DNS/VPN");
  });

  it("fetchGatewayBudget rejects with a CatalogError naming the cause", async () => {
    const fetchImpl = async () => {
      throw undiciTypeError("ECONNRESET", "read ECONNRESET");
    };
    const err = await rejectionOf(
      fetchGatewayBudget(
        "https://gw.example",
        "sk-x",
        5000,
        fetchImpl as typeof fetch,
      ),
    );
    expect(err).toBeInstanceOf(CatalogError);
    expect(err.message).toContain("ECONNRESET");
    expect(err.message).toContain("reset by the peer");
  });
});