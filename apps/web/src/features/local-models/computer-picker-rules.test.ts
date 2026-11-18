import { describe, expect, it } from "vitest";

import {
  computerChip,
  defaultComputerId,
  pickerGroups,
} from "./computer-picker-rules";
import type { LocalModelsComputerSummary } from "./local-models-queries";
import { computerSummary } from "./local-models-test-support";

function computer(
  id: string,
  state: LocalModelsComputerSummary["readiness"]["state"],
  fields: Partial<LocalModelsComputerSummary> = {},
) {
  return computerSummary({
    computer_id: id,
    readiness: { enable_command: false, state },
    ...fields,
  });
}

const ids = (computers: readonly LocalModelsComputerSummary[]) =>
  computers.map((item) => item.computer_id);

describe("defaultComputerId", () => {
  const fleet = [
    computer("ready", "ready"),
    computer("loaded-1", "loaded", {
      counts: { loaded: 1, on_disk: 1, working: 0 },
    }),
    computer("loaded-2", "loaded", {
      counts: { loaded: 2, on_disk: 2, working: 0 },
    }),
    computer("offline-loaded", "loaded", {
      counts: { loaded: 3, on_disk: 3, working: 0 },
      status: "offline",
    }),
    computer("theirs", "loaded", {
      counts: { loaded: 4, on_disk: 4, working: 0 },
      viewer_is_owner: false,
    }),
  ];

  it("opens this desktop's Computer when it is the viewer's", () => {
    expect(
      defaultComputerId(fleet, { desktopId: "ready", lastPickId: "loaded-1" }),
    ).toBe("ready");
    // Another member's desktop falls through to the last pick.
    expect(
      defaultComputerId(fleet, { desktopId: "theirs", lastPickId: "loaded-1" }),
    ).toBe("loaded-1");
  });

  it("opens the last pick while it is still the viewer's", () => {
    expect(defaultComputerId(fleet, { lastPickId: "offline-loaded" })).toBe(
      "offline-loaded",
    );
    expect(defaultComputerId(fleet, { lastPickId: "removed" })).toBe(
      "loaded-2",
    );
    expect(defaultComputerId(fleet, { lastPickId: "theirs" })).toBe("loaded-2");
  });

  it("prefers the online Computer with the best state, most loaded first", () => {
    expect(defaultComputerId(fleet, {})).toBe("loaded-2");
    expect(
      defaultComputerId(
        [
          computer("setup", "not_set_up"),
          computer("attention", "needs_attention"),
          computer("working", "working"),
        ],
        {},
      ),
    ).toBe("working");
    expect(
      defaultComputerId(
        [
          computer("setup", "not_set_up"),
          computer("attention", "needs_attention"),
        ],
        {},
      ),
    ).toBe("attention");
  });

  it("falls back to any online Computer, then the one seen last", () => {
    expect(
      defaultComputerId(
        [
          computer("reinstall", "needs_reinstall"),
          computer("gpu-less", "unsupported_hardware"),
        ],
        {},
      ),
    ).toBe("reinstall");
    expect(
      defaultComputerId(
        [
          computer("old", "loaded", {
            last_seen_at: "2026-11-01T00:00:00.000Z",
            status: "offline",
          }),
          computer("recent", "not_set_up", {
            last_seen_at: "2026-11-12T00:00:00.000Z",
            status: "offline",
          }),
        ],
        {},
      ),
    ).toBe("recent");
  });

  it("opens nothing without a Computer of the viewer's", () => {
    expect(defaultComputerId([], {})).toBeUndefined();
    expect(
      defaultComputerId(
        [computer("theirs", "loaded", { viewer_is_owner: false })],
        {},
      ),
    ).toBeUndefined();
  });
});

describe("pickerGroups", () => {
  it("groups this computer, online and offline, each by state, snapshot time and name", () => {
    const groups = pickerGroups(
      [
        computer("b-ready", "ready"),
        computer("a-ready", "ready"),
        computer("newer-ready", "ready", {
          observed_at: "2026-11-13T10:00:00.000Z",
        }),
        computer("unsupported", "unsupported_hardware"),
        computer("loaded", "loaded"),
        computer("desk", "not_set_up"),
        computer("asleep", "loaded", { status: "offline" }),
        computer("theirs", "loaded", { viewer_is_owner: false }),
      ],
      "desk",
    );

    expect(groups.thisComputer?.computer_id).toBe("desk");
    expect(ids(groups.online)).toEqual([
      "loaded",
      "newer-ready",
      "a-ready",
      "b-ready",
      "unsupported",
    ]);
    expect(ids(groups.offline)).toEqual(["asleep"]);
  });

  it("searches names, owner names and platforms", () => {
    const fleet = [
      computer("lab", "ready", { display_name: "lab-118" }),
      computer("mac", "ready", { display_name: "Studio", platform: "darwin" }),
      computer("pc", "ready", { display_name: "Gaming", platform: "win32" }),
    ];
    const found = (search: string) => {
      const groups = pickerGroups(fleet, undefined, search);
      return ids([...groups.online, ...groups.offline]);
    };

    expect(found("LAB")).toEqual(["lab"]);
    expect(found("macos")).toEqual(["mac"]);
    expect(found("windows")).toEqual(["pc"]);
    expect(found("ada")).toHaveLength(3);
    expect(found("nothing")).toEqual([]);
  });
});

describe("computerChip", () => {
  const now = Date.parse("2026-11-13T13:00:00.000Z");

  it("labels each state the way the overview and Computers page show it", () => {
    expect(
      computerChip(
        computer("lab", "loaded", {
          counts: { loaded: 2, on_disk: 3, working: 0 },
        }),
        now,
      ),
    ).toEqual({ dot: "success", label: "2 loaded" });
    expect(computerChip(computer("old", "needs_reinstall"), now)).toEqual({
      dot: "warning",
      label: "Needs reinstall",
    });
    expect(
      computerChip(
        computer("small", "unsupported_hardware", {
          readiness: {
            enable_command: false,
            reason: "MEMORY_INSUFFICIENT",
            state: "unsupported_hardware",
          },
        }),
        now,
      ),
    ).toEqual({ label: "Not enough memory", muted: true });
  });

  it("greys an offline Computer's chip and says how long it has been away", () => {
    expect(
      computerChip(
        computer("lab", "loaded", {
          counts: { loaded: 2, on_disk: 2, working: 0 },
          last_seen_at: "2026-11-13T10:00:00.000Z",
          status: "offline",
        }),
        now,
      ),
    ).toEqual({ label: "2 loaded", muted: true, offline: "Offline · 3h" });
  });
});
