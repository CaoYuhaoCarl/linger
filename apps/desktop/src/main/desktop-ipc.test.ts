import { afterEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../shared/api.js";

const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
);
vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

const { DesktopIpcModule } = await import("./desktop-ipc.js");
const { stubModule, testHost } = await import("./test-support.js");

const SERVER = "http://localhost:3000";
const PASSWORD = "a-private-password";

const fixture = async (
  localServer: {
    servesWindow?: () => Promise<boolean>;
    signInWithAccount?: () => Promise<void>;
  } = {},
) => {
  const local = {
    ...stubModule("LocalServer"),
    servesWindow: vi.fn(localServer.servesWindow ?? (async () => true)),
    signInWithAccount: vi.fn(localServer.signInWithAccount ?? (async () => {})),
  };
  const host = testHost(
    [
      stubModule("Enrollment"),
      stubModule("PowerGuard"),
      stubModule("ComputerDaemon"),
      stubModule("WindowManager"),
      stubModule("WorkspaceGrants"),
      local as never,
      new DesktopIpcModule({ defaultDisplayName: "Desk" }),
    ],
    { serverUrl: SERVER },
  );
  await host.start();
  const invoke = (channel: string, origin = SERVER) =>
    handlers.get(channel)!({ senderFrame: { origin } });
  return { host, local, invoke };
};

afterEach(() => handlers.clear());

describe("DesktopIpcModule local account", () => {
  it("offers the account only for the installed server", async () => {
    const f = await fixture({ servesWindow: async () => false });
    expect(await f.invoke(IPC.localAccountAvailable)).toBe(false);
    f.local.servesWindow.mockResolvedValue(true);
    expect(await f.invoke(IPC.localAccountAvailable)).toBe(true);
    await f.host.stop("quit");
  });

  it("rejects pages from any other origin", async () => {
    const f = await fixture();
    expect(() =>
      f.invoke(IPC.localAccountSignIn, "https://evil.example.com"),
    ).toThrow("Not allowed");
    expect(() =>
      f.invoke(IPC.localAccountAvailable, "https://evil.example.com"),
    ).toThrow("Not allowed");
    expect(f.local.signInWithAccount).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("signs in and returns no account data to the page", async () => {
    const f = await fixture();
    expect(await f.invoke(IPC.localAccountSignIn)).toEqual({ ok: true });
    expect(f.local.signInWithAccount).toHaveBeenCalledOnce();
    await f.host.stop("quit");
  });

  it("returns why signing in failed", async () => {
    const f = await fixture({
      signInWithAccount: async () => {
        throw new Error(
          "The local account file must be private and owned by the current user (chmod 600).",
        );
      },
    });
    const result = await f.invoke(IPC.localAccountSignIn);
    expect(result).toEqual({
      ok: false,
      message:
        "The local account file must be private and owned by the current user (chmod 600).",
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    await f.host.stop("quit");
  });
});

describe("DesktopIpcModule iMessage", () => {
  const imessageFixture = async () => {
    const imessage = {
      ...stubModule("IMessage"),
      refresh: vi.fn(async () => ({ enabled: false })),
      set: vi.fn(() => ({ ok: true })),
      act: vi.fn(async () => ({ enabled: false })),
    };
    const host = testHost(
      [
        stubModule("Enrollment"),
        stubModule("PowerGuard"),
        stubModule("ComputerDaemon"),
        {
          ...stubModule("WindowManager"),
          webContents: () => undefined,
        } as never,
        stubModule("WorkspaceGrants"),
        stubModule("LocalServer"),
        imessage as never,
        new DesktopIpcModule({ defaultDisplayName: "Desk", imessage: true }),
      ],
      { serverUrl: SERVER },
    );
    await host.start();
    const invoke = (channel: string, arg?: unknown, origin = SERVER) =>
      handlers.get(channel)!({ senderFrame: { origin } }, arg);
    return { host, imessage, invoke };
  };

  it("registers no iMessage channels without the module", async () => {
    const f = await fixture();
    expect(handlers.has(IPC.imessageStatus)).toBe(false);
    expect(handlers.has(IPC.imessageSet)).toBe(false);
    await f.host.stop("quit");
  });

  it("rejects other origins and bad input", async () => {
    const f = await imessageFixture();
    const evil = "https://evil.example.com";
    expect(() => f.invoke(IPC.imessageStatus, undefined, evil)).toThrow(
      "Not allowed",
    );
    expect(() => f.invoke(IPC.imessageSet, { enabled: true }, evil)).toThrow(
      "Not allowed",
    );
    expect(() => f.invoke(IPC.imessageAct, "retry_install", evil)).toThrow(
      "Not allowed",
    );
    expect(() => f.invoke(IPC.imessageSet, { enabled: "yes" })).toThrow();
    expect(() => f.invoke(IPC.imessageSet, { extra: 1 })).toThrow();
    expect(() => f.invoke(IPC.imessageSet, { handles: [1] })).toThrow();
    expect(() => f.invoke(IPC.imessageAct, "run_shell")).toThrow();
    expect(f.imessage.set).not.toHaveBeenCalled();
    expect(f.imessage.act).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("passes valid calls to the module", async () => {
    const f = await imessageFixture();
    await f.invoke(IPC.imessageStatus);
    expect(f.imessage.refresh).toHaveBeenCalledOnce();
    f.invoke(IPC.imessageSet, { enabled: true, handles: ["a@b.co"] });
    expect(f.imessage.set).toHaveBeenCalledWith({
      enabled: true,
      handles: ["a@b.co"],
    });
    await f.invoke(IPC.imessageAct, "request_automation");
    expect(f.imessage.act).toHaveBeenCalledWith("request_automation");
    await f.host.stop("quit");
  });
});
