import { render, screen } from "@testing-library/react";
import {
  createMemoryRouter,
  type RouteObject,
  RouterProvider,
} from "react-router";
import { describe, expect, it } from "vitest";

import { FullPageRouteErrorSurface } from "./route-error-surfaces";

const ROOM_CHAT_PATTERN = "/t/:tenantId/rooms/:roomId/chat";

function renderBrokenRoom(status: number, statusText: string) {
  const routes: RouteObject[] = [
    {
      ErrorBoundary: FullPageRouteErrorSurface,
      element: <p>Chat</p>,
      loader: () => {
        throw new Response(null, { status, statusText });
      },
      path: ROOM_CHAT_PATTERN,
    },
  ];
  render(
    <RouterProvider
      router={createMemoryRouter(routes, {
        initialEntries: ["/t/tenant-northstar/rooms/room-gtm-launch/chat"],
      })}
    />,
  );
}

describe("FullPageRouteErrorSurface", () => {
  it("sends a broken Room to its Space's Room list instead of back into the Room", async () => {
    renderBrokenRoom(503, "Service Unavailable");

    expect(
      await screen.findByRole("heading", { name: "TeamHub unavailable" }),
    ).toBeVisible();
    const messages = screen.getByRole("link", { name: "Messages" });
    expect(messages).toHaveAttribute("href", "/t/tenant-northstar/rooms");
    expect(messages.getAttribute("href")).not.toContain("room-gtm-launch");
  });

  it("keeps every top-level Space destination reachable from the rail", async () => {
    renderBrokenRoom(503, "Service Unavailable");

    await screen.findByRole("heading", { name: "TeamHub unavailable" });
    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute(
      "href",
      "/t/tenant-northstar/library",
    );
    expect(screen.getByRole("link", { name: "Wiki" })).toHaveAttribute(
      "href",
      "/t/tenant-northstar/library/wiki",
    );
    expect(screen.getByRole("link", { name: "Connectors" })).toHaveAttribute(
      "href",
      "/t/tenant-northstar/apps",
    );
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/t/tenant-northstar/settings",
    );
  });

  it("keeps the same escape routes when the Room is restricted", async () => {
    renderBrokenRoom(404, "Not Found");

    expect(
      await screen.findByRole("heading", {
        name: "This Room is not available to you",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Back to my Rooms" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Messages" })).toHaveAttribute(
      "href",
      "/t/tenant-northstar/rooms",
    );
    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute(
      "href",
      "/t/tenant-northstar/library",
    );
  });
});
