import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { localComputersQueryKey } from "@/features/local-computer/local-computer-queries";
import { localModelsQueryKey } from "@/features/local-models/local-models-queries";
import { labView } from "@/features/local-models/local-models-test-support";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import type {
  TeamHubLocalComputerPage,
  TeamHubTenantAgent,
  TeamHubTenantAgentUpdateInput,
} from "@/features/teamhub/teamhub-types";

import { DirectAgentModelSwitch } from "./direct-agent-model-switch";

const runtimeModels = [
  {
    allowed_reasoning_effort: ["low", "medium", "high"],
    id: "gpt-5.4",
    label: "5.4 Sol",
  },
  {
    allowed_reasoning_effort: ["low", "high"],
    id: "gpt-5.4-luna",
    label: "5.4 Luna",
  },
];

describe("Direct Agent runtime settings", () => {
  it("hides the entry from another Agent sponsor", () => {
    renderSwitch({ currentActorId: "someone-else" });
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("keeps one summary entry and saves only after confirming the full dialog", async () => {
    const updateTenantAgent = vi.fn(({ body }: { body: unknown }) => ({
      ...localAgent(),
      runtime: (body as TeamHubTenantAgentUpdateInput).runtime!,
      configuration_revision: 5,
    }));
    renderSwitch({ updateTenantAgent });
    fireEvent.click(
      await screen.findByRole("button", { name: "5.4 Sol Medium" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Runtime settings" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Agent runtime" }),
    ).toHaveTextContent("Codex");
    fireEvent.click(screen.getByRole("combobox", { name: "Agent model" }));
    fireEvent.click(await screen.findByRole("option", { name: "5.4 Luna" }));
    fireEvent.click(
      screen.getByRole("combobox", { name: "Agent reasoning effort" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "High" }));
    expect(updateTenantAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save Runtime" }));
    await waitFor(() =>
      expect(updateTenantAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { tenantId: "tenant-northstar", agentId: "actor-sol" },
          body: {
            expected_configuration_revision: 4,
            runtime: {
              model: "gpt-5.4-luna",
              reasoning_effort: "high",
              placement: {
                type: "local",
                computer_id: "computer-1",
                workspace_grant_id: "grant-1",
                runtime_type: "codex",
              },
            },
          },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("keeps the effort outside the model label that shortens", async () => {
    renderSwitch({});
    const trigger = await screen.findByRole("button", {
      name: "5.4 Sol Medium",
    });
    const label = within(trigger).getByText("5.4 Sol");
    expect(label).toHaveClass("agent-model-switch-trigger-label");
    expect(label).not.toHaveTextContent("Medium");
    expect(within(trigger).getByText("Medium")).toHaveClass(
      "agent-model-switch-trigger-effort",
    );
  });
  it("allows inspecting while busy but disables saving", async () => {
    const updateTenantAgent = vi.fn();
    renderSwitch({ updateTenantAgent, busy: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "5.4 Sol Medium" }),
    );
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(updateTenantAgent).not.toHaveBeenCalled();
  });

  it("resolves a human-readable model name from Local models when Pi does not list it yet", async () => {
    const localModelsHandler = vi.fn(() => labView());
    renderSwitch({
      computersHandler: () => ({
        items: [
          {
            computer_id: "computer-1",
            display_name: "Computer",
            status: "online",
            upgrade_required: false,
            active_operations: 0,
            runtimes: [{ type: "pi", status: "ready", models: [] }],
            workspace_grants: [
              {
                grant_id: "grant-1",
                label: "Workspace",
                mode: "workspace-write",
              },
            ],
          },
        ],
      }),
      localModelsHandler,
      registration: piLocalModelAgent(),
    });
    expect(
      await screen.findByRole("button", { name: "Qwen3 Coder 30B Medium" }),
    ).toBeVisible();
    expect(localModelsHandler).toHaveBeenCalledTimes(1);
  });

  it("prefers Pi's runtime model label when present in cache and skips Local models", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const computers: TeamHubLocalComputerPage = {
      items: [
        {
          computer_id: "computer-1",
          display_name: "Computer",
          status: "online",
          upgrade_required: false,
          active_operations: 0,
          runtimes: [
            {
              type: "pi",
              status: "ready",
              models: [
                {
                  id: "localmodels-library/qwen3-coder-30b",
                  label: "Qwen3 Coder 30B (Pi)",
                },
              ],
            },
          ],
          workspace_grants: [
            {
              grant_id: "grant-1",
              label: "Workspace",
              mode: "workspace-write",
            },
          ],
        },
      ],
    };
    queryClient.setQueryData(
      localComputersQueryKey("tenant-northstar"),
      computers,
    );
    const localModelsHandler = vi.fn(() => labView());
    renderSwitch({
      computersHandler: () => computers,
      localModelsHandler,
      queryClient,
      registration: piLocalModelAgent(),
    });
    expect(
      await screen.findByRole("button", {
        name: "Qwen3 Coder 30B (Pi) Medium",
      }),
    ).toBeVisible();
    expect(localModelsHandler).not.toHaveBeenCalled();
  });

  it("reads cached Local models immediately while Local Computers are still loading", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      localModelsQueryKey("tenant-northstar", "computer-1"),
      labView(),
    );
    renderSwitch({
      computersHandler: () => new Promise(() => {}),
      localModelsHandler: () => new Promise(() => {}),
      queryClient,
      registration: piLocalModelAgent(),
    });
    expect(
      await screen.findByRole("button", { name: "Qwen3 Coder 30B Medium" }),
    ).toBeVisible();
  });

  it("does not request Local models for non-localmodels-library models", async () => {
    const localModelsHandler = vi.fn(() => labView());
    renderSwitch({ localModelsHandler });
    expect(
      await screen.findByRole("button", { name: "5.4 Sol Medium" }),
    ).toBeVisible();
    expect(localModelsHandler).not.toHaveBeenCalled();
  });

  it("opens the full dialog directly when only the active local model exists", async () => {
    renderSwitch({
      computersHandler: () => ({
        items: [
          {
            computer_id: "computer-1",
            display_name: "Computer",
            status: "online",
            upgrade_required: false,
            active_operations: 0,
            runtimes: [
              {
                type: "pi",
                status: "ready",
                models: [
                  {
                    id: "localmodels-library/qwen3-coder-30b",
                    label: "Qwen3 Coder 30B",
                  },
                ],
              },
            ],
            workspace_grants: [
              {
                grant_id: "grant-1",
                label: "Workspace",
                mode: "workspace-write",
              },
            ],
          },
        ],
      }),
      localModelsHandler: () => labView(),
      registration: piLocalModelAgent(),
    });
    const trigger = await screen.findByRole("button", {
      name: "Qwen3 Coder 30B Medium",
    });
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-haspopup", "dialog"),
    );
    fireEvent.click(trigger);
    expect(
      await screen.findByRole("dialog", { name: "Runtime settings" }),
    ).toBeVisible();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("quick-switches to an alternative loaded local model in one click without opening the full dialog", async () => {
    const updateTenantAgent = vi.fn(({ body }: { body: unknown }) => ({
      ...piLocalModelAgent(),
      runtime: (body as TeamHubTenantAgentUpdateInput).runtime!,
      configuration_revision: 5,
    }));
    renderSwitch({
      computersHandler: () => ({
        items: [
          {
            computer_id: "computer-1",
            display_name: "Lab Box",
            status: "online",
            upgrade_required: false,
            active_operations: 0,
            runtimes: [
              {
                type: "pi",
                status: "ready",
                models: [
                  {
                    id: "localmodels-library/qwen3-coder-30b",
                    label: "Qwen3 Coder 30B",
                  },
                  {
                    id: "localmodels-library/qwen3.6-35b-a3b",
                    label: "Qwen3.6 35B-A3B",
                  },
                ],
              },
            ],
            workspace_grants: [
              {
                grant_id: "grant-1",
                label: "Workspace",
                mode: "workspace-write",
              },
            ],
          },
        ],
      }),
      localModelsHandler: () => labView(),
      registration: piLocalModelAgent(),
      updateTenantAgent,
    });

    const trigger = await screen.findByRole("button", {
      name: "Qwen3 Coder 30B Medium",
    });
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-haspopup", "menu"),
    );
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", {
      name: "Switch local model",
    });
    expect(
      within(menu).getByRole("menuitem", { name: "Qwen3 Coder 30B" }),
    ).toBeDisabled();
    const targetOption = within(menu).getByRole("menuitem", {
      name: "Qwen3.6 35B-A3B",
    });
    expect(targetOption).toBeEnabled();
    fireEvent.click(targetOption);

    await waitFor(() =>
      expect(updateTenantAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { tenantId: "tenant-northstar", agentId: "actor-sol" },
          body: {
            expected_configuration_revision: 4,
            runtime: {
              model: "localmodels-library/qwen3.6-35b-a3b",
              reasoning_effort: "medium",
              placement: {
                type: "local",
                computer_id: "computer-1",
                runtime_type: "pi",
                workspace_grant_id: "grant-1",
              },
            },
          },
        }),
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows computer names across multiple machines, handles Runtime settings, and exposes Manage local models inside a router", async () => {
    renderSwitch({
      computersHandler: () => ({
        items: [
          {
            computer_id: "computer-1",
            display_name: "Studio Mac",
            status: "online",
            upgrade_required: false,
            active_operations: 0,
            runtimes: [
              { type: "codex", status: "ready", models: runtimeModels },
              {
                type: "pi",
                status: "ready",
                models: [
                  {
                    id: "localmodels-library/qwen3-coder-30b",
                    label: "Qwen3 Coder 30B",
                  },
                ],
              },
            ],
            workspace_grants: [
              {
                grant_id: "grant-1",
                label: "Workspace",
                mode: "workspace-write",
              },
            ],
          },
          {
            computer_id: "computer-2",
            display_name: "cdd-use",
            status: "online",
            upgrade_required: false,
            active_operations: 0,
            runtimes: [
              {
                type: "pi",
                status: "ready",
                models: [
                  {
                    id: "localmodels-library/qwen3.6-35b-a3b",
                    label: "Qwen3.6 35B-A3B",
                  },
                ],
              },
            ],
            workspace_grants: [
              {
                grant_id: "grant-2",
                label: "Workspace",
                mode: "workspace-write",
              },
            ],
          },
        ],
      }),
      withRouter: true,
    });

    const trigger = await screen.findByRole("button", {
      name: "5.4 Sol Medium",
    });
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-haspopup", "menu"),
    );
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", {
      name: "Switch local model",
    });
    expect(
      within(menu).getByRole("menuitem", {
        name: /Qwen3 Coder 30B.*Studio Mac/,
      }),
    ).toBeVisible();
    expect(
      within(menu).getByRole("menuitem", { name: /Qwen3\.6 35B-A3B.*cdd-use/ }),
    ).toBeVisible();
    expect(
      within(menu).getByRole("menuitem", { name: "Manage local models…" }),
    ).toHaveAttribute(
      "href",
      "/t/tenant-northstar/settings/local-models?computer=computer-1",
    );

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Runtime settings…" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Runtime settings" }),
    ).toBeVisible();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disables quick-switch options when busy while keeping Runtime settings accessible", async () => {
    const updateTenantAgent = vi.fn();
    renderSwitch({
      busy: true,
      computersHandler: () => ({
        items: [
          {
            computer_id: "computer-1",
            display_name: "Computer",
            status: "online",
            upgrade_required: false,
            active_operations: 0,
            runtimes: [
              { type: "codex", status: "ready", models: runtimeModels },
              {
                type: "pi",
                status: "ready",
                models: [
                  {
                    id: "localmodels-library/qwen3-coder-30b",
                    label: "Qwen3 Coder 30B",
                  },
                ],
              },
            ],
            workspace_grants: [
              {
                grant_id: "grant-1",
                label: "Workspace",
                mode: "workspace-write",
              },
            ],
          },
        ],
      }),
      updateTenantAgent,
    });

    const trigger = await screen.findByRole("button", {
      name: "5.4 Sol Medium",
    });
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-haspopup", "menu"),
    );
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", {
      name: "Switch local model",
    });
    expect(within(menu).getByText("Wait for reply to finish")).toBeVisible();
    const modelOption = within(menu).getByRole("menuitem", {
      name: "Qwen3 Coder 30B",
    });
    expect(modelOption).toBeDisabled();
    fireEvent.click(modelOption);
    expect(updateTenantAgent).not.toHaveBeenCalled();

    const runtimeSettingsItem = within(menu).getByRole("menuitem", {
      name: "Runtime settings…",
    });
    expect(runtimeSettingsItem).toBeEnabled();
    fireEvent.click(runtimeSettingsItem);
    expect(
      await screen.findByRole("dialog", { name: "Runtime settings" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
  });

  it("surfaces PATCH failures after quick-switching and clears on Escape", async () => {
    renderSwitch({
      computersHandler: () => ({
        items: [
          {
            computer_id: "computer-1",
            display_name: "Computer",
            status: "online",
            upgrade_required: false,
            active_operations: 0,
            runtimes: [
              { type: "codex", status: "ready", models: runtimeModels },
              {
                type: "pi",
                status: "ready",
                models: [
                  {
                    id: "localmodels-library/qwen3-coder-30b",
                    label: "Qwen3 Coder 30B",
                  },
                ],
              },
            ],
            workspace_grants: [
              {
                grant_id: "grant-1",
                label: "Workspace",
                mode: "workspace-write",
              },
            ],
          },
        ],
      }),
      updateTenantAgent: () =>
        teamHubErrorResponse(409, "AGENT_BUSY", "Agent is busy right now."),
    });

    const trigger = await screen.findByRole("button", {
      name: "5.4 Sol Medium",
    });
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-haspopup", "menu"),
    );
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Qwen3 Coder 30B" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent is busy right now.",
    );
  });
});

