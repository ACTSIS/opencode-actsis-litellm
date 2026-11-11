import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  extractCredentialTeamId,
  fetchGatewayIdentity,
  fetchTeamAlias,
  formatTeamLine,
  formatUserLine,
  type GatewayIdentity,
  type IdentityState,
} from "../src/identity.ts";
import { AuthError, CatalogError } from "../src/errors.ts";

const TEAM_ID = "ad59169e-f0c9-45a3-aa73-eec187533bdf";
const USER_ID = "2ed0da75-556d-4c8f-99da-727d7e085fd4";

function identity(overrides: Partial<GatewayIdentity> = {}): GatewayIdentity {
  return {
    userId: null,
    userEmail: null,
    userAlias: null,
    userRole: null,
    teams: [],
    ...overrides,
  };
}

function ok(identityValue: Partial<GatewayIdentity>): IdentityState {
  return { kind: "ok", identity: identity(identityValue) };
}

describe("identity formatUserLine (S1)", () => {
  it("formats email, alias and role", () => {
    expect(
      formatUserLine(ok({
        userEmail: "ricardo.pinto@actsis.com",
        userAlias: "RPINTO",
        userRole: "proxy_admin",
      })),
    ).toBe("User: ricardo.pinto@actsis.com (RPINTO, proxy_admin)");
  });

  it("formats email and alias without role", () => {
    expect(
      formatUserLine(ok({
        userEmail: "ricardo.pinto@actsis.com",
        userAlias: "RPINTO",
      })),
    ).toBe("User: ricardo.pinto@actsis.com (RPINTO)");
  });

  it("formats email and role without alias", () => {
    expect(
      formatUserLine(ok({
        userEmail: "ricardo.pinto@actsis.com",
        userRole: "proxy_admin",
      })),
    ).toBe("User: ricardo.pinto@actsis.com (proxy_admin)");
  });

  it("formats alias and role without email", () => {
    expect(
      formatUserLine(ok({ userAlias: "RPINTO", userRole: "proxy_admin" })),
    ).toBe("User: RPINTO (proxy_admin)");
  });

  it("formats the user id alone without a parenthetical", () => {
    expect(formatUserLine(ok({ userId: USER_ID }))).toBe(`User: ${USER_ID}`);
  });

  it("reports unknown when nothing is resolvable", () => {
    expect(formatUserLine(ok({}))).toBe("User: unknown");
  });

  it("reports no credential", () => {
    expect(formatUserLine({ kind: "no-credential" })).toBe("User: no credential");
  });

  it("reports unavailable with a single-line reason", () => {
    expect(
      formatUserLine({
        kind: "unavailable",
        reason: "Failed to fetch user info:\nboom  network",
      }),
    ).toBe("User: unavailable (Failed to fetch user info: boom network)");
  });
});

describe("identity formatTeamLine (S2)", () => {
  it("formats the resolved alias with the id", () => {
    expect(
      formatTeamLine({
        hasCredential: true,
        teamId: TEAM_ID,
        teamAlias: "Acceso-Completo",
      }),
    ).toBe(`Team: Acceso-Completo (${TEAM_ID})`);
  });

  it("formats the id alone when the alias is unavailable", () => {
    expect(
      formatTeamLine({
        hasCredential: true,
        teamId: TEAM_ID,
        teamAlias: null,
      }),
    ).toBe(`Team: ${TEAM_ID} (alias unavailable)`);
  });

  it("reports no team bound when the credential carries no teamId", () => {
    expect(
      formatTeamLine({ hasCredential: true, teamId: null, teamAlias: null }),
    ).toBe("Team: none (no team bound)");
  });

  it("reports no credential", () => {
    expect(
      formatTeamLine({ hasCredential: false, teamId: null, teamAlias: null }),
    ).toBe("Team: no credential");
  });
});

