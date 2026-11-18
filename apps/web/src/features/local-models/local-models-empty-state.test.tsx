import type { components } from "@linger/wire-contracts/teamhub-public/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { computerEnvironmentName } from "@/features/local-computer/computer-platform";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { ReadinessEmptyState } from "./local-models-empty-state";
import type { LocalModelsView } from "./local-models-queries";
import { gb, labView } from "./local-models-test-support";

type Schemas = components["schemas"];
type Computer = LocalModelsView["computer"];
type Readiness = Schemas["LocalModelsReadiness"];

const tenantId = "tenant-northstar";
const refreshPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/refresh";
const origin = window.location.origin;
const cli = `linger-computer-${computerEnvironmentName(origin)}`;

afterEach(() => {
  cleanup();
  delete (window as { lingerDesktop?: unknown }).lingerDesktop;
});

const nvidiaHost: Schemas["LocalComputerAccelerators"] = {
  apple_silicon: false,
  gpus: [{ memory_bytes: gb(48), name: "NVIDIA L40S", vendor: "nvidia" }],
  probe: "ok",
  ram_total_bytes: gb(128),
};

function emptyView(
  readiness: Partial<Readiness> & Pick<Readiness, "state">,
  computer: Partial<Computer> = {},
  fields: Partial<LocalModelsView> = {},
): LocalModelsView {
  const base = labView();
  return {
    ...base,
    available: false,
    computer: {
      ...base.computer,
      daemon_version: "0.52.0",
      host: undefined,
      platform: "linux",
      ...computer,
      readiness: { enable_command: false, ...readiness },
    },
    models: [],
    pools: [],
    reason: { code: "TOOL_NOT_INSTALLED", detail: "raw tool output" },
    ...fields,
  };
}

function CurrentSearch() {
  return <p>Address search: {useLocation().search}</p>;
}