function renderSwitch({
  busy = false,
  computersHandler,
  currentActorId = "actor-jenny",
  localModelsHandler,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
  registration = localAgent(),
  updateTenantAgent = vi.fn(),
  withRouter = false,
}: {
  busy?: boolean;
  computersHandler?: TestRouteHandler;
  currentActorId?: string;
  localModelsHandler?: TestRouteHandler;
  queryClient?: QueryClient;
  registration?: TeamHubTenantAgent;
  updateTenantAgent?: TestRouteHandler;
  withRouter?: boolean;
}) {
  const runtime = createTestTeamHubRuntime();
  runtime.server.on(
    "PATCH",
    "/v0/tenants/{tenantId}/agents/{agentId}",
    updateTenantAgent,
  );
  runtime.server.on(
    "GET",
    "/v0/tenants/{tenantId}/local-computers",
    computersHandler ??
      (() => ({
        items: [
          {
            computer_id: "computer-1",
            display_name: "Computer",
            status: "online",
            runtimes: [
              { type: "codex", status: "ready", models: runtimeModels },
            ],
            workspace_grants: [
              {
                grant_id: "grant-1",
                label: "Workspace",
                mode: "workspace-write",
              },
            ],
          },
        ],
      })),
  );
  if (localModelsHandler) {
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models",
      localModelsHandler,
    );
  }
  const content = (
    <QueryClientProvider client={queryClient}>
      <DirectAgentModelSwitch
        busy={busy}
        client={runtime.client}
        currentActorId={currentActorId}
        registration={registration}
        tenantId="tenant-northstar"
      />
    </QueryClientProvider>
  );
  render(withRouter ? <MemoryRouter>{content}</MemoryRouter> : content);
}

