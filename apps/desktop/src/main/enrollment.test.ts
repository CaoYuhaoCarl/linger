import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CredentialStore } from "./computer-credential.js";
import type { DesktopConfig } from "./config.js";
import {
  EnrollmentError,
  EnrollmentModule,
  enrollComputer,
  readDaemonId,
} from "./enrollment.js";
import { stubModule, tempDirectory, testHost } from "./test-support.js";

const claims = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = `sr1.${claims({
  runner_id: "computer_1",
  tenant_owners: [{ tenant_id: "tenant_acme", owner_actor_id: "actor_ann" }],
})}.${"s".repeat(43)}`;

interface Call {
  readonly url: string;
  readonly method: string;
  readonly cookie: string | undefined;
  readonly body: Record<string, unknown> | undefined;
}

const fakeServer = (
  overrides: {
    createStatus?: number;
    createError?: string;
    exchangeStatus?: number;
    bundle?: Record<string, unknown>;
  } = {},
): { fetch: typeof fetch; calls: Call[] } => {
  const calls: Call[] = [];
  let challenge = "";
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({
      url: input.pathname,
      method: init.method ?? "GET",
      cookie: headers.cookie,
      body,
    });
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), { status });
    if (input.pathname === "/v0/me")
      return json({ actors: [{ kind: "human", tenant_id: "tenant_acme" }] });
    if (input.pathname.endsWith("/local-computer-enrollments")) {
      if (overrides.createStatus)
        return json(
          {
            error: {
              code: overrides.createError ?? "INTERNAL_ERROR",
              message: "Refused",
              request_id: "request_1",
            },
          },
          overrides.createStatus,
        );
      challenge = String(body?.code_challenge);
      return json({
        enrollment_id: "enr_1",
        computer_id: "computer_1",
        authorization_code: "code_1",
        expires_at: "2026-10-16T08:00:00Z",
      });
    }
    if (overrides.exchangeStatus) return json({}, overrides.exchangeStatus);
    const verifier = String(body?.code_verifier);
    if (createHash("sha256").update(verifier).digest("base64url") !== challenge)
      return json({}, 400);
    return json(
      overrides.bundle ?? {
        computer_id: "computer_1",
        tenant_id: "tenant_acme",
        gateway_url: "wss://linger.example.com/v1/runner",
        gateway_token: TOKEN,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
};

const input = {
  serverUrl: "https://linger.example.com",
  cookie: "teamhub_session=abc",
  displayName: "Laptop",
};

describe("enrollComputer", () => {
  it("creates with the session cookie and exchanges as the computer", async () => {
    const server = fakeServer();
    const enrolled = await enrollComputer({ ...input, fetch: server.fetch });
    expect(enrolled).toEqual({
      computerId: "computer_1",
      tenantId: "tenant_acme",
      ownerActorId: "actor_ann",
      gatewayUrl: "wss://linger.example.com/v1/runner",
      credential: TOKEN,
    });
    expect(server.calls.map((c) => [c.method, c.url, !!c.cookie])).toEqual([
      ["GET", "/v0/me", true],
      ["POST", "/v0/tenants/tenant_acme/local-computer-enrollments", true],
      ["POST", "/v0/local-computer-enrollments/enr_1/exchange", false],
    ]);
    expect(server.calls[1]?.body).not.toHaveProperty("computer_id");
  });

  it("keeps the Computer identity when enrolling again", async () => {
    const server = fakeServer();
    await enrollComputer({
      ...input,
      computerId: "computer_1",
      fetch: server.fetch,
    });
    expect(server.calls[1]?.body?.computer_id).toBe("computer_1");
  });

  it("rejects a bundle for another Computer", async () => {
    const server = fakeServer({
      bundle: {
        computer_id: "computer_2",
        tenant_id: "tenant_acme",
        gateway_url: "wss://linger.example.com/v1/runner",
        gateway_token: TOKEN,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    });
    await expect(
      enrollComputer({ ...input, fetch: server.fetch }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects a credential scoped to another tenant", async () => {
    const server = fakeServer({
      bundle: {
        computer_id: "computer_1",
        tenant_id: "tenant_acme",
        gateway_url: "wss://linger.example.com/v1/runner",
        gateway_token: `sr1.${claims({
          runner_id: "computer_1",
          tenant_owners: [
            { tenant_id: "tenant_other", owner_actor_id: "actor_ann" },
          ],
        })}.${"s".repeat(43)}`,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    });
    await expect(
      enrollComputer({ ...input, fetch: server.fetch }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("names the machine's Daemon so TeamHub can renew the Computer it holds", async () => {
    const server = fakeServer();
    await enrollComputer({
      ...input,
      daemonId: DAEMON_ID,
      fetch: server.fetch,
    });
    expect(server.calls[1]?.body).toMatchObject({ daemon_id: DAEMON_ID });
  });

  it("reports a Daemon another account's Computer holds", async () => {
    const failure = await enrollComputer({
      ...input,
      daemonId: DAEMON_ID,
      fetch: fakeServer({
        createStatus: 409,
        createError: "DAEMON_IDENTITY_IN_USE",
      }).fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EnrollmentError);
    expect(failure).toMatchObject({ code: "DAEMON_IDENTITY_IN_USE" });
  });

  it("reports a removed enrollment", async () => {
    const failure = await enrollComputer({
      ...input,
      fetch: fakeServer({ exchangeStatus: 410 }).fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EnrollmentError);
    expect(failure).toMatchObject({ code: "ENROLLMENT_REMOVED" });
  });

  it("rejects a bundle without a WebSocket gateway", async () => {
    const server = fakeServer({
      bundle: {
        computer_id: "computer_1",
        tenant_id: "tenant_acme",
        gateway_url: "https://linger.example.com/v1/runner",
        gateway_token: TOKEN,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    });
    await expect(
      enrollComputer({ ...input, fetch: server.fetch }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

// The daemon keeps its identity key (public and private) here; the Daemon ID
// is the SHA-256 of the raw public key, as the daemon derives it.
const PUBLIC_KEY = Buffer.alloc(32, 7);
const DAEMON_ID = createHash("sha256").update(PUBLIC_KEY).digest("base64url");

const daemonIdentityFile = (): string => {
  const file = path.join(tempDirectory(), "daemon-identity.json");
  writeFileSync(
    file,
    JSON.stringify({
      public_key: PUBLIC_KEY.toString("base64").replace(/=+$/, ""),
      private_key: Buffer.alloc(64, 9).toString("base64").replace(/=+$/, ""),
    }),
  );
  return file;
};

const startEnrollment = async (
  config: Partial<DesktopConfig>,
  options: { credentialFor?: string } = {},
) => {
  const server = fakeServer();
  const credentials = new CredentialStore(
    path.join(tempDirectory(), "credential.json"),
  );
  if (options.credentialFor)
    credentials.write({
      computerId: options.credentialFor,
      gatewayUrl: "wss://linger.example.com/v1/runner",
      token: TOKEN,
    });
  const module = new EnrollmentModule({
    sessionCookie: async () => "teamhub_session=abc",
    defaultDisplayName: "Laptop",
    credentials,
    daemonIdentityFile: daemonIdentityFile(),
    fetch: server.fetch,
  });
  const host = testHost([stubModule("Config"), module], {
    serverUrl: "https://linger.example.com",
    ...config,
  });
  await host.start();
  return { host, module, server };
};

describe("readDaemonId", () => {
  it("derives the Daemon ID from the stored public key", () => {
    expect(readDaemonId(daemonIdentityFile())).toBe(DAEMON_ID);
  });

  it("has none before the daemon first ran", () => {
    expect(
      readDaemonId(path.join(tempDirectory(), "daemon-identity.json")),
    ).toBeUndefined();
  });
});

describe("EnrollmentModule", () => {
  it("pairs the Computer the daemon holds after Set Up Again forgot it", async () => {
    const { host, module, server } = await startEnrollment({});
    await module.enroll();
    const create = server.calls.find((call) =>
      call.url.endsWith("/local-computer-enrollments"),
    );
    expect(create?.body).toMatchObject({ daemon_id: DAEMON_ID });
    expect(create?.body).not.toHaveProperty("computer_id");
    expect(host.ctx.config.get()).toMatchObject({
      computerId: "computer_1",
      daemonId: DAEMON_ID,
    });
  });

  it("renews once an enrollment made without the daemon's identity", async () => {
    // Set Up Again in an earlier release paired the orphan computer_9 while
    // the daemon's identity stayed with computer_1.
    const { host, server } = await startEnrollment(
      {
        computerId: "computer_9",
        tenantId: "tenant_acme",
        ownerActorId: "actor_ann",
      },
      { credentialFor: "computer_9" },
    );
    await vi.waitFor(() =>
      expect(host.ctx.config.get().computerId).toBe("computer_1"),
    );
    expect(
      server.calls.find((call) =>
        call.url.endsWith("/local-computer-enrollments"),
      )?.body,
    ).toMatchObject({ computer_id: "computer_9", daemon_id: DAEMON_ID });
    expect(host.ctx.config.get().daemonId).toBe(DAEMON_ID);
  });

  it("does not renew an enrollment made with the daemon's identity", async () => {
    const { server } = await startEnrollment(
      {
        computerId: "computer_1",
        tenantId: "tenant_acme",
        ownerActorId: "actor_ann",
        daemonId: DAEMON_ID,
      },
      { credentialFor: "computer_1" },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.calls).toEqual([]);
  });
});
