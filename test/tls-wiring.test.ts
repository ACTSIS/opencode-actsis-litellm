import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Wiring contract: the plugin setup must call configureSystemCa (with a
// stable onceKey and the ACTSIS_LITELLM_NO_SYSTEM_CA opt-out pass-through)
// BEFORE registering auth methods/providers, and the call must be
// non-fatal. The tls-config module is mocked so the TLS store is never
// mutated from a test and the wiring order is observable.

const calls: string[] = vi.hoisted(() => [] as string[]);
const configureSystemCaMock = vi.hoisted(() =>
  vi.fn(async (
    _opts: { onceKey?: string; optOutEnv?: string } = {},
  ): Promise<{ kind: string; addedCertificates?: number; reason?: string }> => {
    calls.push("tls");
    return { kind: "configured", addedCertificates: 1 };
  }),
);

vi.mock("../src/tls-config.ts", () => ({
  configureSystemCa: configureSystemCaMock,
}));

import serverPlugin, { type SetupContext } from "../src/plugin.ts";

const pluginSetup = async (ctx: SetupContext): Promise<() => Promise<void>> =>
  (await serverPlugin.setup(ctx as never)) as () => Promise<void>;

const originalEnv = {
  noSystemCa: process.env.ACTSIS_LITELLM_NO_SYSTEM_CA,
  stateDir: process.env.ACTSIS_LITELLM_STATE_DIR,
};

let stateDir = "";
let registeredHooks = 0;

interface MethodRecord {
  integrationID?: string;
}

function makeFakeContext(options: Record<string, unknown> = {}) {
  const methods: MethodRecord[] = [];
  const providers: Array<Record<string, unknown>> = [];
  const tools: Array<Record<string, unknown>> = [];
  const commands: Array<Record<string, unknown>> = [];
  let hookCount = 0;
  const fake = {
    options,
    provider: {
      transform: async (cb: (e: { add: (input: Record<string, unknown>) => void }) => void) => {
        calls.push("provider");
        cb({ add: (input) => providers.push(input) });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (cb: (e: { add: (tool: Record<string, unknown>) => void }) => void) => {
        cb({ add: (tool) => tools.push(tool) });
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (cb: (e: { add: (definition: Record<string, unknown>) => void }) => void) => {
        cb({ add: (definition) => commands.push(definition) });
        return { dispose: async () => {} };
      },
    },
    integration: {
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
      transform: async (cb: (e: {
        method: { update: (input: MethodRecord) => void };
      }) => void) => {
        calls.push("methods");
        cb({ method: { update: (input) => methods.push(input) } });
        return { dispose: async () => {} };
      },
    },
    session: {
      prompt: async () => ({}),
      hook: (name: string, callback: (input: Record<string, unknown>) => unknown) => {
        void name;
        void callback;
        hookCount += 1;
        registeredHooks = hookCount;
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: () => (async function* () {})(),
    },
  };
  return { ctx: fake as unknown as SetupContext, methods, providers, tools, commands };
}

beforeEach(async () => {
  delete process.env.ACTSIS_LITELLM_NO_SYSTEM_CA;
  stateDir = path.join(
    await mkdtemp(path.join(os.tmpdir(), "tls-wiring-")),
    "state",
  );
  await mkdir(stateDir, { recursive: true });
  // A stored gateway URL keeps provider bootstrap offline and fast.
  await writeFile(
    path.join(stateDir, "state.json"),
    JSON.stringify({ version: 1, gatewayUrl: "https://gw.example.com" }),
  );
  process.env.ACTSIS_LITELLM_STATE_DIR = stateDir;
  configureSystemCaMock.mockClear();
  calls.length = 0;
  registeredHooks = 0;
});

afterEach(async () => {
  if (originalEnv.noSystemCa === undefined) {
    delete process.env.ACTSIS_LITELLM_NO_SYSTEM_CA;
  } else {
    process.env.ACTSIS_LITELLM_NO_SYSTEM_CA = originalEnv.noSystemCa;
  }
  if (originalEnv.stateDir === undefined) {
    delete process.env.ACTSIS_LITELLM_STATE_DIR;
  } else {
    process.env.ACTSIS_LITELLM_STATE_DIR = originalEnv.stateDir;
  }
  await rm(stateDir, { recursive: true, force: true });
});

describe("plugin TLS wiring contract", () => {
  it("calls configureSystemCa once per setup, before auth-method registration", async () => {
    const { ctx, methods } = makeFakeContext();
    const cleanup = await pluginSetup(ctx);
    expect(configureSystemCaMock).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("tls")).toBe(0);
    expect(calls.indexOf("methods")).toBeGreaterThan(calls.indexOf("tls"));
    expect(calls.indexOf("methods")).toBeLessThan(calls.indexOf("provider"));
    expect(methods.length).toBe(2);
    expect(registeredHooks).toBe(3);
    await cleanup();
  });

  it("passes the stable onceKey and the ACTSIS_LITELLM_NO_SYSTEM_CA value through", async () => {
    process.env.ACTSIS_LITELLM_NO_SYSTEM_CA = "1";
    const { ctx } = makeFakeContext();
    const cleanup = await pluginSetup(ctx);
    expect(configureSystemCaMock).toHaveBeenCalledWith({
      onceKey: "actsis-litellm-plugin",
      optOutEnv: "1",
    });
    await cleanup();
    delete process.env.ACTSIS_LITELLM_NO_SYSTEM_CA;

    const { ctx: ctx2 } = makeFakeContext();
    const cleanup2 = await pluginSetup(ctx2);
    const secondCall = configureSystemCaMock.mock.calls.at(-1)?.[0] as
      | { optOutEnv?: string; onceKey?: string }
      | undefined;
    expect(secondCall?.onceKey).toBe("actsis-litellm-plugin");
    expect(secondCall?.optOutEnv).toBeUndefined();
    await cleanup2();
  });

  it("never blocks startup when the TLS bootstrap fails or throws", async () => {
    configureSystemCaMock.mockImplementationOnce(async () => {
      calls.push("tls");
      return { kind: "failed", reason: "simulated TLS failure" };
    });
    const { ctx, methods } = makeFakeContext();
    const cleanup = await pluginSetup(ctx);
    expect(methods.length).toBe(2);
    await cleanup();

    configureSystemCaMock.mockImplementationOnce(async () => {
      calls.push("tls");
      throw new Error("simulated bootstrap crash");
    });
    const { ctx: ctx2, methods: methods2 } = makeFakeContext();
    const cleanup2 = await pluginSetup(ctx2);
    expect(methods2.length).toBe(2);
    await cleanup2();
  });
});