describe("identity", () => {
  let fetchImpl: ReturnType<
    typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>
  >;

  beforeEach(() => {
    fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        throw new Error("fetchImpl not mocked in this test");
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchGatewayIdentity (S3)", () => {
    it("reduces /user/info to the S3 allowlist and discards everything else", async () => {
      fetchImpl.mockImplementation(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        expect(url.href).toBe("https://gateway.example.com/user/info");
        return new Response(
          JSON.stringify({
            user_id: USER_ID,
            spend: 123.45,
            max_budget: 999,
            keys: [{ token: "sk-SECRET-KEY-TOKEN", key_alias: "leak-me" }],
            key_alias: "root-alias",
            user_info: {
              user_id: USER_ID,
              user_email: "ricardo.pinto@actsis.com",
              user_alias: "RPINTO",
              user_role: "proxy_admin",
              teams: ["9fd46572-0000", TEAM_ID, 42, null, ""],
              team_id: null,
              spend: 35.63,
              secret_nested: { token: "sk-SECRET-KEY-TOKEN" },
            },
          }),
          { status: 200 },
        );
      });

      const result = await fetchGatewayIdentity(
        "https://gateway.example.com",
        "sk-test",
        30_000,
        fetchImpl,
      );

      expect(result).toEqual({
        userId: USER_ID,
        userEmail: "ricardo.pinto@actsis.com",
        userAlias: "RPINTO",
        userRole: "proxy_admin",
        teams: ["9fd46572-0000", TEAM_ID],
      });
      // S5: the raw secret token never survives the allowlist reduction.
      expect(JSON.stringify(result)).not.toContain("sk-SECRET-KEY-TOKEN");
      expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("Authorization")).toBe(
        "Bearer sk-test",
      );
    });

    it("falls back to the root user_id when user_info is missing", async () => {
      fetchImpl.mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            user_id: USER_ID,
            keys: [{ token: "sk-SECRET-KEY-TOKEN" }],
          }),
          { status: 200 },
        );
      });

      const result = await fetchGatewayIdentity(
        "https://gateway.example.com",
        "sk-test",
        30_000,
        fetchImpl,
      );

      expect(result).toEqual(identity({ userId: USER_ID }));
      expect(JSON.stringify(result)).not.toContain("sk-SECRET-KEY-TOKEN");
    });

    it("keeps the identity empty when the body is not a JSON object", async () => {
      fetchImpl.mockImplementation(async () => {
        return new Response(JSON.stringify([1, 2, 3]), { status: 200 });
      });

      const result = await fetchGatewayIdentity(
        "https://gateway.example.com",
        "sk-test",
        30_000,
        fetchImpl,
      );

      expect(result).toEqual(identity());
    });

    it("normalizes the base URL before fetching", async () => {
      fetchImpl.mockImplementation(async (input: string | URL | Request) => {
        expect(String(input)).toBe("https://gateway.example.com/user/info");
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const result = await fetchGatewayIdentity(
        "https://gateway.example.com/",
        "sk-test",
        30_000,
        fetchImpl,
      );

      expect(result).toEqual(identity());
    });

    it("throws AuthError on 401 (single-line reason source)", async () => {
      fetchImpl.mockImplementation(async () => new Response("Unauthorized", { status: 401 }));

      await expect(
        fetchGatewayIdentity("https://gateway.example.com", "key", 30_000, fetchImpl),
      ).rejects.toThrow(AuthError);
      await expect(
        fetchGatewayIdentity("https://gateway.example.com", "key", 30_000, fetchImpl),
      ).rejects.toMatchObject({
        message: "Credential rejected by gateway. Run /login again.",
      });
    });

    it("throws AuthError on 403", async () => {
      fetchImpl.mockImplementation(async () => new Response("Forbidden", { status: 403 }));

      await expect(
        fetchGatewayIdentity("https://gateway.example.com", "key", 30_000, fetchImpl),
      ).rejects.toThrow(AuthError);
    });

    it("wraps network failures into a CatalogError with the failure message", async () => {
      fetchImpl.mockImplementation(async () => {
        throw new Error("boom network");
      });

      await expect(
        fetchGatewayIdentity("https://gateway.example.com", "key", 30_000, fetchImpl),
      ).rejects.toThrow(CatalogError);
      await expect(
        fetchGatewayIdentity("https://gateway.example.com", "key", 30_000, fetchImpl),
      ).rejects.toMatchObject({
        message: "Failed to fetch user info: boom network",
      });
    });

    it("never surfaces the response body when the payload is not valid JSON (S5)", async () => {
      const secret = "sk-SECRET-MALFORMED";
      fetchImpl.mockImplementation(
        async () => new Response(`{"keys":[{"token":"${secret}"`, { status: 200 }),
      );

      const error = await fetchGatewayIdentity(
        "https://gateway.example.com",
        "key",
        30_000,
        fetchImpl,
      ).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(CatalogError);
      expect((error as Error).message).toBe("user info response is not valid JSON");
      expect((error as Error).message).not.toContain(secret);
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    });
  });

  describe("fetchTeamAlias (S4)", () => {
    it("resolves the alias from the /team/list array", async () => {
      const urls: string[] = [];
      fetchImpl.mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        return new Response(
          JSON.stringify([
            { team_id: "9fd46572-0000", team_alias: "" },
            { team_id: TEAM_ID, team_alias: "Acceso-Completo" },
          ]),
          { status: 200 },
        );
      });

      const alias = await fetchTeamAlias(
        "https://gateway.example.com",
        "sk-test",
        30_000,
        TEAM_ID,
        fetchImpl,
      );

      expect(alias).toBe("Acceso-Completo");
      expect(
        urls.map((u) => u.replace("https://gateway.example.com", "")),
      ).toEqual(["/team/list"]);
      expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("Authorization")).toBe(
        "Bearer sk-test",
      );
    });

    it("falls back to /team/info when /team/list has no usable entry", async () => {
      const urls: string[] = [];
      fetchImpl.mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/team/list")) {
          return new Response(JSON.stringify({ detail: "not an array" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ team_id: TEAM_ID, team_alias: "Acceso-Completo" }),
          { status: 200 },
        );
      });

      const alias = await fetchTeamAlias(
        "https://gateway.example.com",
        "sk-test",
        30_000,
        TEAM_ID,
        fetchImpl,
      );

      expect(alias).toBe("Acceso-Completo");
      expect(
        urls.map((u) => u.replace("https://gateway.example.com", "")),
      ).toEqual(["/team/list", `/team/info?team_id=${TEAM_ID}`]);
    });

    it("encodes the team id in the /team/info fallback", async () => {
      const teamIdWithSpace = "team id/with chars";
      fetchImpl.mockImplementation(async (input: string | URL | Request) => {
        if (String(input).endsWith("/team/list")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify({ team_alias: "Encoded" }), { status: 200 });
      });

      const alias = await fetchTeamAlias(
        "https://gateway.example.com",
        "sk-test",
        30_000,
        teamIdWithSpace,
        fetchImpl,
      );

      expect(alias).toBe("Encoded");
      expect(String(fetchImpl.mock.calls[1][0])).toBe(
        "https://gateway.example.com/team/info?team_id=team%20id%2Fwith%20chars",
      );
    });

    it("exposes only the id (null alias) when both routes fail, 403 included", async () => {
      const urls: string[] = [];
      fetchImpl.mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        return new Response("Forbidden", { status: 403 });
      });

      const alias = await fetchTeamAlias(
        "https://gateway.example.com",
        "sk-test",
        30_000,
        TEAM_ID,
        fetchImpl,
      );

      expect(alias).toBeNull();
      expect(
        urls.map((u) => u.replace("https://gateway.example.com", "")),
      ).toEqual(["/team/list", `/team/info?team_id=${TEAM_ID}`]);
    });
  });

  describe("extractCredentialTeamId (T4)", () => {
    it("reads metadata.teamId from the v2 credential", () => {
      expect(extractCredentialTeamId({ metadata: { teamId: TEAM_ID } })).toBe(TEAM_ID);
    });

    it("returns null when absent or not usable", () => {
      expect(extractCredentialTeamId(null)).toBeNull();
      expect(extractCredentialTeamId(undefined)).toBeNull();
      expect(extractCredentialTeamId({})).toBeNull();
      expect(extractCredentialTeamId({ metadata: {} })).toBeNull();
      expect(extractCredentialTeamId({ metadata: { teamId: "" } })).toBeNull();
      expect(extractCredentialTeamId({ metadata: { teamId: 42 } })).toBeNull();
    });
  });
});
