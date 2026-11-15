import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { LibraryDocumentsHeader } from "./library-documents-header";
import { OpenGlobalSearchContext } from "@/features/search/global-search-context";
import { searchShortcutLabel } from "@/features/search/search-shortcut";

function renderHeader(openSearch = vi.fn()) {
  const view = render(
    <OpenGlobalSearchContext value={openSearch}>
      <LibraryDocumentsHeader
        createBusy={false}
        importRef={createRef<HTMLInputElement>()}
        onCreateDocument={() => undefined}
        onImport={() => undefined}
        onImportPick={() => undefined}
        onNewFolder={() => undefined}
        onUploadFolder={() => undefined}
      />
    </OpenGlobalSearchContext>,
  );
  return { openSearch, unmount: view.unmount };
}

describe("LibraryDocumentsHeader", () => {
  it("offers the global Search the shortcut opens, with its keys", () => {
    const { openSearch } = renderHeader();

    expect(
      screen.getByRole("heading", { level: 2, name: "Library" }),
    ).toBeVisible();
    const search = screen.getByRole("button", { name: "Search" });
    expect(search).toHaveTextContent("Search");
    expect(search).toHaveTextContent(searchShortcutLabel());
    fireEvent.click(search);
    expect(openSearch).toHaveBeenCalledOnce();
  });

  it("keeps the New menu beside Search", () => {
    renderHeader();

    expect(
      screen.getByRole("button", { name: "Create in My pages" }),
    ).toBeVisible();
  });
});