function renderState(view: LocalModelsView) {
  const runtime = createTestTeamHubRuntime();
  const refreshes: string[] = [];
  runtime.server.on("POST", refreshPath, ({ params }) => {
    refreshes.push(params.computerId!);
    return Response.json({ computer_id: params.computerId }, { status: 202 });
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter
          initialEntries={[
            `/t/${tenantId}/settings/local-models?computer=${view.computer.computer_id}`,
          ]}
        >
          <Routes>
            <Route
              element={
                <>
                  <ReadinessEmptyState tenantId={tenantId} view={view} />
                  <CurrentSearch />
                </>
              }
              path="/t/:tenantId/settings/local-models"
            />
            <Route
              element={<p>Computers page</p>}
              path="/t/:tenantId/settings/computers"
            />
          </Routes>
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { refreshes, runtime };
}

function region(title: string) {
  return screen.getByRole("region", { name: title });
}

function codeBlocks(container: HTMLElement) {
  return Array.from(container.querySelectorAll("code")).map(
    (node) => node.textContent,
  );
}

/** Every link goes to docs.heylinger.com or stays in the app. */
function expectSafeLinks(container: HTMLElement) {
  for (const link of within(container).queryAllByRole("link")) {
    const href = link.getAttribute("href") ?? "";
    expect(
      href.startsWith("https://docs.heylinger.com/") || href.startsWith("/"),
      href,
    ).toBe(true);
    expect(href).not.toMatch(/token|credential/i);
  }
}

interface Case {
  readiness: Partial<Readiness> & Pick<Readiness, "state">;
  computer?: Partial<Computer>;
  title: string;
  owner: {
    body: string;
    commands?: string[];
    buttons?: string[];
    links: string[];
  };
  /** What a non-owner is asked to tell the owner; absent keeps the owner's body. */
  ask?: string;
}

const cases: Record<string, Case> = {
  "not_set_up · cli · enable command": {
    computer: { accelerators: nvidiaHost, install_kind: "cli" },
    owner: {
      body: "Run this on lab-118 as the user that runs Linger.",
      commands: [`${cli} local-models enable`],
      links: ["CLI setup"],
    },
    readiness: {
      enable_command: true,
      reason: "SETUP_AVAILABLE",
      setup_path: "nvidia",
      state: "not_set_up",
    },
    ask: "set them up",
    title: "Set up local models on lab-118",
  },
  "not_set_up · cli · before the enable command": {
    computer: { accelerators: nvidiaHost, install_kind: "cli" },
    owner: {
      body: "Follow the CLI setup steps on lab-118",
      commands: [],
      links: ["CLI setup"],
    },
    readiness: { reason: "SETUP_AVAILABLE", state: "not_set_up" },
    ask: "set them up",
    title: "Set up local models on lab-118",
  },
  "not_set_up · container": {
    computer: { accelerators: nvidiaHost, install_kind: "container" },
    owner: {
      body: "lab-118 runs in a container. It needs a GPU passed through (NVIDIA L40S is visible) and a volume for the model files.",
      commands: [`${cli} local-models enable --base-dir <volume path>`],
      links: ["GPU passthrough", "CLI setup"],
    },
    readiness: {
      enable_command: true,
      reason: "SETUP_AVAILABLE",
      state: "not_set_up",
    },
    ask: "set them up",
    title: "Set up local models in lab-118",
  },
  "not_set_up · container without a GPU": {
    computer: {
      accelerators: { ...nvidiaHost, gpus: [] },
      install_kind: "container",
    },
    owner: {
      body: "(none is visible now)",
      commands: [],
      links: ["CLI setup", "GPU passthrough"],
    },
    readiness: { reason: "SETUP_AVAILABLE", state: "not_set_up" },
    ask: "set them up",
    title: "Set up local models in lab-118",
  },
  "not_set_up · desktop elsewhere": {
    computer: { install_kind: "desktop", platform: "darwin" },
    owner: {
      body: "On lab-118, open the Linger app and choose Set up local models in Settings › Local models.",
      commands: [],
      links: ["Set up in the desktop app"],
    },
    readiness: { reason: "SETUP_AVAILABLE", state: "not_set_up" },
    ask: "set them up",
    title: "Local models aren't set up on lab-118",
  },
  "not_set_up · hardware unknown": {
    owner: {
      body: "Set them up the way lab-118 was installed:",
      links: ["CLI setup", "Requirements"],
    },
    readiness: { reason: "HARDWARE_UNKNOWN", state: "not_set_up" },
    ask: "set them up",
    title: "Local models aren't set up on lab-118",
  },
  "unsupported_hardware · Intel Mac": {
    computer: { platform: "darwin" },
    owner: {
      body: "Local models run on Apple silicon's GPU and need at least 16 GB of unified memory. lab-118 has an Intel processor. Agents on lab-118 keep working with cloud models through Codex, Claude Code or Pi.",
      links: ["Requirements"],
    },
    readiness: {
      reason: "PLATFORM_UNSUPPORTED",
      state: "unsupported_hardware",
    },
    title: "lab-118 can't run local models",
  },
  "unsupported_hardware · 8 GB Mac": {
    computer: {
      accelerators: {
        apple_silicon: true,
        gpus: [],
        probe: "ok",
        ram_total_bytes: gb(8),
        unified_memory_bytes: gb(8),
      },
      platform: "darwin",
    },
    owner: {
      body: "need at least 16 GB of unified memory. lab-118 has 8 GB.",
      links: ["Requirements"],
    },
    readiness: {
      reason: "MEMORY_INSUFFICIENT",
      setup_path: "apple_silicon",
      state: "unsupported_hardware",
    },
    title: "lab-118 can't run local models",
  },
  "unsupported_hardware · no GPU": {
    computer: {
      accelerators: { ...nvidiaHost, gpus: [] },
      install_kind: "cli",
    },
    owner: {
      body: "Local models need an NVIDIA GPU with at least 8 GB of memory; they don't run on the CPU alone. No GPU was found. Agents on lab-118 keep working with cloud models.",
      links: ["Requirements"],
    },
    readiness: { reason: "NO_SUPPORTED_GPU", state: "unsupported_hardware" },
    title: "lab-118 has no supported GPU",
  },
  "unsupported_hardware · tool on a host without a GPU, no profile": {
    computer: {
      host: {
        arch: "x86_64",
        disk_free_bytes: gb(200),
        engine_label: "llama.cpp",
        gpus: [],
        os_label: "Ubuntu 24.04",
        platform: "linux",
        ram_total_bytes: gb(32),
      },
    },
    owner: {
      body: "they don't run on the CPU alone. No GPU was found.",
      links: ["Requirements"],
    },
    readiness: { reason: "NO_SUPPORTED_GPU", state: "unsupported_hardware" },
    title: "lab-118 has no supported GPU",
  },
  "unsupported_hardware · small NVIDIA GPU in a container": {
    computer: {
      accelerators: {
        ...nvidiaHost,
        gpus: [{ memory_bytes: gb(4), name: "GTX 1650", vendor: "nvidia" }],
      },
      install_kind: "container",
    },
    owner: {
      body: "GTX 1650 has 4 GB.",
      links: ["Requirements", "GPU passthrough"],
    },
    readiness: { reason: "MEMORY_INSUFFICIENT", state: "unsupported_hardware" },
    title: "lab-118 has no supported GPU",
  },
  "unsupported_hardware · AMD GPU": {
    computer: {
      accelerators: {
        ...nvidiaHost,
        gpus: [{ name: "Radeon RX 7900", vendor: "amd" }],
      },
      platform: "win32",
    },
    owner: { body: "Radeon RX 7900 isn't supported.", links: ["Requirements"] },
    readiness: { reason: "NO_SUPPORTED_GPU", state: "unsupported_hardware" },
    title: "lab-118 has no supported GPU",
  },
  "unsupported_hardware · no model fits the disk": {
    owner: {
      body: "None of the models fits the free disk on lab-118.",
      links: ["Requirements"],
    },
    readiness: { reason: "DISK_INSUFFICIENT", state: "unsupported_hardware" },
    title: "lab-118 doesn't have enough free disk",
  },
  needs_update: {
    computer: { daemon_version: "0.51.0" },
    owner: {
      body: "Its Linger version (0.51.0) can't report local models yet. It updates itself within the hour",
      links: ["Updating a computer"],
    },
    readiness: { reason: "UPDATE_PENDING", state: "needs_update" },
    ask: "update Linger",
    title: "lab-118 is updating",
  },
  "needs_update · desktop app behind": {
    computer: { daemon_version: "0.52.0", install_kind: "desktop" },
    owner: {
      body: "lab-118 runs an older Linger desktop app (0.52.0), which can't report local models. On lab-118, update Linger from the account menu or the tray menu (Download Update, then Restart to Update).",
      links: ["Set up in the desktop app", "Updating a computer"],
    },
    readiness: { reason: "DESKTOP_APP_OUTDATED", state: "needs_update" },
    ask: "update Linger",
    title: "Update the Linger app on lab-118",
  },
  "needs_reinstall · Simplex era on Linux": {
    computer: { daemon_version: "0.50.0" },
    owner: {
      body: "lab-118 runs a version from before Simplex became Linger (0.50.0) and can't update itself. Run the install command on lab-118 once.",
      commands: [`curl -fsSL "${origin}/install/linger-computer.sh" | bash`],
      links: ["Manual steps", "Updating a computer"],
    },
    readiness: { reason: "DAEMON_LEGACY", state: "needs_reinstall" },
    ask: "reinstall Linger",
    title: "Move lab-118 to Linger",
  },
  "needs_reinstall · Simplex era on Windows": {
    computer: { daemon_version: "0.43.0", platform: "win32" },
    owner: {
      body: "Follow the steps to move it once",
      commands: [],
      links: ["See the steps", "Updating a computer"],
    },
    readiness: { reason: "DAEMON_LEGACY", state: "needs_reinstall" },
    ask: "reinstall Linger",
    title: "Move lab-118 to Linger",
  },
  "needs_reinstall · update failed": {
    computer: { platform: "win32" },
    owner: {
      body: "It hasn't been able to update to the current Linger version.",
      commands: [`irm '${origin}/install/linger-computer.ps1' | iex`],
      links: ["Updating a computer"],
    },
    readiness: { reason: "UPDATE_FAILED", state: "needs_reinstall" },
    ask: "reinstall Linger",
    title: "lab-118 couldn't update",
  },
  "needs_reinstall · unsupported": {
    computer: { daemon_version: "0.21.0", platform: "darwin" },
    owner: {
      body: "This version (0.21.0) can no longer connect.",
      commands: [`curl -fsSL "${origin}/install/linger-computer.sh" | bash`],
      links: ["Manual steps", "Updating a computer"],
    },
    readiness: { reason: "DAEMON_UNSUPPORTED", state: "needs_reinstall" },
    ask: "reinstall Linger",
    title: "Reinstall Linger on lab-118",
  },
  needs_attention: {
    computer: { install_kind: "cli" },
    owner: {
      body: "The model tools on lab-118 didn't answer.",
      buttons: ["Check again"],
      commands: [`${cli} local-models enable --repair`],
      links: ["Troubleshooting"],
    },
    readiness: {
      enable_command: true,
      reason: "TOOL_FAILED",
      state: "needs_attention",
    },
    ask: "check the model tools",
    title: "Couldn't read the local models on lab-118",
  },
  managed_elsewhere: {
    computer: {
      managed_by: { computer_id: "computer-gpu", label: "GPU server" },
    },
    owner: {
      body: "Its Agents use models served by GPU server.",
      links: ["Open GPU server", "Remote gateways"],
    },
    readiness: { state: "managed_elsewhere" },
    title: "lab-118 uses models from GPU server",
  },
  checking: {
    owner: { body: "Checking", links: [] },
    readiness: { state: "checking" },
    title: "Checking local models on lab-118",
  },
  not_reported: {
    owner: {
      body: "It's connected but hasn't sent its model list. Restart Linger on lab-118.",
      links: ["Troubleshooting"],
    },
    readiness: { reason: "NOT_REPORTED", state: "not_reported" },
    ask: "restart Linger",
    title: "lab-118 hasn't reported local models",
  },
};

// Every not-ready state has at least one case; a new state fails here.
const covered: Record<
  Exclude<Schemas["LocalModelsReadinessState"], "loaded" | "working" | "ready">,
  true
> = {
  checking: true,
  managed_elsewhere: true,
  needs_attention: true,
  needs_reinstall: true,
  needs_update: true,
  not_reported: true,
  not_set_up: true,
  unsupported_hardware: true,
};

describe("ReadinessEmptyState", () => {
  it("covers every state that is not a library", () => {
    const states = new Set(
      Object.values(cases).map((item) => item.readiness.state),
    );
    expect([...states].sort()).toEqual(Object.keys(covered).sort());
  });

  it.each(Object.entries(cases))(
    "tells the owner what to do (%s)",
    (_name, item) => {
      renderState(emptyView(item.readiness, item.computer));

      const empty = region(item.title);
      expect(
        within(empty).getByRole("heading", { level: 2 }),
      ).toHaveTextContent(item.title);
      expect(empty).toHaveTextContent(item.owner.body);
      if (item.owner.commands)
        expect(codeBlocks(empty)).toEqual(item.owner.commands);
      for (const name of item.owner.buttons ?? [])
        expect(within(empty).getByRole("button", { name })).toBeVisible();
      expect(
        within(empty)
          .queryAllByRole("link")
          .map((link) => link.textContent),
      ).toEqual(item.owner.links);
      expectSafeLinks(empty);
      expect(empty).not.toHaveTextContent(/slower|system RAM/);
      // The diagnostic detail sits only in the collapsed Technical details.
      const details = empty.querySelector("details");
      expect(details).not.toBeNull();
      expect(details!.open).toBe(false);
      expect(within(details!).getByText("raw tool output")).toBeInTheDocument();
      expect(within(empty).getAllByText(/raw tool output/).length).toBe(1);
    },
  );

  it.each(Object.entries(cases))(
    "gives anyone but the owner no commands, buttons, links or detail (%s)",
    (_name, item) => {
      renderState(
        emptyView(item.readiness, item.computer, { viewer_is_owner: false }),
      );

      const empty = region(item.title);
      if (item.ask)
        expect(empty).toHaveTextContent(
          `Only Ada Owner can set up local models on lab-118. Ask them to ${item.ask}.`,
        );
      else expect(empty).toHaveTextContent(item.owner.body);
      expect(codeBlocks(empty)).toEqual([]);
      expect(within(empty).queryAllByRole("link")).toEqual([]);
      expect(within(empty).queryAllByRole("button")).toEqual([]);
      expect(within(empty).queryAllByRole("tab")).toEqual([]);
      expect(empty).not.toHaveTextContent("raw tool output");
      expect(empty.querySelector("details")).toBeNull();
    },
  );

  it("offers the three install kinds when the Computer never said how it was installed", () => {
    renderState(emptyView({ reason: "HARDWARE_UNKNOWN", state: "not_set_up" }));

    const tabs = screen.getByRole("tablist", { name: "How it was installed" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Desktop app", "Terminal", "Container"]);
    expect(
      screen.getByRole("tabpanel", { name: "Terminal" }),
    ).toHaveTextContent("Follow the CLI setup steps on lab-118");

    fireEvent.click(within(tabs).getByRole("tab", { name: "Container" }));
    const container = screen.getByRole("tabpanel", { name: "Container" });
    expect(container).toHaveTextContent("lab-118 runs in a container.");
    expect(
      within(container)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["CLI setup", "GPU passthrough"]);

    fireEvent.click(within(tabs).getByRole("tab", { name: "Desktop app" }));
    expect(
      screen.getByRole("tabpanel", { name: "Desktop app" }),
    ).toHaveTextContent("On lab-118, open the Linger app");
  });

  it("shows the enable command in a tab once the Computer's release has it", () => {
    renderState(
      emptyView({
        enable_command: true,
        reason: "HARDWARE_UNKNOWN",
        state: "not_set_up",
      }),
    );

    expect(
      codeBlocks(screen.getByRole("tabpanel", { name: "Terminal" })),
    ).toEqual([`${cli} local-models enable`]);
  });

  it("opens the desktop app's setup on its own Computer", async () => {
    const setup = vi.fn(() => Promise.resolve());
    (window as { lingerDesktop?: unknown }).lingerDesktop = {
      computer: {
        enroll: () => Promise.reject(new Error("not used")),
        getStatus: () =>
          Promise.resolve({
            activeOperations: 0,
            bridge: "connected",
            computerId: "computer-lab",
            runtime: "ready",
          }),
        onStatus: () => () => undefined,
      },
      localModels: { setup },
    };
    renderState(
      emptyView(
        { reason: "SETUP_AVAILABLE", state: "not_set_up" },
        { accelerators: nvidiaHost, install_kind: "desktop" },
      ),
    );

    const empty = await screen.findByRole("region", {
      name: "Set up local models on lab-118",
    });
    expect(empty).toHaveTextContent(
      "Run AI models on this computer's NVIDIA L40S.",
    );
    fireEvent.click(
      within(empty).getByRole("button", { name: "Set up local models" }),
    );
    expect(setup).toHaveBeenCalledOnce();
  });

  it("names Apple silicon as the GPU of a Mac's desktop setup", async () => {
    (window as { lingerDesktop?: unknown }).lingerDesktop = {
      computer: {
        enroll: () => Promise.reject(new Error("not used")),
        getStatus: () =>
          Promise.resolve({
            activeOperations: 0,
            bridge: "connected",
            computerId: "computer-lab",
            runtime: "ready",
          }),
        onStatus: () => () => undefined,
      },
      localModels: { setup: () => Promise.resolve() },
    };
    renderState(
      emptyView(
        { reason: "SETUP_AVAILABLE", state: "not_set_up" },
        {
          accelerators: {
            apple_silicon: true,
            gpus: [],
            probe: "ok",
            ram_total_bytes: gb(64),
            unified_memory_bytes: gb(64),
          },
          install_kind: "desktop",
          platform: "darwin",
        },
      ),
    );

    expect(
      await screen.findByText(
        /Run AI models on this computer's Apple silicon\./,
      ),
    ).toBeVisible();
  });

  it("keeps the desktop setup button off a desktop app that has no setup", async () => {
    (window as { lingerDesktop?: unknown }).lingerDesktop = {
      computer: {
        enroll: () => Promise.reject(new Error("not used")),
        getStatus: () =>
          Promise.resolve({
            activeOperations: 0,
            bridge: "connected",
            computerId: "computer-lab",
            runtime: "ready",
          }),
        onStatus: () => () => undefined,
      },
    };
    renderState(
      emptyView(
        { reason: "SETUP_AVAILABLE", state: "not_set_up" },
        { install_kind: "desktop" },
      ),
    );

    const empty = screen.getByRole("region", {
      name: "Local models aren't set up on lab-118",
    });
    await waitFor(() => expect(empty).toHaveTextContent("open the Linger app"));
    expect(within(empty).queryByRole("button")).toBeNull();
  });

  it("asks the Computer to check again", async () => {
    const { refreshes } = renderState(
      emptyView(
        { reason: "TOOL_FAILED", state: "needs_attention" },
        {},
        { reason: { code: "TOOL_FAILED" } },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(refreshes).toEqual(["computer-lab"]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a refused check as copy for its code", async () => {
    const { runtime } = renderState(
      emptyView(
        { reason: "TOOL_FAILED", state: "needs_attention" },
        {},
        { reason: { code: "TOOL_FAILED" } },
      ),
    );
    runtime.server.on("POST", refreshPath, () =>
      teamHubErrorResponse(503, "LOCAL_COMPUTER_OFFLINE"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The computer is offline. Reconnect it in Computers, then try again.",
    );
  });

  it("turns Check again off while the Computer is offline", () => {
    renderState(
      emptyView(
        { reason: "TOOL_FAILED", state: "needs_attention" },
        { status: "offline" },
        { observed_at: "2026-11-18T08:00:00Z" },
      ),
    );

    expect(screen.getByRole("button", { name: "Check again" })).toBeDisabled();
  });

  it("opens the Computer that serves the models", async () => {
    renderState(
      emptyView(
        { state: "managed_elsewhere" },
        { managed_by: { computer_id: "computer-gpu", label: "GPU server" } },
      ),
    );

    fireEvent.click(screen.getByRole("link", { name: "Open GPU server" }));
    expect(
      await screen.findByText("Address search: ?computer=computer-gpu"),
    ).toBeVisible();
  });

  it("says only that an offline Computer without a report is offline", async () => {
    renderState(
      emptyView(
        { reason: "NOT_REPORTED", state: "not_reported" },
        { status: "offline" },
        { observed_at: undefined, reason: { code: "NOT_REPORTED" } },
      ),
    );

    const empty = region("lab-118 is offline");
    expect(empty).toHaveTextContent(
      "Its local models show here once it reconnects.",
    );
    fireEvent.click(within(empty).getByRole("link", { name: "Computers" }));
    expect(await screen.findByText("Computers page")).toBeVisible();
  });

  it("shows a spinner while the Computer is being checked", () => {
    renderState(
      emptyView(
        { state: "checking" },
        {},
        { reason: { code: "NOT_REPORTED" } },
      ),
    );

    expect(
      within(region("Checking local models on lab-118")).getByRole("status"),
    ).toHaveTextContent("Checking");
    expect(codeBlocks(document.body)).toEqual([]);
  });
});
