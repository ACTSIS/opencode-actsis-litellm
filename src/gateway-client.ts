import { refreshGrant, type CliAuthDiscovery } from "./client.ts";
import type { PluginState } from "./state.ts";

const REFRESH_WINDOW_MS = 300_000;

export interface RefreshableCredential {
  access: string;
  refresh?: string;
  expires?: number;
}

export interface RefreshedCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export interface TokenRefreshContext {
  state: PluginState | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  onRefreshed?: (next: RefreshedCredentials) => Promise<void>;
}

export function discoveryFromState(state: PluginState): CliAuthDiscovery {
  return {
    contractVersion: 1,
    issuer: state.tokenEndpoint ? new URL(state.tokenEndpoint).origin : "",
    authorizationEndpoint: state.tokenEndpoint ?? "",
    tokenEndpoint: state.tokenEndpoint ?? "",
    registrationEndpoint: state.tokenEndpoint ?? "",
    revocationEndpoint: state.revocationEndpoint ?? "",
    resource: state.resource ?? "",
    codeChallengeMethods: ["S256"],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethods: ["none"],
  };
}

export async function ensureFreshToken(
  credential: RefreshableCredential,
  context: TokenRefreshContext,
): Promise<string> {
  const expires = typeof credential.expires === "number" ? credential.expires : null;
  const refresh =
    typeof credential.refresh === "string" && credential.refresh
      ? credential.refresh
      : null;

  if (
    expires !== null &&
    expires < Date.now() + REFRESH_WINDOW_MS &&
    refresh &&
    context.state?.tokenEndpoint
  ) {
    const refreshed = await refreshGrant(
      discoveryFromState(context.state),
      { refreshToken: refresh, clientId: context.state.clientId ?? "" },
      context.timeoutMs,
      context.fetchImpl,
    );
    const next: RefreshedCredentials = {
      access: refreshed.accessToken,
      refresh: refreshed.refreshToken ?? refresh,
      expires: Date.now() + Math.max(refreshed.expiresIn - 300, 60) * 1000,
    };
    if (context.onRefreshed) {
      await context.onRefreshed(next);
    }
    return next.access;
  }

  return credential.access;
}
