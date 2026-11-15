import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import type { PanelTabScope } from "./task-sidebar/panel-tab-types";
import { useRoomPanelSidebar } from "./use-room-panel-sidebar";

const roomScope: PanelTabScope = {
  accountId: "account-1",
  roomId: "room-1",
  tenantId: "tenant-1",
};
const otherRoomScope: PanelTabScope = { ...roomScope, roomId: "room-2" };

function renderPanelSidebar(current: PanelTabScope) {
  return renderHook(
    ({ scope }: { scope: PanelTabScope }) => {
      const [searchParams, setSearchParams] = useSearchParams();
      return useRoomPanelSidebar({
        profileOpen: false,
        scope,
        searchParams,
        setSearchParams,
      });
    },
    {
      initialProps: { scope: current },
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={["/"]}>{children}</MemoryRouter>
      ),
    },
  );
}

function openThread(panel: ReturnType<typeof renderPanelSidebar>["result"]) {
  act(() => {
    panel.current.openPanelTab({
      anchorMessageId: "msg-a",
      kind: "thread",
      title: "Alpha task",
    });
  });
}

describe("useRoomPanelSidebar", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return store.size;
        },
        clear() {
          store.clear();
        },
        getItem(key: string) {
          return store.get(key) ?? null;
        },
        key(index: number) {
          return [...store.keys()][index] ?? null;
        },
        removeItem(key: string) {
          store.delete(key);
        },
        setItem(key: string, value: string) {
          store.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("reopens in a Room whose panel the user left open", () => {
    const first = renderPanelSidebar(roomScope);
    expect(first.result.current.panelOpen).toBe(false);

    openThread(first.result);
    expect(first.result.current.panelOpen).toBe(true);
    expect(first.result.current.panelVisible).toBe(true);
    first.unmount();

    const remounted = renderPanelSidebar(roomScope);
    expect(remounted.result.current.panelOpen).toBe(true);
    expect(remounted.result.current.panelVisible).toBe(true);
  });

  it("stays closed in a Room where the user closed it", () => {
    const first = renderPanelSidebar(roomScope);
    openThread(first.result);
    act(() => first.result.current.closePanel());
    expect(first.result.current.panelOpen).toBe(false);
    first.unmount();

    expect(renderPanelSidebar(roomScope).result.current.panelOpen).toBe(false);
  });

  it("remembers the toggled state of each Room separately", () => {
    const panel = renderPanelSidebar(roomScope);
    act(() => panel.result.current.togglePanel());
    expect(panel.result.current.panelOpen).toBe(true);

    panel.rerender({ scope: otherRoomScope });
    expect(panel.result.current.panelOpen).toBe(false);

    act(() => panel.result.current.togglePanel());
    expect(panel.result.current.panelOpen).toBe(true);

    panel.rerender({ scope: roomScope });
    expect(panel.result.current.panelOpen).toBe(true);

    act(() => panel.result.current.togglePanel());
    expect(panel.result.current.panelOpen).toBe(false);

    panel.rerender({ scope: otherRoomScope });
    expect(panel.result.current.panelOpen).toBe(true);
  });
});
