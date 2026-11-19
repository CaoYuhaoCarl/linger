import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TeamHubEventSync } from "@/features/rooms/event-sync";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import {
  acceptTenantAgentUpdates,
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { LocalModelsPage } from "./local-models-page";
import type { LocalModelsView } from "./local-models-queries";
import { localModelsComputerStorageKey } from "./local-models-rules";
import {
  gb,
  gpuPool,
  labView,
  localModel,
  macView,
  modelView,
} from "./local-models-test-support";

const tenantId = "tenant-northstar";
const viewPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models";
const actionPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/{modelId}/actions";

type InventoryComputer = TeamHubLocalComputerPage["items"][number];

interface Fixture {
  actions: { body: unknown; computerId: string; modelId: string }[];
  runtime: TestTeamHubRuntime;
  views: Record<string, LocalModelsView>;
}

function setup(
  views: LocalModelsView[] = [labView(), macView()],
  inventory?: InventoryComputer[],
): Fixture {
  const runtime = createTestTeamHubRuntime();
  const template = runtime.seed.localComputers[0]!;
  runtime.seed.localComputers =
    inventory ??
    views.map((view) => ({
      ...template,
      computer_id: view.computer.computer_id,
      display_name: view.computer.display_name,
      status: view.computer.status,
    }));
  const fixture: Fixture = {
    actions: [],
    runtime,
    views: Object.fromEntries(
      views.map((view) => [view.computer.computer_id, view]),
    ),
  };
  runtime.server
    .on("GET", viewPath, ({ params }) => {
      const view = fixture.views[params.computerId!];
      return view ?? teamHubErrorResponse(404, "LOCAL_COMPUTER_NOT_FOUND");
    })
    .on("POST", actionPath, ({ body, params }) => {
      fixture.actions.push({
        body,
        computerId: params.computerId!,
        modelId: params.modelId!,
      });
      return Response.json(
        {
          action: (body as { action: string }).action,
          computer_id: params.computerId,
          model_id: params.modelId,
        },
        { status: 202 },
      );
    });
  return fixture;
}

function inventoryComputer(view: LocalModelsView): InventoryComputer {
  const template = createTestTeamHubRuntime().seed.localComputers[0]!;
  return {
    ...template,
    computer_id: view.computer.computer_id,
    display_name: view.computer.display_name,
    status: view.computer.status,
  };
}

function CurrentSearch() {
  return <p>Address search: {useLocation().search}</p>;
}

function ChatDestination() {
  const location = useLocation();
  return (
    <p>
      Chat route: {location.pathname}|{JSON.stringify(location.state ?? null)}
    </p>
  );
}

function renderPage(fixture: Fixture, search = "") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={fixture.runtime}>
        <TeamHubEventSync />
        <MemoryRouter
          initialEntries={[`/t/${tenantId}/settings/local-models${search}`]}
        >
          <Suspense fallback={<p>Loading page</p>}>
            <Routes>
              <Route
                element={
                  <>
                    <LocalModelsPage />
                    <CurrentSearch />
                  </>
                }
                path="/t/:tenantId/settings/local-models"
              />
              <Route
                element={<p>Computers page</p>}
                path="/t/:tenantId/settings/computers"
              />
              <Route
                element={<ChatDestination />}
                path="/t/:tenantId/rooms/:roomId/chat"
              />
            </Routes>
          </Suspense>
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

function cards() {
  return within(screen.getByRole("region", { name: "Models" })).getAllByRole(
    "article",
  );
}

function card(name: string) {
  return cards().find(
    (item) => within(item).queryByRole("button", { name }) !== null,
  )!;
}

/** Each card as "name: status line", in page order. */
function statuses() {
  return cards().map((item) => {
    const toggle = within(item).getAllByRole("button")[0]!;
    const name = toggle.getAttribute("aria-label")!;
    return `${name}: ${toggle.textContent.slice(name.length)}`;
  });
}

async function findModels() {
  return screen.findByRole("region", { name: "Models" });
}

function publishSnapshot(fixture: Fixture, view: LocalModelsView) {
  fixture.views[view.computer.computer_id] = view;
  fixture.runtime.events.emitSignal({
    hint: {
      id: view.computer.computer_id,
      resource: "local-models",
      tenant_id: tenantId,
    },
    type: "resource.invalidated",
  });
}

/** One card's status line, without its model name. */
function statusOf(name: string) {
  return statuses()
    .find((line) => line.startsWith(`${name}: `))!
    .slice(name.length + 2);
}

/**
 * Holds every action request until the returned function answers it with
 * respond(), as a Computer that takes a while to decide.
 */
function holdActions(fixture: Fixture, respond: () => Response) {
  const held: (() => void)[] = [];
  fixture.runtime.server.on(
    "POST",
    actionPath,
    () => new Promise((resolve) => held.push(() => resolve(respond()))),
  );
  return () => {
    for (const release of held.splice(0)) release();
  };
}

function accepted(action: string) {
  return Response.json(
    { action, computer_id: "computer-lab", model_id: "held" },
    { status: 202 },
  );
}

function withModel(
  view: LocalModelsView,
  modelId: string,
  fields: Partial<LocalModelsView["models"][number]["model"]>,
): LocalModelsView {
  return {
    ...view,
    models: view.models.map((item) =>
      item.model.id === modelId
        ? { ...item, model: { ...item.model, ...fields } }
        : item,
    ),
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as { lingerDesktop?: unknown }).lingerDesktop;
});

