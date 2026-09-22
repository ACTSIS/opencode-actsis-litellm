import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import {
  LoopbackCallbackServer,
  parseCallbackParams,
  runLoginFlow,
  type LoginConfig,
} from "../src/oauth.ts";
import { generatePkce } from "../src/pkce.ts";
import { type CliAuthDiscovery } from "../src/client.ts";
import { updatePluginState, type PluginState } from "../src/state.ts";

vi.mock("../src/state.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state.ts")>();
  return {
    ...actual,
    updatePluginState: vi.fn(async (patch: Partial<PluginState>, _dir?: string) => {
      return {
        version: 1,
        ...patch,
        savedAt: Date.now(),
      } as PluginState;
    }),
  };
});

const mockedUpdatePluginState = vi.mocked(updatePluginState);

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

describe("PKCE vectors", () => {
  it("produces a 43-character verifier and matching S256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBe(43);
    expect(challenge.length).toBe(43);

    const expectedChallenge = Buffer.from(
      new TextEncoder().encode(verifier),
    ).toString("base64url");
    expect(challenge).not.toBe(expectedChallenge);

    const crypto = require("node:crypto");
    const hash = crypto.createHash("sha256").update(verifier, "utf8").digest();
    const expected = hash.toString("base64url").replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });
});

describe("parseCallbackParams", () => {
  it("extracts code and state", () => {
    const params = parseCallbackParams(
      "http://127.0.0.1:1234/callback?code=abc&state=xyz",
    );
    expect(params.code).toBe("abc");
    expect(params.state).toBe("xyz");
  });

  it("extracts error and description", () => {
    const params = parseCallbackParams(
      "http://127.0.0.1:1234/callback?error=access_denied&error_description=user+denied",
    );
    expect(params.error).toBe("access_denied");
    expect(params.errorDescription).toBe("user denied");
  });
});

describe("LoopbackCallbackServer", () => {
  it("starts on 127.0.0.1 and serves /callback", async () => {
    const server = new LoopbackCallbackServer();
    const { port } = await server.start();
    expect(port).toBeGreaterThan(0);

    const wait = server.waitForCallback();

    const response = await fetch(
      `http://127.0.0.1:${port}/callback?code=ABC&state=STATE`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Signed in to LiteLLM");

    const callbackUrl = await wait;
    expect(callbackUrl).toContain("code=ABC");
    expect(callbackUrl).toContain("state=STATE");

    server.stop();
  });

  it("returns 404 for other paths", async () => {
    const server = new LoopbackCallbackServer();
    const { port } = await server.start();

    const response = await fetch(`http://127.0.0.1:${port}/other`, {
      method: "GET",
    });
    expect(response.status).toBe(404);

    server.stop();
  });

  it("rejects double start", async () => {
    const server = new LoopbackCallbackServer();
    await server.start();
    await expect(server.start()).rejects.toThrow("already started");
    server.stop();
  });
});

describe("runLoginFlow", () => {
  it("returns an OAuth result and succeeds after callback", async () => {
    const config: LoginConfig = { requestTimeoutMs: 5_000 };
    const discovery = makeDiscovery();

    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/register") {
        return new Response(JSON.stringify({ client_id: "client-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/token") {
        return new Response(
          JSON.stringify({
            access_token: "access-1",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-1",
            user_id: "user-1",
            team_id: "team-1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return globalThis.fetch(input, init);
    });

    const result = await runLoginFlow(config, discovery, undefined, fetchImpl);

    expect(result.method).toBe("auto");
    expect(result.url).toContain(discovery.authorizationEndpoint);
    expect(result.instructions).toContain("browser");
    expect(result.callback).toBeDefined();

    const url = new URL(result.url);
    const redirectUri = url.searchParams.get("redirect_uri")!;
    const state = url.searchParams.get("state")!;

    const callbackResponse = await fetch(
      `${redirectUri}?code=AUTHCODE&state=${state}`,
      { method: "POST" },
    );
    expect(callbackResponse.status).toBe(200);

    const loginResult = await result.callback();
    expect(loginResult.type).toBe("success");
    if (loginResult.type === "success") {
      expect(loginResult.access).toBe("access-1");
      expect(loginResult.refresh).toBe("refresh-1");
      expect(loginResult.userId).toBe("user-1");
      expect(loginResult.teamId).toBe("team-1");
      expect(loginResult.expires).toBeGreaterThan(Date.now());
    }

    mockedUpdatePluginState.mockClear();
  });

  it("handles state mismatch by returning failed", async () => {
    const config: LoginConfig = { requestTimeoutMs: 5_000 };
    const discovery = makeDiscovery();

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ client_id: "client-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await runLoginFlow(config, discovery, undefined, fetchImpl);
    const redirectUri = new URL(result.url).searchParams.get("redirect_uri")!;

    await fetch(`${redirectUri}?code=AUTHCODE&state=WRONG`, { method: "POST" });
    const loginResult = await result.callback();

    expect(loginResult.type).toBe("failed");
  });

  it("handles error param by returning failed", async () => {
    const config: LoginConfig = { requestTimeoutMs: 5_000 };
    const discovery = makeDiscovery();

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ client_id: "client-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await runLoginFlow(config, discovery, undefined, fetchImpl);
    const redirectUri = new URL(result.url).searchParams.get("redirect_uri")!;

    await fetch(
      `${redirectUri}?error=access_denied&error_description=denied`,
      { method: "POST" },
    );
    const loginResult = await result.callback();

    expect(loginResult.type).toBe("failed");
  });
});