function piLocalModelAgent(): TeamHubTenantAgent {
  const base = localAgent();
  return {
    ...base,
    runtime: {
      model: "localmodels-library/qwen3-coder-30b",
      placement: {
        type: "local",
        computer_id: "computer-1",
        workspace_grant_id: "grant-1",
        runtime_type: "pi",
      },
      reasoning_effort: "medium",
    },
  };
}

function localAgent(): TeamHubTenantAgent {
  const timestamp = "2026-09-22T08:00:00Z";
  return {
    actor: {
      created_at: timestamp,
      display_name: "Sol",
      handle: "@sol",
      id: "actor-sol",
      kind: "agent",
      tenant_id: "tenant-northstar",
    },
    agent_management_id: "agent-sol",
    agent_type: "general",
    configuration_revision: 4,
    created_at: timestamp,
    created_by: {
      display_name: "Jenny",
      id: "actor-jenny",
      kind: "human",
      tenant_id: "tenant-northstar",
    },
    description: "",
    instructions: "",
    runtime: {
      model: "gpt-5.4",
      placement: {
        type: "local",
        computer_id: "computer-1",
        workspace_grant_id: "grant-1",
        runtime_type: "codex",
      },
      reasoning_effort: "medium",
    },
    skill_bindings: [],
    updated_at: timestamp,
    visibility_scope: "sponsor",
  };
}