describe("LocalModelsPage", () => {
  it("lists every model once with its status, as the Computer reported it", async () => {
    renderPage(setup());
    await findModels();

    expect(statuses()).toEqual([
      "Qwen3 Coder 30B: Loaded · GPU 0 · 21.4 GB",
      "Gemma 3 27B: Downloaded",
      "GPT-OSS 20B: Not downloaded · 12.1 GB · Recommended",
      "Gemma 3 4B: Not downloaded · 3.3 GB",
      "Llama 3.3 70B: Not downloaded · 42.5 GB · runs slower",
      "Llama 3.1 405B: Can't download · needs 230 GB",
    ]);
    expect(
      screen.getByText("22.5 GB of 48 GB GPU memory in use"),
    ).toBeVisible();
    expect(screen.queryByText("Sample data")).not.toBeInTheDocument();
    // A model that can't be downloaded has no action, only its toggle.
    expect(within(card("Llama 3.1 405B")).getAllByRole("button")).toHaveLength(
      1,
    );
  });

  it("marks the model the Computer recommends, whatever its fit", async () => {
    // localmodels recommends what its stack would install: on a small Mac a
    // ladder model, on a small card a fallback that runs from system memory.
    const absent = (
      id: string,
      name: string,
      fit: "system" | "unified",
      recommended: boolean,
    ) =>
      modelView(
        localModel({
          download_bytes: gb(2.6),
          family: "other",
          fit,
          id,
          name,
          pool: fit === "system" ? "system" : "unified",
          recommended,
        }),
      );
    const fixture = setup([
      macView({
        models: [
          absent("lfm3-1.7b:Q8_0", "LFM3 1.7B", "unified", false),
          absent("spark-x2.6-4b:Q4_K_M", "Spark-X2.6 4B", "unified", true),
        ],
      }),
      labView({
        computer: { ...labView().computer, computer_id: "computer-win" },
        models: [absent("qwen3.5-9b:Q4_K_M", "Qwen3.5 9B", "system", true)],
      }),
    ]);
    renderPage(fixture, "?computer=computer-mac");
    await findModels();
    expect(statuses()).toEqual([
      "Spark-X2.6 4B: Not downloaded · 2.6 GB · Recommended",
      "LFM3 1.7B: Not downloaded · 2.6 GB",
    ]);

    cleanup();
    renderPage(fixture, "?computer=computer-win");
    await waitFor(() =>
      expect(statuses()).toEqual([
        "Qwen3.5 9B: Not downloaded · 2.6 GB · Recommended",
      ]),
    );
  });

  it("expands one row at a time to show a model's details", async () => {
    renderPage(setup());
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    const details = screen.getByRole("region", {
      name: "Qwen3 Coder 30B details",
    });
    expect(details).toHaveTextContent("21.4 GB on GPU 0 · RTX 4090");
    expect(details).toHaveTextContent("Research agent, Code reviewer");
    expect(details).toHaveTextContent("http://127.0.0.1:18100/v1");
    expect(details).toHaveTextContent("46 tokens/s");
    expect(details).toHaveTextContent("128K tokens");

    fireEvent.click(screen.getByRole("button", { name: "Llama 3.1 405B" }));
    expect(
      screen.queryByRole("region", { name: "Qwen3 Coder 30B details" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Llama 3.1 405B details" }),
    ).toHaveTextContent(
      "Needs 230 GB of memory; this computer has 102.4 GB for models.",
    );
  });

  it("shows the Computer's pools and hardware in Details", async () => {
    renderPage(setup());
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: "lab-118 details" });
    expect(
      within(dialog).getByRole("img", {
        name: "GPU 0 · RTX 4090: 21.4 GB of 24 GB in use",
      }),
    ).toBeVisible();
    // A foundation component holds memory but is not a model row.
    expect(dialog).toHaveTextContent("Qwen3 Embedding");
    expect(dialog).toHaveTextContent("Ubuntu 24.04 · llama.cpp b11370 · CUDA");
    expect(dialog).toHaveTextContent("412 GB");
  });

  it("shows memory other apps use in a pool's bar", async () => {
    const shared = gpuPool(0, 24, [{ gb: 4, id: "small", name: "Small" }]);
    // Another process holds 15 GB of the card next to the model.
    renderPage(
      setup([labView({ pools: [{ ...shared, used_bytes: gb(19) }] })]),
    );
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: "lab-118 details" });
    expect(within(dialog).getByTitle("Other apps · 15 GB")).toHaveStyle({
      width: "62.5%",
    });
    expect(within(dialog).getByTitle("Small · 4 GB")).toHaveStyle({
      width: `${(4 / 24) * 100}%`,
    });
  });

  it("downloads on click and follows the snapshots the Computer sends", async () => {
    const fixture = setup();
    renderPage(fixture);
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Download GPT-OSS 20B" }),
    );
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "download" },
          computerId: "computer-lab",
          modelId: "gpt-oss-20b:Q4_K_M",
        },
      ]),
    );

    publishSnapshot(
      fixture,
      withModel(labView(), "gpt-oss-20b:Q4_K_M", {
        download: { done_bytes: 32, step: "download", total_bytes: 100 },
        state: "downloading",
      }),
    );
    await waitFor(() =>
      expect(statuses()).toContain("GPT-OSS 20B: Downloading · 32%"),
    );
    expect(
      screen.getByRole("progressbar", {
        name: "GPT-OSS 20B download progress",
      }),
    ).toHaveAttribute("aria-valuenow", "32");

    publishSnapshot(
      fixture,
      withModel(labView(), "gpt-oss-20b:Q4_K_M", {
        download: { done_bytes: 100, step: "verify", total_bytes: 100 },
        state: "downloading",
      }),
    );
    await waitFor(() =>
      expect(statuses()).toContain("GPT-OSS 20B: Downloading · checking file"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel GPT-OSS 20B" }));
    await waitFor(() =>
      expect(fixture.actions.at(-1)?.body).toEqual({ action: "cancel" }),
    );

    publishSnapshot(
      fixture,
      withModel(labView(), "gpt-oss-20b:Q4_K_M", {
        note: { code: "NO_ROOM_TO_LOAD" },
        state: "idle",
      }),
    );
    await waitFor(() =>
      expect(statuses()).toContain(
        "GPT-OSS 20B: Downloaded · no room to load yet",
      ),
    );
  });

  it.each(["DOWNLOAD_FAILED", "NETWORK_UNAVAILABLE"] as const)(
    "resumes a download that stopped with %s instead of loading it",
    async (code) => {
      const fixture = setup([
        withModel(macView(), "llama3.3-70b:Q4_K_M", {
          error: { code, detail: "retries exhausted" },
        }),
      ]);
      renderPage(fixture);
      await findModels();

      expect(statusOf("Llama 3.3 70B")).toBe("Download stopped");
      expect(
        screen.queryByRole("button", { name: "Retry Llama 3.3 70B" }),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Resume download Llama 3.3 70B" }),
      );
      await waitFor(() =>
        expect(fixture.actions).toEqual([
          {
            body: { action: "download" },
            computerId: "computer-mac",
            modelId: "llama3.3-70b:Q4_K_M",
          },
        ]),
      );
    },
  );

  it("shows a resumed download as under way from the click", async () => {
    const fixture = setup([
      withModel(macView(), "llama3.3-70b:Q4_K_M", {
        error: { code: "DOWNLOAD_FAILED" },
      }),
    ]);
    const answer = holdActions(fixture, () => accepted("download"));
    renderPage(fixture);
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Resume download Llama 3.3 70B" }),
    );
    await waitFor(() =>
      expect(statusOf("Llama 3.3 70B")).toMatch(/^Downloading/),
    );
    answer();
  });

  it("discards a stopped download instead of removing it", async () => {
    const fixture = setup([
      withModel(macView(), "llama3.3-70b:Q4_K_M", {
        error: { code: "DOWNLOAD_FAILED" },
      }),
    ]);
    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Llama 3.3 70B" }));
    const details = screen.getByRole("region", {
      name: "Llama 3.3 70B details",
    });
    expect(details).toHaveTextContent("Last download");
    expect(
      within(details).queryByRole("button", { name: "Remove from computer" }),
    ).toBeNull();
    fireEvent.click(
      within(details).getByRole("button", { name: "Discard download" }),
    );
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "cancel" },
          computerId: "computer-mac",
          modelId: "llama3.3-70b:Q4_K_M",
        },
      ]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("retries a model that failed to load with a load and still offers Remove", async () => {
    const fixture = setup([
      withModel(macView(), "llama3.3-70b:Q4_K_M", {
        error: { code: "ENGINE_START_FAILED" },
        memory_bytes: gb(10),
      }),
    ]);
    renderPage(fixture);
    await findModels();

    expect(statusOf("Llama 3.3 70B")).toBe("Couldn't load");
    fireEvent.click(screen.getByRole("button", { name: "Llama 3.3 70B" }));
    const details = screen.getByRole("region", {
      name: "Llama 3.3 70B details",
    });
    expect(details).toHaveTextContent("Last load");
    expect(
      within(details).getByRole("button", { name: "Remove from computer" }),
    ).toBeEnabled();
    expect(
      within(details).queryByRole("button", { name: "Discard download" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "load" },
          computerId: "computer-mac",
          modelId: "llama3.3-70b:Q4_K_M",
        },
      ]),
    );
  });

  it("loads at once when the pool has room", async () => {
    const fixture = setup();
    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Gemma 3 27B" }));
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "load" },
          computerId: "computer-lab",
          modelId: "gemma3-27b:Q4_K_M",
        },
      ]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers to unload the model holding the memory before loading another", async () => {
    const fixture = setup();
    renderPage(fixture, "?computer=computer-mac");
    await findModels();

    expect(statuses()).toContain("Llama 3.3 70B: Couldn't load");
    fireEvent.click(screen.getByRole("button", { name: "Llama 3.3 70B" }));
    const details = screen.getByRole("region", {
      name: "Llama 3.3 70B details",
    });
    expect(details).toHaveTextContent(
      "There wasn't enough free memory to load it.",
    );
    // Diagnostic text from the Computer is never shown.
    expect(details).not.toHaveTextContent("need 46 GiB");

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    expect(dialog).toHaveTextContent(
      "Llama 3.3 70B needs 46 GB on Unified memory; 36.9 GB is free.",
    );
    const gptOss = within(dialog).getByRole("checkbox", {
      name: /GPT-OSS 20B/,
    });
    expect(gptOss).toBeChecked();
    expect(dialog).toHaveTextContent(
      "Another Me can't answer until their model is loaded again.",
    );

    fireEvent.click(gptOss);
    expect(within(dialog).getByRole("button", { name: "Load" })).toBeDisabled();
    fireEvent.click(gptOss);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unload and load" }),
    );

    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "load", unload_first: ["gpt-oss-20b:Q4_K_M"] },
          computerId: "computer-mac",
          modelId: "llama3.3-70b:Q4_K_M",
        },
      ]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says so when nothing else in the pool can be unloaded", async () => {
    const mac = macView();
    renderPage(
      setup([
        {
          ...mac,
          models: mac.models.slice(1),
          pools: [
            {
              ...mac.pools[0]!,
              holders: [],
              total_bytes: gb(40),
              used_bytes: 0,
            },
          ],
        },
      ]),
    );
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Make room to load" }),
    ).toHaveTextContent("Nothing else is loaded there.");
  });

  it("asks before unloading a model an Agent uses, and not otherwise", async () => {
    const fixture = setup();
    renderPage(fixture);
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Unload Qwen3 Coder 30B?",
    });
    expect(dialog).toHaveTextContent(
      "Research agent, Code reviewer use this model and can't answer until it is loaded again.",
    );
    expect(fixture.actions).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Unload" }));
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "unload" },
          computerId: "computer-lab",
          modelId: "qwen3-coder-30b:Q4_K_M",
        },
      ]),
    );

    publishSnapshot(fixture, {
      ...labView(),
      models: labView().models.map((item) => ({ ...item, used_by: [] })),
      observed_at: "2026-11-13T10:00:05.000Z",
    });
    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Qwen3 Coder 30B details" }),
      ).toHaveTextContent("No Agent yet"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(fixture.actions).toHaveLength(2));
  });

  it("warns which Agents lose their model before removing it", async () => {
    const fixture = setup();
    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    fireEvent.click(
      within(
        screen.getByRole("region", { name: "Qwen3 Coder 30B details" }),
      ).getByRole("button", { name: "Remove from computer" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Remove Qwen3 Coder 30B?",
    });
    expect(dialog).toHaveTextContent(
      "Unloads it, deletes its files and frees 18.6 GB of disk on lab-118.",
    );
    expect(dialog).toHaveTextContent(
      "Research agent, Code reviewer use this model and can't answer until you choose another model for them.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "remove" },
          computerId: "computer-lab",
          modelId: "qwen3-coder-30b:Q4_K_M",
        },
      ]),
    );
  });

  it("lists the Agents of a downloaded model and warns before removing it", async () => {
    const view = labView();
    // TeamHub matches Agents by pi_model, which a model keeps while idle.
    view.models[1] = {
      ...view.models[1]!,
      used_by: [{ agent_id: "agent-writer", name: "Writer" }],
    };
    const fixture = setup([view]);
    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Gemma 3 27B" }));
    const details = screen.getByRole("region", { name: "Gemma 3 27B details" });
    expect(details).toHaveTextContent("Used byWriter");
    fireEvent.click(
      within(details).getByRole("button", { name: "Remove from computer" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Remove Gemma 3 27B?" });
    expect(dialog).toHaveTextContent("Deletes its files");
    expect(dialog).toHaveTextContent(
      "Writer uses this model and can't answer until you choose another model for it.",
    );
  });

  it("opens a Computer the viewer may read but does not own", async () => {
    // The owned-Computer inventory is empty; the library API allows the read.
    const fixture = setup([labView({ viewer_is_owner: false })], []);
    renderPage(fixture, "?computer=computer-lab");
    await findModels();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Local models",
    );
    expect(
      screen.getByText(
        "Only the person who connected lab-118 can download, load or remove its models.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    ).toBeDisabled();
    expect(screen.getByText(/Address search:/)).toHaveTextContent(
      "?computer=computer-lab",
    );
  });

  it("keeps a shared Computer selected next to the viewer's own", async () => {
    const fixture = setup(
      [labView({ viewer_is_owner: false }), macView()],
      [inventoryComputer(macView())],
    );
    renderPage(fixture, "?computer=computer-lab");
    await findModels();

    // Not the viewer's own Mac: lab-118, read-only.
    expect(card("Qwen3 Coder 30B")).toBeVisible();
    expect(
      screen.getByText(
        "Only the person who connected lab-118 can download, load or remove its models.",
      ),
    ).toBeVisible();
  });

  it.each([
    ["Unload Qwen3 Coder 30B", "Unload Qwen3 Coder 30B?", "Unload"],
    ["Remove from computer", "Remove Qwen3 Coder 30B?", "Remove"],
  ])(
    "disables an open %s confirmation once the Computer goes offline",
    async (opener, title, confirm) => {
      const fixture = setup([labView()]);
      renderPage(fixture);
      await findModels();
      if (opener === "Remove from computer")
        fireEvent.click(
          screen.getByRole("button", { name: "Qwen3 Coder 30B" }),
        );
      fireEvent.click(screen.getByRole("button", { name: opener }));
      const dialog = await screen.findByRole("dialog", { name: title });

      publishSnapshot(
        fixture,
        labView({ computer: { ...labView().computer, status: "offline" } }),
      );
      await waitFor(() =>
        expect(
          within(dialog).getByRole("button", { name: confirm }),
        ).toBeDisabled(),
      );
      fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
      expect(fixture.actions).toEqual([]);
    },
  );

  it("disables an open Unload confirmation once the model is no longer loaded", async () => {
    const fixture = setup([labView()]);
    renderPage(fixture);
    await findModels();
    fireEvent.click(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Unload Qwen3 Coder 30B?",
    });

    publishSnapshot(
      fixture,
      withModel(labView(), "qwen3-coder-30b:Q4_K_M", {
        endpoint: undefined,
        state: "idle",
      }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Unload" }),
      ).toBeDisabled(),
    );
  });

  it("shows a load as under way from the click until a snapshot reflects it", async () => {
    const fixture = setup();
    const answer = holdActions(fixture, () => accepted("load"));
    let reads = 0;
    fixture.runtime.server.on("GET", viewPath, ({ params }) => {
      reads += 1;
      return fixture.views[params.computerId!];
    });
    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Gemma 3 27B" }));
    await waitFor(() => expect(statusOf("Gemma 3 27B")).toMatch(/^Loading/));
    const row = card("Gemma 3 27B");
    expect(
      within(row).queryByRole("button", { name: "Load Gemma 3 27B" }),
    ).toBeNull();
    expect(row.querySelector(".town-shimmer-text")).not.toBeNull();

    // Accepted, and the fresh read still carries the snapshot from before.
    const readsBefore = reads;
    answer();
    await waitFor(() => expect(reads).toBeGreaterThan(readsBefore));
    expect(statusOf("Gemma 3 27B")).toMatch(/^Loading/);

    publishSnapshot(
      fixture,
      withModel(labView(), "gemma3-27b:Q4_K_M", { state: "loaded" }),
    );
    await waitFor(() => expect(statusOf("Gemma 3 27B")).toMatch(/^Loaded/));
  });

  it("spins and disables the row's button while an unload is sent", async () => {
    const fixture = setup();
    const answer = holdActions(fixture, () => accepted("unload"));
    renderPage(fixture);
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Unload Qwen3 Coder 30B?" }),
      ).getByRole("button", { name: "Unload" }),
    );
    const unload = await screen.findByRole("button", {
      name: "Unload Qwen3 Coder 30B",
    });
    await waitFor(() => expect(unload).toHaveAttribute("aria-busy", "true"));
    expect(unload).toBeDisabled();

    answer();
    publishSnapshot(
      fixture,
      withModel(labView(), "qwen3-coder-30b:Q4_K_M", { state: "idle" }),
    );
    await waitFor(() =>
      expect(statusOf("Qwen3 Coder 30B")).toMatch(/^Downloaded/),
    );
    expect(
      screen.getByRole("button", { name: "Load Qwen3 Coder 30B" }),
    ).toBeEnabled();
  });

  it("puts the row back and explains when the Computer refuses", async () => {
    const fixture = setup();
    const answer = holdActions(fixture, () =>
      teamHubErrorResponse(409, "LOCAL_MODEL_NO_ROOM", "raw refusal detail"),
    );
    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Gemma 3 27B" }));
    await waitFor(() => expect(statusOf("Gemma 3 27B")).toMatch(/^Loading/));

    answer();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gemma 3 27B: There isn't enough free memory to load it. Unload another model first.",
    );
    expect(statusOf("Gemma 3 27B")).toMatch(/^Downloaded/);
    expect(
      screen.getByRole("button", { name: "Load Gemma 3 27B" }),
    ).toBeEnabled();
  });

  it("shows a refusal from the Computer as copy for its code", async () => {
    const fixture = setup();
    fixture.runtime.server.on("POST", actionPath, () =>
      teamHubErrorResponse(409, "LOCAL_MODEL_NO_ROOM", "raw refusal detail"),
    );
    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Gemma 3 27B" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gemma 3 27B: There isn't enough free memory to load it. Unload another model first.",
    );
    expect(screen.queryByText(/raw refusal detail/)).not.toBeInTheDocument();
  });

  it("shows what an offline Computer last reported with every action off", async () => {
    renderPage(
      setup([
        labView({
          computer: {
            ...labView().computer,
            last_seen_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
            status: "offline",
          },
        }),
      ]),
    );
    await findModels();

    expect(screen.getByRole("status")).toHaveTextContent(
      "lab-118 is offline (last seen 3 hours ago). This is what it last reported. Reconnect it in Computers to manage its models.",
    );
    expect(
      screen.getByRole("button", { name: "Load Gemma 3 27B" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Download GPT-OSS 20B" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Gemma 3 27B" }));
    expect(
      screen.getByRole("button", { name: "Remove from computer" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("link", { name: "Computers" }));
    expect(await screen.findByText("Computers page")).toBeVisible();
  });

  it("lets only the owner act and tells everyone else why", async () => {
    renderPage(setup([labView({ viewer_is_owner: false })]));
    await findModels();

    expect(screen.getByRole("status")).toHaveTextContent(
      "Only the person who connected lab-118 can download, load or remove its models.",
    );
    expect(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Download GPT-OSS 20B" }),
    ).toBeDisabled();
  });

  it.each([
    [
      "TOOL_NOT_INSTALLED",
      "Local models aren't set up on lab-118",
      "Run Quick Install",
    ],
    [
      "TOOL_FAILED",
      "Couldn't read the local models on lab-118",
      "didn't answer",
    ],
    [
      "NOT_REPORTED",
      "lab-118 hasn't reported local models yet",
      "up-to-date Linger app",
    ],
  ] as const)(
    "explains a Computer without a model library (%s)",
    async (code, title, body) => {
      renderPage(
        setup([
          labView({
            available: false,
            models: [],
            pools: [],
            reason: { code, detail: "raw tool output" },
          }),
        ]),
      );

      const empty = await screen.findByRole("region", { name: title });
      expect(empty).toHaveTextContent(body);
      expect(empty).not.toHaveTextContent("raw tool output");
      expect(
        screen.queryByRole("region", { name: "Models" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Details" }),
      ).not.toBeInTheDocument();
    },
  );

  it("sends a Tenant without Computers to Computers", async () => {
    renderPage(setup([], []));

    const empty = await screen.findByRole("region", {
      name: "No computers yet",
    });
    fireEvent.click(within(empty).getByRole("link", { name: "Computers" }));
    expect(await screen.findByText("Computers page")).toBeVisible();
  });

  it("renders a model that fits nowhere without a placement", async () => {
    renderPage(setup());
    await findModels();

    expect(statuses()).toContain(
      "Llama 3.1 405B: Can't download · needs 230 GB",
    );
    fireEvent.click(screen.getByRole("button", { name: "Llama 3.1 405B" }));
    const memory = within(
      screen.getByRole("region", { name: "Llama 3.1 405B details" }),
    )
      .getByText("Memory")
      .closest("div")!;
    expect(memory).toHaveTextContent(/^Memory230 GB$/);
  });

  it("shows a loaded model's endpoint without a gateway model id", async () => {
    const lab = labView();
    renderPage(
      setup([
        withModel(lab, "qwen3-coder-30b:Q4_K_M", {
          endpoint: { base_url: "http://127.0.0.1:18100/v1" },
        }),
      ]),
    );
    await findModels();

    expect(statuses()[0]).toBe("Qwen3 Coder 30B: Loaded · GPU 0 · 21.4 GB");
    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    expect(
      screen.getByRole("region", { name: "Qwen3 Coder 30B details" }),
    ).toHaveTextContent("http://127.0.0.1:18100/v1");
  });

  it("keeps the chosen Computer in the address", async () => {
    renderPage(setup(), "?computer=computer-mac");
    await findModels();
    expect(statuses()[0]).toBe("GPT-OSS 20B: Loaded · Memory · 14.3 GB");
    expect(screen.getByText("14.3 GB of 51.2 GB memory in use")).toBeVisible();

    fireEvent.click(screen.getByRole("combobox", { name: "Computer" }));
    fireEvent.click(await screen.findByRole("option", { name: "lab-118" }));

    await waitFor(() =>
      expect(
        screen.getByText("Address search: ?computer=computer-lab"),
      ).toBeVisible(),
    );
    await waitFor(() =>
      expect(statuses()[0]).toBe("Qwen3 Coder 30B: Loaded · GPU 0 · 21.4 GB"),
    );
  });

  it("opens the desktop app's own Computer when the address names none", async () => {
    (window as { lingerDesktop?: unknown }).lingerDesktop = {
      computer: {
        enroll: () => Promise.reject(new Error("not used")),
        getStatus: () =>
          Promise.resolve({
            activeOperations: 0,
            bridge: "connected",
            computerId: "computer-mac",
            runtime: "ready",
          }),
        onStatus: () => () => undefined,
      },
    };
    renderPage(setup());

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Computer" }),
      ).toHaveTextContent("Mac Studio"),
    );
    await waitFor(() =>
      expect(statuses()[0]).toBe("GPT-OSS 20B: Loaded · Memory · 14.3 GB"),
    );
  });

  it("shows rich model card icons, capability badges, and expanded metadata", async () => {
    const richLab = withModel(labView(), "qwen3-coder-30b:Q4_K_M", {
      active_parameters: "3B",
      architecture: "moe",
      capabilities: ["coding", "tool_use", "reasoning"],
      family: "qwen",
      license: "Apache-2.0",
      parameters: "30B",
      prompt_tokens_per_second: 612.5,
      publisher: "Alibaba Cloud",
      source_url: "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct",
    });
    const visionLab = withModel(richLab, "gemma3-4b:Q4_K_M", {
      family: "gemma",
      vision: true,
    });
    renderPage(setup([visionLab]));
    await findModels();

    const coderCard = card("Qwen3 Coder 30B");
    expect(coderCard.querySelector('[data-family="qwen"]')).toBeInTheDocument();
    expect(within(coderCard).getByText("3B active")).toBeVisible();
    expect(within(coderCard).getByText("Tool use")).toBeVisible();
    expect(within(coderCard).getByText("Reasoning")).toBeVisible();
    expect(within(coderCard).getByText("+1")).toBeVisible();

    const gemmaCard = card("Gemma 3 4B");
    expect(
      gemmaCard.querySelector('[data-family="gemma"]'),
    ).toBeInTheDocument();
    expect(within(gemmaCard).getByText("Vision")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    const details = screen.getByRole("region", {
      name: "Qwen3 Coder 30B details",
    });
    expect(details).toHaveTextContent("PublisherAlibaba Cloud");
    expect(details).toHaveTextContent("Parameters30B · 3B active (MoE)");
    expect(details).toHaveTextContent("Coding");
    expect(details).toHaveTextContent("46 tokens/s · 613 prompt tokens/s");
    expect(details).toHaveTextContent("LicenseApache-2.0");
    const link = within(details).getByRole("link", {
      name: "huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows live download rate and ETA when bytes_per_second is reported", async () => {
    const mb = 1024 * 1024;
    renderPage(
      setup([
        withModel(labView(), "gpt-oss-20b:Q4_K_M", {
          download: {
            bytes_per_second: 50 * mb,
            done_bytes: 5_000 * mb,
            step: "download",
            total_bytes: 20_000 * mb,
          },
          state: "downloading",
        }),
      ]),
    );
    await findModels();

    expect(statuses()).toContain(
      "GPT-OSS 20B: Downloading · 25% · 50 MB/s · 5m left",
    );
  });

  it("renders card skeletons while loading and a segmented GPU memory bar once loaded", async () => {
    const fixture = setup();
    let releaseView: ((view: LocalModelsView) => void) | undefined;
    fixture.runtime.server.on(
      "GET",
      viewPath,
      () =>
        new Promise((resolve) => {
          releaseView = resolve;
        }),
    );
    renderPage(fixture);

    const loadingStatus = await screen.findByRole("status", {
      name: "Loading models",
    });
    expect(loadingStatus).toHaveAttribute("aria-busy", "true");
    expect(within(loadingStatus).getByText("Loading models")).toBeVisible();

    releaseView?.(labView());
    await findModels();

    expect(
      screen.getByText("22.5 GB of 48 GB GPU memory in use"),
    ).toBeVisible();
    expect(screen.getByText(/25\.5 GB free/)).toBeVisible();
    expect(
      screen.getByRole("img", {
        name: "GPU memory breakdown: 22.5 GB of 48 GB in use",
      }),
    ).toBeVisible();
    expect(screen.getByText("Qwen3 Coder 30B · 21.4 GB")).toBeVisible();
    expect(screen.getByText("Qwen3 Embedding · 1.1 GB")).toBeVisible();
  });

  it("persists chosen Computer, defaults to loaded online Pi Computer, and preserves computer param on offline link", async () => {
    const lab = labView({
      computer: { ...labView().computer, status: "offline" },
    });
    const mac = macView();
    const labItem = {
      ...inventoryComputer(lab),
      status: "offline" as const,
    };
    const macItem = {
      ...inventoryComputer(mac),
      runtimes: [
        {
          models: [
            {
              id: "localmodels-library/gpt-oss-20b",
              label: "GPT-OSS 20B",
            },
          ],
          status: "ready" as const,
          type: "pi" as const,
        },
      ],
      status: "online" as const,
    };
    const fixture = setup([lab, mac], [labItem, macItem]);
    renderPage(fixture);
    await findModels();

    const picker = screen.getByRole("combobox", { name: "Computer" });
    expect(picker).toHaveTextContent("Mac Studio · 1 loaded");
    fireEvent.click(picker);
    expect(
      await screen.findByRole("option", { name: "lab-118 · Offline" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("option", { name: "lab-118 · Offline" }));

    await waitFor(() =>
      expect(
        window.localStorage.getItem(localModelsComputerStorageKey(tenantId)),
      ).toBe("computer-lab"),
    );
    expect(
      await screen.findByRole("link", { name: "Computers" }),
    ).toHaveAttribute(
      "href",
      "/t/tenant-northstar/settings/computers?computer=computer-lab",
    );

    cleanup();
    renderPage(fixture);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Computer" }),
      ).toHaveTextContent("lab-118 · Offline"),
    );
  });

  it("switches Another Me with Use with CTA, shows confirmation banner, and navigates to chat", async () => {
    const fixture = setup();
    acceptTenantAgentUpdates(fixture.runtime);
    renderPage(fixture);
    await findModels();

    const coderCard = card("Qwen3 Coder 30B");
    expect(
      within(coderCard).getByText("Used by Research agent, Code reviewer"),
    ).toBeVisible();
    fireEvent.click(
      await within(coderCard).findByRole("button", {
        name: "Use with Jenny's Delegate",
      }),
    );

    expect(
      await screen.findByText("Jenny's Delegate now uses Qwen3 Coder 30B."),
    ).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    const delegate = fixture.runtime.seed.tenantAgents.find(
      (agent) => agent.actor.id === "actor-delegate",
    )!;
    expect(delegate.runtime).toEqual({
      model: "localmodels-library/qwen3-coder-30b",
      placement: {
        computer_id: "computer-lab",
        runtime_type: "pi",
        type: "local",
        workspace_grant_id: "grant-linger-workspace",
      },
    });

    await waitFor(() =>
      expect(
        within(card("Qwen3 Coder 30B")).getByRole("link", {
          name: "Open chat",
        }),
      ).toBeVisible(),
    );
    fireEvent.click(
      within(card("Qwen3 Coder 30B")).getByRole("link", { name: "Open chat" }),
    );
    expect(
      await screen.findByText(
        'Chat route: /t/tenant-northstar/rooms/room-another-me/chat|{"focusComposer":true}',
      ),
    ).toBeVisible();
  });

  it("queues Use when ready on loading models, auto-switches on load, and clears on cancel or failure", async () => {
    const fixture = setup([
      withModel(labView(), "gemma3-27b:Q4_K_M", {
        state: "loading",
      }),
      withModel(macView(), "llama3.3-70b:Q4_K_M", {
        pi_model: "localmodels-library/llama3.3-70b",
        state: "downloading",
      }),
    ]);
    acceptTenantAgentUpdates(fixture.runtime);
    renderPage(fixture);
    await findModels();

    const gemmaCard = card("Gemma 3 27B");
    const queueBtn = await within(gemmaCard).findByRole("button", {
      name: "Use when ready",
    });
    expect(queueBtn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(queueBtn);
    expect(
      within(gemmaCard).getByRole("button", {
        name: "Queued for Jenny's Delegate",
      }),
    ).toHaveAttribute("aria-pressed", "true");

    publishSnapshot(
      fixture,
      withModel(labView(), "gemma3-27b:Q4_K_M", {
        state: "loaded",
      }),
    );
    expect(
      await screen.findByText("Jenny's Delegate now uses Gemma 3 27B."),
    ).toBeVisible();

    cleanup();
    renderPage(fixture, "?computer=computer-mac");
    await findModels();
    const llamaCard = card("Llama 3.3 70B");
    fireEvent.click(
      await within(llamaCard).findByRole("button", { name: "Use when ready" }),
    );
    expect(
      within(llamaCard).getByRole("button", {
        name: "Queued for Jenny's Delegate",
      }),
    ).toBeVisible();
    fireEvent.click(
      within(llamaCard).getByRole("button", { name: "Cancel Llama 3.3 70B" }),
    );
    await waitFor(() =>
      expect(fixture.actions.at(-1)?.body).toEqual({ action: "cancel" }),
    );
    publishSnapshot(
      fixture,
      withModel(macView(), "llama3.3-70b:Q4_K_M", {
        pi_model: "localmodels-library/llama3.3-70b",
        state: "loaded",
      }),
    );
    await waitFor(() => expect(statusOf("Llama 3.3 70B")).toMatch(/^Loaded/));
    expect(
      screen.queryByText("Jenny's Delegate now uses Llama 3.3 70B."),
    ).not.toBeInTheDocument();
  });

  it("pre-checks MakeRoom handoff when unloading a model used by an assignable Agent and keeps it opt-in otherwise", async () => {
    const fixture = setup();
    acceptTenantAgentUpdates(fixture.runtime);
    renderPage(fixture, "?computer=computer-mac");
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    const optInDialog = screen.getByRole("dialog", {
      name: "Make room to load",
    });
    const optInCheckbox = within(optInDialog).getByRole("checkbox", {
      name: "Switch Jenny's Delegate to Llama 3.3 70B once loaded",
    });
    expect(optInCheckbox).not.toBeChecked();
    fireEvent.click(
      within(optInDialog).getByRole("button", { name: "Cancel" }),
    );

    const delegate = fixture.runtime.seed.tenantAgents.find(
      (agent) => agent.actor.id === "actor-delegate",
    )!;
    delegate.runtime = {
      model: "localmodels-library/gpt-oss-20b",
      placement: {
        computer_id: "computer-mac",
        runtime_type: "pi",
        type: "local",
        workspace_grant_id: "grant-linger-workspace",
      },
    };
    cleanup();
    renderPage(fixture, "?computer=computer-mac");
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    const handoff = await within(dialog).findByRole("checkbox", {
      name: "Switch Jenny's Delegate to Llama 3.3 70B once loaded",
    });
    expect(handoff).toBeChecked();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unload and load" }),
    );
    await waitFor(() => expect(fixture.actions).toHaveLength(1));

    publishSnapshot(
      fixture,
      withModel(macView(), "llama3.3-70b:Q4_K_M", {
        error: undefined,
        pi_model: "localmodels-library/llama3.3-70b",
        state: "loaded",
      }),
    );
    expect(
      await screen.findByText("Jenny's Delegate now uses Llama 3.3 70B."),
    ).toBeVisible();
  });

  it("shows Gateway readiness, Switch Agent select with busy guard, lazy New Agent dialog, and CopyEndpoint auto-reset", async () => {
    const view = labView();
    const fixture = setup([view]);
    acceptTenantAgentUpdates(fixture.runtime);
    const labInventory = fixture.runtime.seed.localComputers[0]!;
    labInventory.runtimes = [
      {
        models: [
          {
            id: "localmodels-library/qwen3-coder-30b",
            label: "Qwen3 Coder 30B",
          },
        ],
        status: "ready",
        type: "pi",
      },
    ];
    const codexAgent = fixture.runtime.seed.tenantAgents.find(
      (agent) => agent.actor.id === "actor-codex",
    )!;
    codexAgent.availability.active_task_count = 1;

    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    const details = screen.getByRole("region", {
      name: "Qwen3 Coder 30B details",
    });
    expect(details).toHaveTextContent("GatewayReady · Bifrost (Pi)");

    fireEvent.click(
      await within(details).findByRole("combobox", { name: "Switch Agent" }),
    );
    expect(
      await screen.findByRole("option", { name: "Codex · Working" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("option", { name: "Jenny's Delegate" }));
    expect(
      await screen.findByText("Jenny's Delegate now uses Qwen3 Coder 30B."),
    ).toBeVisible();

    fireEvent.click(within(details).getByRole("button", { name: "New Agent" }));
    const createDialog = await screen.findByRole("dialog", {
      name: "Create local agent",
    });
    expect(createDialog).toBeVisible();
    expect(
      await within(createDialog).findByRole("combobox", {
        name: "Local Computer",
      }),
    ).toHaveTextContent("lab-118");
    expect(
      within(createDialog).getByRole("combobox", { name: "Runtime" }),
    ).toHaveTextContent("Pi");
    expect(
      within(createDialog).getByRole("combobox", { name: "Model" }),
    ).toHaveTextContent("Qwen3 Coder 30B");
    fireEvent.click(
      await within(createDialog).findByRole("button", { name: "Cancel" }),
    );

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.useFakeTimers();
    const copyButton = within(details).getByRole("button", {
      name: "Copy Qwen3 Coder 30B endpoint",
    });
    fireEvent.click(copyButton);
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:18100/v1");
    expect(copyButton).toHaveAttribute("title", "Copied");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(copyButton).toHaveAttribute("title", "Copy endpoint");
  });

  it("elevates the Recommended Download button to primary when no model is loaded or active", async () => {
    const view = withModel(labView(), "qwen3-coder-30b:Q4_K_M", {
      endpoint: undefined,
      state: "idle",
    });
    renderPage(setup([view]));
    await findModels();

    expect(
      screen.getByRole("button", { name: "Download GPT-OSS 20B" }),
    ).toHaveClass("bg-primary");
  });

  it("shows download transfer tooltip and Transfer fact row for mirror and cache downloads", async () => {
    const mb = 1024 * 1024;
    const fixture = setup([
      withModel(labView(), "gpt-oss-20b:Q4_K_M", {
        download: {
          bytes_per_second: 50 * mb,
          connections: 4,
          done_bytes: 5_000 * mb,
          source: "modelscope",
          step: "download",
          total_bytes: 20_000 * mb,
        },
        state: "downloading",
      }),
    ]);
    renderPage(fixture);
    await findModels();

    expect(statusOf("GPT-OSS 20B")).toBe(
      "Downloading · 25% · 50 MB/s · 5m left",
    );
    const downloadingCard = card("GPT-OSS 20B");
    expect(
      within(downloadingCard).getByTitle(
        "ModelScope mirror · 4 connections · binary MB/s (MiB/s)",
      ),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "GPT-OSS 20B" }));
    const details = screen.getByRole("region", {
      name: "GPT-OSS 20B details",
    });
    expect(details).toHaveTextContent(
      "TransferModelScope mirror · 4 connections · binary MB/s (MiB/s)",
    );

    publishSnapshot(
      fixture,
      withModel(labView(), "gpt-oss-20b:Q4_K_M", {
        download: {
          connections: 0,
          done_bytes: 0,
          source: "cache",
          step: "download",
          total_bytes: 20_000 * mb,
        },
        state: "downloading",
      }),
    );
    await waitFor(() =>
      expect(statusOf("GPT-OSS 20B")).toBe(
        "Downloading · Reusing local cache…",
      ),
    );
    expect(
      within(card("GPT-OSS 20B")).getByTitle("Reusing verified local cache"),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "GPT-OSS 20B details" }),
    ).toHaveTextContent("TransferReusing verified local cache");
  });

  it("shows granular loading step text and determinate progress bar while loading", async () => {
    const fixture = setup([
      withModel(labView(), "gemma3-27b:Q4_K_M", {
        state: "loading",
      }),
    ]);
    renderPage(fixture);
    await findModels();

    expect(statusOf("Gemma 3 27B")).toBe("Loading · GPU 1");
    expect(
      screen.queryByRole("progressbar", { name: "Gemma 3 27B load progress" }),
    ).not.toBeInTheDocument();

    publishSnapshot(
      fixture,
      withModel(labView(), "gemma3-27b:Q4_K_M", {
        load: { done_steps: 0, step: "prepare", total_steps: 7 },
        pool: "gpu:0",
        state: "loading",
      }),
    );
    await waitFor(() =>
      expect(statusOf("Gemma 3 27B")).toBe("Loading · Preparing server…"),
    );
    const bar = screen.getByRole("progressbar", {
      name: "Gemma 3 27B load progress",
    });
    expect(bar).toHaveAttribute("aria-valuenow", "0");

    publishSnapshot(
      fixture,
      withModel(labView(), "gemma3-27b:Q4_K_M", {
        load: { done_steps: 1, step: "start", total_steps: 7 },
        pool: "gpu:0",
        state: "loading",
      }),
    );
    await waitFor(() =>
      expect(statusOf("Gemma 3 27B")).toBe("Loading · Starting server…"),
    );
    expect(bar).toHaveAttribute("aria-valuenow", "14");

    publishSnapshot(
      fixture,
      withModel(labView(), "gemma3-27b:Q4_K_M", {
        load: { done_steps: 4, step: "load", total_steps: 7 },
        pool: "gpu:0",
        state: "loading",
      }),
    );
    await waitFor(() =>
      expect(statusOf("Gemma 3 27B")).toBe(
        "Loading · Loading weights to GPU 0 · 57%",
      ),
    );
    expect(bar).toHaveAttribute("aria-valuenow", "57");

    publishSnapshot(
      fixture,
      withModel(labView(), "gemma3-27b:Q4_K_M", {
        load: { done_steps: 7, step: "warm", total_steps: 7 },
        pool: "gpu:0",
        state: "loading",
      }),
    );
    await waitFor(() =>
      expect(statusOf("Gemma 3 27B")).toBe("Loading · Warming up · 100%"),
    );
    expect(bar).toHaveAttribute("aria-valuenow", "100");
  });
});
