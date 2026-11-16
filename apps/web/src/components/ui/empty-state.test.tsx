import { BotIcon } from "@hugeicons/core-free-icons";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { EmptyNote, EmptyState } from "./empty-state";

it("says what is missing, why, and offers at most one way forward", () => {
  const onSelect = vi.fn();
  render(
    <EmptyState
      action={{ label: "Create one", onSelect }}
      detail="Agents you add here run in this Room."
      icon={BotIcon}
      title="No Agents yet"
    />,
  );
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent("No Agents yet");
  expect(status).toHaveTextContent("Agents you add here run in this Room.");
  fireEvent.click(screen.getByRole("button", { name: "Create one" }));
  expect(onSelect).toHaveBeenCalledOnce();
});

it("announces a failure as an alert rather than an empty list", () => {
  render(
    <EmptyState
      detail="Search is unavailable."
      icon={BotIcon}
      title="Search failed"
      tone="danger"
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Search failed");
  expect(screen.queryByRole("status")).toBeNull();
});

it("keeps an empty section's quiet note in the page rather than a panel", () => {
  render(<EmptyNote icon={BotIcon}>No reports yet.</EmptyNote>);
  expect(screen.getByText("No reports yet.")).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
});
