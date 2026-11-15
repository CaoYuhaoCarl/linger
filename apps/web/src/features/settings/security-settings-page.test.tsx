import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { SecuritySettingsPage } from "./security-settings-page";

describe("SecuritySettingsPage password confirmation", () => {
  it("confirms the password change above the API keys section", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("POST", "/v0/account/password", () => undefined);
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <SecuritySettingsPage />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Change password" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Change password" });
    for (const [label, value] of [
      ["Current password", "old-password"],
      ["New password", "new-password"],
      ["Confirm new password", "new-password"],
    ] as const) {
      fireEvent.change(within(dialog).getByLabelText(label), {
        target: { value },
      });
    }
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Change password" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const confirmation = screen.getByRole("status");
    expect(confirmation).toHaveTextContent("Password changed");

    // The confirmation sits inside the Password section, which the browser
    // renders before the API keys heading, so it stays in view after the
    // dialog closes.
    const passwordSection = confirmation.closest("section");
    expect(passwordSection).not.toBeNull();
    expect(passwordSection).toHaveTextContent("Password");
    expect(passwordSection).not.toHaveTextContent("API keys");
    const apiKeysHeading = screen.getByRole("heading", { name: "API keys" });
    expect(
      passwordSection!.compareDocumentPosition(apiKeysHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
