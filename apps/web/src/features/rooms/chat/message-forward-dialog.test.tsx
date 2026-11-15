import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { MessageForwardDialog } from "./message-forward-dialog";

function renderDialog(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  onClose = vi.fn(),
) {
  const message = runtime.seed.messagesByRoom.get("room-all")![0]!;
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MessageForwardDialog
        client={runtime.client}
        message={message}
        onClose={onClose}
        tenantId={message.tenant_id}
      />
    </QueryClientProvider>,
  );
  return { ...view, message, onClose };
}

describe("MessageForwardDialog", () => {
  it("forwards the message to the selected Agent with an idempotency key", async () => {
    const runtime = createTestTeamHubRuntime();
    const message = runtime.seed.messagesByRoom.get("room-all")![0]!;
    const forward = vi.fn<TestRouteHandler>(() => ({ items: [] }));
    runtime.server.on(
      "POST",
      "/v0/rooms/{roomId}/messages/{messageId}/forward",
      forward,
    );
    const onClose = vi.fn();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MessageForwardDialog
          client={runtime.client}
          message={message}
          onClose={onClose}
          tenantId={message.tenant_id}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^Codex/u }));
    fireEvent.click(screen.getByRole("button", { name: /Forward/u }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { target: { id: "actor-codex", kind: "agent" } },
        params: { messageId: message.id, roomId: "room-all" },
      }),
    );
    const [request] = runtime.server.requestsTo(
      "POST",
      "/v0/rooms/{roomId}/messages/{messageId}/forward",
    );
    expect(request?.headers.get("Idempotency-Key")).toBeTruthy();
  });

  it("keeps Forward as the primary action and the target kinds neutral", async () => {
    const runtime = createTestTeamHubRuntime();
    renderDialog(runtime);

    const agents = screen.getByRole("button", { name: "Agents" });
    const rooms = screen.getByRole("button", { name: "Rooms" });
    expect(agents).toHaveAttribute("aria-pressed", "true");
    expect(rooms).toHaveAttribute("aria-pressed", "false");
    expect(agents.className).not.toContain("bg-primary");
    expect(rooms.className).not.toContain("bg-primary");

    fireEvent.click(rooms);
    expect(rooms).toHaveAttribute("aria-pressed", "true");
    expect(agents).toHaveAttribute("aria-pressed", "false");
    expect(rooms.className).toContain("border-border");
    expect(agents.className).toContain("text-muted-foreground");

    const forward = screen.getByRole("button", { name: /Forward/u });
    expect(forward.className).toContain("bg-primary");
    expect(forward.className).not.toContain("border-border");
  });

  it("keeps a selected target's label after the search filters it out", async () => {
    const runtime = createTestTeamHubRuntime();
    renderDialog(runtime);

    fireEvent.click(await screen.findByRole("button", { name: /^Codex/u }));
    expect(
      screen.getByRole("button", { name: /Codex/u, pressed: true }),
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText("Search forward targets"), {
      target: { value: "zzz" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByText("No matching agents")).toBeVisible();
    const chips = screen.getByLabelText("Selected forward targets");
    expect(chips).toHaveTextContent("Codex");
    expect(chips).not.toHaveTextContent("actor-codex");
  });

  it("shows loading while the directory is still arriving", () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/actors",
      () => new Promise(() => undefined),
    );
    const { unmount } = renderDialog(runtime);

    expect(screen.getByRole("status")).toHaveTextContent("Loading targets");
    unmount();
  });

  it("offers a retry when the directory fails to load", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/tenants/{tenantId}/actors", () => ({
      error: { code: "INTERNAL", message: "boom" },
    }));
    renderDialog(runtime);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Forward targets could not be loaded.",
    );
    const before = runtime.server.requestsTo(
      "GET",
      "/v0/tenants/{tenantId}/actors",
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(
        runtime.server.requestsTo("GET", "/v0/tenants/{tenantId}/actors")
          .length,
      ).toBeGreaterThan(before),
    );
  });

  it("tells a search that missed apart from an empty directory", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/tenants/{tenantId}/rooms", () => ({
      items: [],
    }));
    renderDialog(runtime);

    fireEvent.click(screen.getByRole("button", { name: "Rooms" }));
    expect(await screen.findByText("No rooms available")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    fireEvent.change(screen.getByLabelText("Search forward targets"), {
      target: { value: "nobody" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByText("No matching agents")).toBeVisible();
  });
});
