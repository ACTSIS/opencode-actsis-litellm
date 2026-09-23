import { describe, it, expect, vi } from "vitest";
import {
  fetchCliAuthDiscovery,
  validateDiscovery,
  registerClient,
  exchangeAuthorizationCode,
  refreshGrant,
  revokeToken,
  fetchModels,
  fetchModelInfo,
  type CliAuthDiscovery,
} from "../src/client.ts";
import { AuthError, DiscoveryError } from "../src/errors.ts";

function makeDiscovery(overrides?: Partial<CliAuthDiscovery>): CliAuthDiscovery {
  return {
    contractVersion: 1,
    issuer: "https://gateway.example.com",
    authorizationEndpoint: "https://gateway.example.com/authorize",
    tokenEndpoint: "https://gateway.example.com/token",
    registrationEndpoint: "https://gateway.example.com/register",
    revocationEndpoint: "https://gateway.example.com/revoke",
    resource: "https://gateway.example.com",
    codeChallengeMethods: ["S256"],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethods: ["none"],
    ...overrides,
  };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("validateDiscovery", () => {
  it("returns a valid discovery document", () => {
    const raw = {
      contract_version: 1,
      issuer: "https://gateway.example.com",
      authorization_endpoint: "https://gateway.example.com/authorize",
      token_endpoint: "https://gateway.example.com/token",
      registration_endpoint: "https://gateway.example.com/register",
      revocation_endpoint: "https://gateway.example.com/revoke",
      resource: "https://gateway.example.com",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
    };

    const discovery = validateDiscovery(raw, "https://gateway.example.com");
    expect(discovery.contractVersion).toBe(1);
    expect(discovery.issuer).toBe("https://gateway.example.com");
  });

  it("rejects a non-object discovery response", () => {
    expect(() => validateDiscovery("bad", "https://gateway.example.com")).toThrow(
      DiscoveryError,
    );
  });

  it("rejects unsupported contract versions", () => {
    expect(() =>
      validateDiscovery({ contract_version: 2 }, "https://gateway.example.com"),
    ).toThrow("Unsupported CLI auth contract version");
  });

  it("rejects an issuer origin mismatch", () => {
    const raw = {
      contract_version: 1,
      issuer: "https://other.example.com",
      authorization_endpoint: "https://other.example.com/authorize",
      token_endpoint: "https://other.example.com/token",
      registration_endpoint: "https://other.example.com/register",
      revocation_endpoint: "https://other.example.com/revoke",
      resource: "https://other.example.com",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
    };
    expect(() => validateDiscovery(raw, "https://gateway.example.com")).toThrow(
      "issuer origin mismatch",
    );
  });

  it("allows scheme upgrade when base is https and issuer is same-host http", () => {
    const raw = {
      contract_version: 1,
      issuer: "http://gateway.example.com",
      authorization_endpoint: "http://gateway.example.com/authorize",
      token_endpoint: "http://gateway.example.com/token",
      registration_endpoint: "http://gateway.example.com/register",
      revocation_endpoint: "http://gateway.example.com/revoke",
      resource: "http://gateway.example.com",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
    };
    const discovery = validateDiscovery(raw, "https://gateway.example.com");
    expect(discovery.issuer).toBe("https://gateway.example.com");
    expect(discovery.tokenEndpoint).toBe("https://gateway.example.com/token");
  });

  it("rejects missing S256 challenge method", () => {
    const raw = {
      contract_version: 1,
      issuer: "https://gateway.example.com",
      authorization_endpoint: "https://gateway.example.com/authorize",
      token_endpoint: "https://gateway.example.com/token",
      registration_endpoint: "https://gateway.example.com/register",
      revocation_endpoint: "https://gateway.example.com/revoke",
      resource: "https://gateway.example.com",
      code_challenge_methods_supported: ["plain"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
    };
    expect(() => validateDiscovery(raw, "https://gateway.example.com")).toThrow(
      "PKCE S256",
    );
  });

  it("rejects missing authorization_code grant", () => {
    const raw = {
      contract_version: 1,
      issuer: "https://gateway.example.com",
      authorization_endpoint: "https://gateway.example.com/authorize",
      token_endpoint: "https://gateway.example.com/token",
      registration_endpoint: "https://gateway.example.com/register",
      revocation_endpoint: "https://gateway.example.com/revoke",
      resource: "https://gateway.example.com",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
    };
    expect(() => validateDiscovery(raw, "https://gateway.example.com")).toThrow(
      "authorization_code",
    );
  });
});

describe("fetchCliAuthDiscovery", () => {
  it("fetches and validates discovery", async () => {
    const body = {
      contract_version: 1,
      issuer: "https://gateway.example.com",
      authorization_endpoint: "https://gateway.example.com/authorize",
      token_endpoint: "https://gateway.example.com/token",
      registration_endpoint: "https://gateway.example.com/register",
      revocation_endpoint: "https://gateway.example.com/revoke",
      resource: "https://gateway.example.com",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
    };

    const fetchImpl = vi.fn().mockResolvedValue(okResponse(body));
    const discovery = await fetchCliAuthDiscovery(
      "https://gateway.example.com",
      5_000,
      undefined,
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gateway.example.com/.well-known/litellm-cli-auth",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(discovery.contractVersion).toBe(1);
  });
});

describe("registerClient", () => {
  it("returns the registered client", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        client_id: "client-123",
        redirect_uris: ["http://127.0.0.1:1234/callback"],
      }),
    );

    const result = await registerClient(
      makeDiscovery(),
      "http://127.0.0.1:1234/callback",
      5_000,
      fetchImpl,
    );

    expect(result.clientId).toBe("client-123");
    expect(result.redirectUris).toEqual(["http://127.0.0.1:1234/callback"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gateway.example.com/register",
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        body: expect.stringContaining("opencode-actsis-litellm"),
      }),
    );
  });

  it("rejects a redirect response", async () => {
    const response = new Response(null, {
      status: 302,
      headers: { Location: "https://evil.example.com" },
    });
    const fetchImpl = vi.fn().mockResolvedValue(response);

    await expect(
      registerClient(
        makeDiscovery(),
        "http://127.0.0.1:1234/callback",
        5_000,
        fetchImpl,
      ),
    ).rejects.toThrow(AuthError);
  });

  it("throws when client_id is missing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ redirect_uris: [] }));
    await expect(
      registerClient(makeDiscovery(), "http://127.0.0.1:1234/callback", 5_000, fetchImpl),
    ).rejects.toThrow("missing client_id");
  });
});

