import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubData } from "@/features/teamhub/teamhub-api";

import { AuthenticatedRouteLoading } from "./route-loading-surface";

describe("AuthenticatedRouteLoading", () => {
  it("names the destination Room for assistive tech but draws only shapes", async () => {
    const runtime = createTestTeamHubRuntime();

    const rooms = await teamHubData(
      runtime.client.api.GET("/v0/tenants/{tenantId}/rooms", {
        params: { path: { tenantId: "tenant-northstar" } },
      }),
    );

    render(
      <AuthenticatedRouteLoading
        pathname="/t/tenant-northstar/rooms/room-gtm-launch/chat"
        rooms={rooms.items}
      />,
    );

    expect(
      screen.getByRole("status", { name: "Loading gtm-launch" }),
    ).toHaveAttribute("data-loading-route", "room");
    // No title or status text lands ahead of the rest of the Room.
    expect(screen.queryByText("gtm-launch")).toBeNull();
  });

  it.each([
    ["/t/tenant-northstar/documents/document-1", "Document", "document"],
    ["/t/tenant-northstar/dashboard/work-item-a", "Dashboard", "dashboard"],
    ["/t/tenant-northstar/library", "Library", "library"],
    ["/t/tenant-northstar/library/my-documents", "Library", "library"],
    ["/t/tenant-northstar/library/wiki", "Wiki", "library"],
    ["/t/tenant-northstar/library/wiki/collection-a", "Wiki", "library"],
    ["/t/tenant-northstar/library/meetings", "Meeting", "document"],
    ["/t/tenant-northstar/apps", "Connectors", "connectors"],
    ["/t/tenant-northstar/settings/account", "Settings", "settings"],
    ["/t/tenant-northstar/settings/computers", "Settings", "settings"],
    ["/t/tenant-northstar/computers", "Local computers", "page"],
  ])("maps %s to the %s loading surface", (pathname, label, kind) => {
    render(<AuthenticatedRouteLoading pathname={pathname} rooms={[]} />);

    expect(
      screen.getByRole("status", { name: `Loading ${label}` }),
    ).toHaveAttribute("data-loading-route", kind);
  });

  it("keeps Library chrome stable while only the Document body is loading", () => {
    render(
      <AuthenticatedRouteLoading
        pathname="/t/tenant-northstar/documents/document-1"
        rooms={[]}
      />,
    );

    expect(screen.getByTestId("loading-workspace-sidebar")).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Loading Document body" }),
    ).toBeVisible();
  });

  it("keeps the Library sidebar while an open meeting loads", () => {
    render(
      <AuthenticatedRouteLoading
        pathname="/t/tenant-northstar/library/meetings"
        rooms={[]}
      />,
    );

    expect(screen.getByTestId("loading-workspace-sidebar")).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Loading Meeting body" }),
    ).toBeVisible();
  });

  it.each(["/t/tenant-northstar/library", "/t/tenant-northstar/library/wiki"])(
    "draws no sidebar on %s, where the resolved page has none",
    (pathname) => {
      render(<AuthenticatedRouteLoading pathname={pathname} rooms={[]} />);

      expect(
        screen.queryByTestId("loading-workspace-sidebar"),
      ).not.toBeInTheDocument();
    },
  );

  it("draws the Library landing as a heading, one row of four Recent cards, tabs and file rows", () => {
    const { container } = render(
      <AuthenticatedRouteLoading
        pathname="/t/tenant-northstar/library"
        rooms={[]}
      />,
    );

    const browser = container.querySelector(".workspace-file-browser");
    expect(browser).not.toBeNull();
    expect(browser?.querySelectorAll(".workspace-recent-card")).toHaveLength(4);
    expect(screen.getByTestId("loading-library-tabs").children).toHaveLength(3);
    expect(browser?.querySelectorAll(".workspace-file-row")).toHaveLength(6);
  });

  it("draws the dashboard with the four board columns the page renders", () => {
    render(
      <AuthenticatedRouteLoading
        pathname="/t/tenant-northstar/dashboard/work-item-a"
        rooms={[]}
      />,
    );

    const board = screen.getByTestId("loading-dashboard-columns");
    expect(board).toHaveClass("lg:grid-cols-4");
    expect(board.children).toHaveLength(4);
  });

  it("draws Connectors as the centered card grid without Library chrome", () => {
    render(
      <AuthenticatedRouteLoading
        pathname="/t/tenant-northstar/apps"
        rooms={[]}
      />,
    );

    expect(screen.queryByTestId("loading-workspace-sidebar")).toBeNull();
    const cards = screen.getByTestId("loading-connector-cards");
    expect(cards).toHaveClass("lg:grid-cols-3");
    expect(cards.children).toHaveLength(6);
  });

  it("draws Settings with its own section rail and centered content column", () => {
    const { container } = render(
      <AuthenticatedRouteLoading
        pathname="/t/tenant-northstar/settings/account"
        rooms={[]}
      />,
    );

    expect(container.querySelector(".md\\:w-\\[228px\\]")).not.toBeNull();
    expect(
      container.querySelector(".max-w-\\(--app-settings-width\\)"),
    ).not.toBeNull();
  });
});
