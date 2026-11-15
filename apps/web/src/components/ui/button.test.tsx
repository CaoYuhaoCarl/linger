import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button";

describe("Button", () => {
  it("keeps its label and blocks clicks while loading", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Connect computer
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Connect computer" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector(".town-spinner")).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders no spinner and no busy state when it is not loading", () => {
    render(<Button>Sign out</Button>);

    const button = screen.getByRole("button", { name: "Sign out" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button.querySelector(".town-spinner")).toBeNull();
  });

  it("stays disabled when it is disabled without loading", () => {
    render(<Button disabled>Saving</Button>);

    const button = screen.getByRole("button", { name: "Saving" });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button.querySelector(".town-spinner")).toBeNull();
  });

  it("emphasizes the destructive color on danger hover", () => {
    render(<Button tone="danger">Replace local identity</Button>);

    const button = screen.getByRole("button", {
      name: "Replace local identity",
    });
    expect(button.className).toContain("text-destructive");
    expect(button.className).toContain("hover:border-destructive");
    expect(button.className).toContain("hover:bg-destructive/[0.08]");
    expect(button.className).not.toContain("hover:border-foreground/15");
  });
});