describe("exchangeAuthorizationCode", () => {
  it("returns token fields and user metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        access_token: "access-1",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "refresh-1",
        user_id: "user-1",
        team_id: "team-1",
      }),
    );

    const result = await exchangeAuthorizationCode(
      makeDiscovery(),
      {
        code: "code-1",
        redirectUri: "http://127.0.0.1:1234/callback",
        clientId: "client-1",
        codeVerifier: "verifier-1",
      },
      5_000,
      fetchImpl,
    );

    expect(result.accessToken).toBe("access-1");
    expect(result.refreshToken).toBe("refresh-1");
    expect(result.userId).toBe("user-1");
    expect(result.teamId).toBe("team-1");

    const [, init] = fetchImpl.mock.calls[0];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("resource")).toBe("https://gateway.example.com");
  });

  it("rejects a redirect response", async () => {
    const response = new Response(null, {
      status: 307,
      headers: { Location: "https://evil.example.com" },
    });
    const fetchImpl = vi.fn().mockResolvedValue(response);

    await expect(
      exchangeAuthorizationCode(
        makeDiscovery(),
        {
          code: "code-1",
          redirectUri: "http://127.0.0.1:1234/callback",
          clientId: "client-1",
          codeVerifier: "verifier-1",
        },
        5_000,
        fetchImpl,
      ),
    ).rejects.toThrow("redirected unexpectedly");
  });

  it("maps an error body into AuthError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      errorResponse(400, { error: "invalid_request", error_description: "bad code" }),
    );

    await expect(
      exchangeAuthorizationCode(
        makeDiscovery(),
        {
          code: "bad",
          redirectUri: "http://127.0.0.1:1234/callback",
          clientId: "client-1",
          codeVerifier: "verifier-1",
        },
        5_000,
        fetchImpl,
      ),
    ).rejects.toThrow("bad code");
  });

  it("throws when access_token is missing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ token_type: "Bearer" }));
    await expect(
      exchangeAuthorizationCode(
        makeDiscovery(),
        {
          code: "code-1",
          redirectUri: "http://127.0.0.1:1234/callback",
          clientId: "client-1",
          codeVerifier: "verifier-1",
        },
        5_000,
        fetchImpl,
      ),
    ).rejects.toThrow("missing access_token");
  });
});

describe("refreshGrant", () => {
  it("returns a rotated access token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        access_token: "access-2",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "refresh-2",
      }),
    );

    const result = await refreshGrant(
      makeDiscovery(),
      { refreshToken: "refresh-1", clientId: "client-1" },
      5_000,
      fetchImpl,
    );

    expect(result.accessToken).toBe("access-2");
    expect(result.refreshToken).toBe("refresh-2");
  });

  it("maps invalid_grant into actionable error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      errorResponse(400, { error: "invalid_grant" }),
    );

    await expect(
      refreshGrant(
        makeDiscovery(),
        { refreshToken: "refresh-1", clientId: "client-1" },
        5_000,
        fetchImpl,
      ),
    ).rejects.toThrow("Run /login again");
  });
});

describe("revokeToken", () => {
  it("returns true for ok responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const result = await revokeToken(
      makeDiscovery(),
      { token: "token-1", clientId: "client-1" },
      5_000,
      fetchImpl,
    );

    expect(result).toBe(true);
  });

  it("rejects a redirect response", async () => {
    const response = new Response(null, {
      status: 303,
      headers: { Location: "https://evil.example.com" },
    });
    const fetchImpl = vi.fn().mockResolvedValue(response);

    await expect(
      revokeToken(
        makeDiscovery(),
        { token: "token-1", clientId: "client-1" },
        5_000,
        fetchImpl,
      ),
    ).rejects.toThrow("redirected unexpectedly");
  });
});

describe("fetchModels", () => {
  it("returns parsed models response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ data: [{ id: "gpt-4o" }] }),
    );

    const result = await fetchModels(
      "https://gateway.example.com",
      "key-1",
      5_000,
      fetchImpl,
    );

    expect(result.baseUrl).toBe("https://gateway.example.com");
    expect((result.body as { data: { id: string }[] }).data[0].id).toBe("gpt-4o");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gateway.example.com/v1/models?include_metadata=true",
      expect.objectContaining({
        headers: { Authorization: "Bearer key-1" },
      }),
    );
  });

  it("maps 401/403 into AuthError", async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "unauthorized" }), { status }),
      );

      await expect(
        fetchModels("https://gateway.example.com", "key-1", 5_000, fetchImpl),
      ).rejects.toThrow("Credential rejected by gateway");
    }
  });
});

describe("fetchModelInfo", () => {
  it("requests the v1 enrichment endpoint", async () => {
    const baseUrl = "https://gateway.example.com";
    let requestedUrl = "";
    globalThis.fetch = async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    await fetchModelInfo(baseUrl, "key", 5000);
    expect(requestedUrl).toBe(`${baseUrl}/v1/model/info`);
  });
});
