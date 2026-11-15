import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentTableOfContents } from "./document-table-of-contents";

const HEADINGS = [
  { id: "block-overview", level: 2, text: "Overview" },
  { id: "block-details", level: 2, text: "Details" },
];

/** The rendered Document blocks the TOC scrolls to and watches. */
function contentFixture() {
  const root = document.createElement("div");
  root.innerHTML = [
    '<div data-id="block-overview"><h2>Overview</h2></div>',
    '<div data-id="block-details"><h2>Details</h2></div>',
  ].join("");
  document.body.append(root);
  return root;
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  readonly targets: Element[] = [];
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.targets.length = 0;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  report(entries: Array<{ target: Element; isIntersecting: boolean }>) {
    this.callback(
      entries.map(
        (entry) =>
          ({
            isIntersecting: entry.isIntersecting,
            target: entry.target,
          }) as unknown as IntersectionObserverEntry,
      ),
      this as unknown as IntersectionObserver,
    );
  }
}

/** jsdom already stubs scrollIntoView, so replace it rather than add one. */
function spyOnScrollIntoView() {
  return vi
    .spyOn(HTMLElement.prototype, "scrollIntoView")
    .mockImplementation(() => undefined);
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("DocumentTableOfContents", () => {
  it("lists the headings and scrolls to the clicked block", () => {
    const scrollIntoView = spyOnScrollIntoView();
    const root = contentFixture();
    const onClose = vi.fn();
    render(
      <DocumentTableOfContents
        contentRef={{ current: root }}
        headings={HEADINGS}
        onClose={onClose}
      />,
    );

    const overview = screen.getByRole("button", { name: "Overview" });
    const details = screen.getByRole("button", { name: "Details" });
    expect(overview).toHaveAttribute("aria-current", "location");
    expect(details).not.toHaveAttribute("aria-current");

    fireEvent.click(details);

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
    expect(details).toHaveAttribute("aria-current", "location");
    expect(overview).not.toHaveAttribute("aria-current");

    fireEvent.click(
      screen.getByRole("button", { name: "Close table of contents" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("jumps instead of animating when the reader asked for reduced motion", () => {
    const scrollIntoView = spyOnScrollIntoView();
    const root = contentFixture();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    render(
      <DocumentTableOfContents
        contentRef={{ current: root }}
        headings={HEADINGS}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
  });

  it("highlights the heading the reader has scrolled to", () => {
    const root = contentFixture();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    render(
      <DocumentTableOfContents
        contentRef={{ current: root }}
        headings={HEADINGS}
        onClose={() => undefined}
      />,
    );

    const observer = FakeIntersectionObserver.instances.at(-1)!;
    expect(observer.targets).toHaveLength(2);

    const details = screen.getByRole("button", { name: "Details" });
    act(() =>
      observer.report([
        { isIntersecting: false, target: root.children[0]! },
        { isIntersecting: true, target: root.children[1]! },
      ]),
    );

    expect(details).toHaveAttribute("aria-current", "location");
    expect(
      screen.getByRole("button", { name: "Overview" }),
    ).not.toHaveAttribute("aria-current");

    act(() =>
      observer.report([
        { isIntersecting: true, target: root.children[0]! },
        { isIntersecting: false, target: root.children[1]! },
      ]),
    );
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("says so when the Document has no headings", () => {
    render(
      <DocumentTableOfContents
        contentRef={{ current: null }}
        headings={[]}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("No headings")).toBeVisible();
  });
});
