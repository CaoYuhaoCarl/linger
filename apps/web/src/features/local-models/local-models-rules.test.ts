import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computerPickerLabel,
  downloadPercent,
  downloadSourceLabel,
  downloadStatusDetail,
  downloadStopped,
  downloadTransferSummary,
  formatGigabytes,
  headerMemorySegments,
  isModelOnComputer,
  loadCheck,
  loadPercent,
  loadStatusDetail,
  loadedLibraryModelCount,
  localModelsComputerStorageKey,
  makeRoomSelection,
  makesRoom,
  memorySummary,
  modelCapabilities,
  modelEntries,
  modelSourceLabel,
  parametersLabel,
  placeName,
  poolLabel,
  readRememberedLocalModelsComputerId,
  rememberLocalModelsComputerId,
  rowBadges,
  rowBadgesOverflowTitle,
  safeModelSourceUrl,
  selectDefaultLocalModelsComputer,
  speedLabel,
} from "./local-models-rules";
import {
  gb,
  gpuPool,
  labView,
  localModel,
  macView,
  modelView,
} from "./local-models-test-support";

function loaded(id: string, memoryGb: number, usedBy: string[] = []) {
  return modelView(
    localModel({
      id,
      memory_bytes: gb(memoryGb),
      name: id,
      pool: "gpu:0",
      state: "loaded",
    }),
    usedBy,
  );
}

describe("local models rules", () => {
  it("orders models by status, then the recommended one, then by fit", () => {
    expect(
      modelEntries(labView()).map(
        (entry) => `${entry.model.name}: ${entry.status}`,
      ),
    ).toEqual([
      "Qwen3 Coder 30B: loaded",
      "Gemma 3 27B: idle",
      "GPT-OSS 20B: available",
      "Gemma 3 4B: available",
      "Llama 3.3 70B: available",
      "Llama 3.1 405B: unavailable",
    ]);
  });

  it("formats every size in GB with at most one decimal", () => {
    expect(formatGigabytes(gb(0.6))).toBe("0.6 GB");
    expect(formatGigabytes(0)).toBe("0 GB");
    expect(formatGigabytes(gb(46))).toBe("46 GB");
    expect(formatGigabytes(gb(21.44))).toBe("21.4 GB");
  });

  it("names pools from what the Computer reported", () => {
    const view = labView();
    expect(view.pools.map((pool) => poolLabel(view, pool))).toEqual([
      "GPU 0 · RTX 4090",
      "GPU 1 · RTX 4090",
      "System memory",
    ]);
    expect(placeName(view, "gpu:1")).toBe("GPU 1");
    expect(placeName(view, "system")).toBe("system memory");
    expect(placeName(macView(), "unified")).toBe("memory");
    // A model that fits nowhere has no placement to show.
    expect(placeName(view, undefined)).toBeUndefined();
  });

  it("adds up GPU memory, or the memory of a Computer without GPUs", () => {
    expect(memorySummary(labView())).toEqual({
      gpu: true,
      totalBytes: gb(24) * 2,
      usedBytes: gb(21.4) + gb(1.1),
    });
    expect(memorySummary(macView())).toEqual({
      gpu: false,
      totalBytes: gb(51.2),
      usedBytes: gb(14.3),
    });
  });

  it("loads at once when the reported pool has room", () => {
    const view = labView();
    const gemma = view.models.find(
      (item) => item.model.name === "Gemma 3 27B",
    )!;
    expect(loadCheck(view, gemma.model)).toBeNull();
  });

  it("lists the other loaded models of a full pool", () => {
    const view = macView();
    const llama = view.models.find(
      (item) => item.model.name === "Llama 3.3 70B",
    )!;
    const check = loadCheck(view, llama.model)!;
    expect(check.needBytes).toBe(gb(46));
    expect(check.freeBytes).toBe(gb(51.2) - gb(14.3));
    expect(check.loaded.map((entry) => entry.model.name)).toEqual([
      "GPT-OSS 20B",
    ]);
  });

  it("preselects the fewest models, preferring ones no Agent uses", () => {
    const pool = gpuPool(0, 24, [{ gb: 22, id: "taken", name: "taken" }]);
    const big = loaded("big-used", 12, ["Research agent"]);
    const small = loaded("small-unused", 6);
    const medium = loaded("medium-unused", 9);
    const check = {
      freeBytes: gb(2),
      loaded: [big, small, medium].map((item) => ({
        ...item,
        status: "loaded" as const,
      })),
      needBytes: gb(12),
      pool,
    };

    // Fewest first: the one used model frees enough where no single unused
    // one does; with a larger need, two unused models beat a used one.
    expect(makeRoomSelection(check)).toEqual(["big-used"]);
    expect(makeRoomSelection({ ...check, needBytes: gb(17) })).toEqual([
      "medium-unused",
      "small-unused",
    ]);
    expect(makeRoomSelection({ ...check, needBytes: gb(40) })).toEqual([]);
    expect(makesRoom(check, new Set(["small-unused"]))).toBe(false);
    expect(makesRoom(check, new Set(["small-unused", "medium-unused"]))).toBe(
      true,
    );
  });

  it("reports download progress in whole percent", () => {
    expect(
      downloadPercent(
        localModel({
          download: { done_bytes: 333, step: "download", total_bytes: 1000 },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBe(33);
    expect(downloadPercent(localModel({ id: "m", name: "m" }))).toBe(0);
  });

  it("unites legacy vision with structured capabilities in display order", () => {
    expect(
      modelCapabilities(
        localModel({
          capabilities: ["coding", "vision", "tool_use"],
          id: "m",
          name: "m",
          vision: true,
        }),
      ),
    ).toEqual(["vision", "tool_use", "coding"]);
    expect(
      modelCapabilities(localModel({ id: "m", name: "m", vision: true })),
    ).toEqual(["vision"]);
  });

  it("formats parameter scale, architecture, and collapsed row badges", () => {
    const moe = localModel({
      active_parameters: "3B",
      architecture: "moe",
      capabilities: ["coding", "reasoning", "tool_use", "vision"],
      id: "qwen3-coder-30b:Q4_K_M",
      name: "Qwen3 Coder 30B",
      parameters: "30B",
      vision: true,
    });
    expect(parametersLabel(moe)).toBe("30B · 3B active (MoE)");
    expect(rowBadges(moe)).toEqual(["3B active", "Vision", "Tool use", "+2"]);
    expect(rowBadgesOverflowTitle(moe)).toBe("Reasoning, Coding");

    const dense = localModel({
      architecture: "dense",
      capabilities: ["tool_use"],
      id: "qwen3-4b:Q4_K_M",
      name: "Qwen3 4B",
      parameters: "4B",
    });
    expect(parametersLabel(dense)).toBe("4B (Dense)");
    expect(rowBadges(dense)).toEqual(["4B", "Tool use"]);
    expect(rowBadgesOverflowTitle(dense)).toBeUndefined();

    expect(
      rowBadges(
        localModel({
          id: "llama3.3:Q4_K_M",
          name: "Llama 3.3",
          parameters: "70B",
        }),
      ),
    ).toEqual(["70B"]);
  });

  it("formats live download speed, ETA, prompt speed, and safe source URLs", () => {
    const mb = 1024 * 1024;
    expect(
      downloadStatusDetail(
        localModel({
          download: {
            bytes_per_second: 50 * mb,
            done_bytes: 5_000 * mb,
            step: "download",
            total_bytes: 20_000 * mb,
          },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBe("25% · 50 MB/s · 5m left");
    expect(
      downloadStatusDetail(
        localModel({
          download: { done_bytes: 100, step: "verify", total_bytes: 100 },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBe("checking file");
    expect(
      speedLabel(
        localModel({
          id: "m",
          name: "m",
          prompt_tokens_per_second: 612.4,
          tokens_per_second: 46.2,
        }),
      ),
    ).toBe("46 tokens/s · 612 prompt tokens/s");
    expect(safeModelSourceUrl("http://example.com/model")).toBeUndefined();
    const safe = safeModelSourceUrl("https://huggingface.co/Qwen/Qwen3-4B/");
    expect(safe).toBe("https://huggingface.co/Qwen/Qwen3-4B/");
    expect(modelSourceLabel(safe!)).toBe("huggingface.co/Qwen/Qwen3-4B");
  });

  it("formats download sources, transfer summaries, and cache reuse details", () => {
    const mb = 1024 * 1024;
    expect(downloadSourceLabel("modelscope")).toBe("ModelScope mirror");
    expect(downloadSourceLabel("huggingface")).toBe("Hugging Face");
    expect(downloadSourceLabel("cache")).toBe("Local cache");
    expect(downloadSourceLabel("custom")).toBe("Custom source");
    expect(downloadSourceLabel(undefined)).toBeUndefined();

    expect(
      downloadTransferSummary(localModel({ id: "m", name: "m" })),
    ).toBeUndefined();
    expect(
      downloadTransferSummary(
        localModel({
          download: { done_bytes: 10, step: "download", total_bytes: 100 },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBeUndefined();
    expect(
      downloadTransferSummary(
        localModel({
          download: {
            connections: 4,
            done_bytes: 10,
            source: "modelscope",
            step: "download",
            total_bytes: 100,
          },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBe("ModelScope mirror · 4 connections · binary MB/s (MiB/s)");
    expect(
      downloadTransferSummary(
        localModel({
          download: {
            connections: 1,
            done_bytes: 10,
            source: "huggingface",
            step: "download",
            total_bytes: 100,
          },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBe("Hugging Face · 1 connection · binary MB/s (MiB/s)");
    expect(
      downloadTransferSummary(
        localModel({
          download: {
            connections: 0,
            done_bytes: 10,
            source: "custom",
            step: "download",
            total_bytes: 100,
          },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBe("Custom source · binary MB/s (MiB/s)");
    expect(
      downloadTransferSummary(
        localModel({
          download: {
            connections: 4,
            done_bytes: 10,
            step: "download",
            total_bytes: 100,
          },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBe("4 connections · binary MB/s (MiB/s)");
    expect(
      downloadTransferSummary(
        localModel({
          download: {
            connections: 0,
            done_bytes: 100,
            source: "cache",
            step: "download",
            total_bytes: 100,
          },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBe("Reusing verified local cache");

    expect(
      downloadStatusDetail(
        localModel({
          download: {
            done_bytes: 0,
            source: "cache",
            step: "download",
            total_bytes: 100 * mb,
          },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBe("Reusing local cache…");
    expect(
      downloadStatusDetail(
        localModel({
          download: {
            done_bytes: 100 * mb,
            source: "cache",
            step: "verify",
            total_bytes: 100 * mb,
          },
          id: "m",
          name: "m",
          state: "downloading",
        }),
      ),
    ).toBe("checking file");
  });

  it("computes load percentages and step text with placement fallback", () => {
    const base = localModel({ id: "m", name: "m", state: "loading" });
    expect(loadPercent(base)).toBeNull();
    expect(loadStatusDetail(base, "GPU 0")).toBe("GPU 0");
    expect(loadStatusDetail(base)).toBeNull();

    expect(
      loadPercent({
        ...base,
        load: { done_steps: 0, step: "prepare", total_steps: 0 },
      }),
    ).toBeNull();
    expect(
      loadPercent({
        ...base,
        load: { done_steps: 4, step: "load", total_steps: 7 },
      }),
    ).toBe(57);
    expect(
      loadPercent({
        ...base,
        load: { done_steps: 12, step: "warm", total_steps: 10 },
      }),
    ).toBe(100);

    expect(
      loadStatusDetail(
        {
          ...base,
          load: { done_steps: 0, step: "prepare", total_steps: 7 },
        },
        "GPU 0",
      ),
    ).toBe("Preparing server…");
    expect(
      loadStatusDetail(
        {
          ...base,
          load: { done_steps: 1, step: "start", total_steps: 7 },
        },
        "GPU 0",
      ),
    ).toBe("Starting server…");
    expect(
      loadStatusDetail(
        {
          ...base,
          load: { done_steps: 0, step: "load", total_steps: 7 },
        },
        "GPU 0",
      ),
    ).toBe("Loading weights to GPU 0");
    expect(
      loadStatusDetail(
        {
          ...base,
          load: { done_steps: 4, step: "load", total_steps: 7 },
        },
        "GPU 0",
      ),
    ).toBe("Loading weights to GPU 0 · 57%");
    expect(
      loadStatusDetail({
        ...base,
        load: { done_steps: 4, step: "load", total_steps: 7 },
      }),
    ).toBe("Loading weights · 57%");
    expect(
      loadStatusDetail({
        ...base,
        load: { done_steps: 0, step: "load", total_steps: 7 },
      }),
    ).toBe("Loading weights");
    expect(
      loadStatusDetail({
        ...base,
        load: { done_steps: 7, step: "warm", total_steps: 7 },
      }),
    ).toBe("Warming up · 100%");
    expect(
      loadStatusDetail({
        ...base,
        load: { done_steps: 0, step: "warm", total_steps: 0 },
      }),
    ).toBe("Warming up");
  });
});

describe("downloadStopped", () => {
  const model = (fields: Parameters<typeof localModel>[0]) =>
    localModel(fields);

  it("is true only for a failed model with a download error code", () => {
    const base = { id: "m", name: "M", state: "failed" as const };
    expect(
      downloadStopped(model({ ...base, error: { code: "DOWNLOAD_FAILED" } })),
    ).toBe(true);
    expect(
      downloadStopped(
        model({ ...base, error: { code: "NETWORK_UNAVAILABLE" } }),
      ),
    ).toBe(true);
    expect(
      downloadStopped(
        model({ ...base, error: { code: "ENGINE_START_FAILED" } }),
      ),
    ).toBe(false);
    expect(downloadStopped(model(base))).toBe(false);
    expect(
      downloadStopped(
        model({
          ...base,
          error: { code: "DOWNLOAD_FAILED" },
          state: "downloading",
        }),
      ),
    ).toBe(false);
  });
});

describe("headerMemorySegments and model presence", () => {
  it("reports whether a model holds usable files on the Computer", () => {
    expect(
      isModelOnComputer(localModel({ id: "m", name: "M", state: "loaded" })),
    ).toBe(true);
    expect(
      isModelOnComputer(localModel({ id: "m", name: "M", state: "idle" })),
    ).toBe(true);
    expect(
      isModelOnComputer(
        localModel({
          error: { code: "ENGINE_START_FAILED" },
          id: "m",
          name: "M",
          state: "failed",
        }),
      ),
    ).toBe(true);
    expect(
      isModelOnComputer(
        localModel({
          error: { code: "DOWNLOAD_FAILED" },
          id: "m",
          name: "M",
          state: "failed",
        }),
      ),
    ).toBe(false);
    expect(
      isModelOnComputer(
        localModel({
          availability: { downloadable: true },
          id: "m",
          name: "M",
          state: "absent",
        }),
      ),
    ).toBe(false);
    expect(
      isModelOnComputer(
        localModel({
          availability: { downloadable: false },
          id: "m",
          name: "M",
          state: "absent",
        }),
      ),
    ).toBe(false);
  });

  it("aggregates GPU pool segments including models, components, and other apps", () => {
    const view = labView({
      pools: [
        {
          ...gpuPool(0, 24, [{ gb: 12, id: "coder", name: "Coder" }]),
          used_bytes: gb(16),
        },
        gpuPool(1, 24, [
          { component: true, gb: 2, id: "embedding", name: "Embedding" },
        ]),
      ],
    });
    const segments = headerMemorySegments(view);
    expect(segments).toEqual([
      {
        bytes: gb(12),
        id: "coder",
        kind: "model",
        modelIndex: 0,
        name: "Coder",
        percent: 25,
      },
      {
        bytes: gb(2),
        id: "embedding",
        kind: "component",
        name: "Embedding",
        percent: (gb(2) / gb(48)) * 100,
      },
      {
        bytes: gb(4),
        id: "other-apps",
        kind: "other",
        name: "Other apps",
        percent: (gb(4) / gb(48)) * 100,
      },
    ]);
  });
});

describe("computer selection and storage persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function computer(
    id: string,
    displayName: string,
    status: "online" | "offline",
    piModelIds: string[] = [],
  ) {
    return {
      computer_id: id,
      display_name: displayName,
      runtimes: [
        {
          models: piModelIds.map((modelId) => ({
            id: modelId,
            label: modelId,
          })),
          status: "ready" as const,
          type: "pi" as const,
        },
      ],
      status,
    };
  }

  it("counts localmodels-library Pi models and formats picker labels", () => {
    const idleBox = computer("c1", "lab-118", "online", ["pi-default"]);
    const loadedBox = computer("c2", "Workstation", "online", [
      "pi-default",
      "localmodels-library/qwen3",
      "localmodels-library/gemma3",
    ]);
    const offlineBox = computer("c3", "Mac Studio", "offline", [
      "localmodels-library/gpt-oss",
    ]);

    expect(loadedLibraryModelCount(idleBox)).toBe(0);
    expect(loadedLibraryModelCount(loadedBox)).toBe(2);
    expect(computerPickerLabel(idleBox)).toBe("lab-118");
    expect(computerPickerLabel(loadedBox)).toBe("Workstation · 2 loaded");
    expect(computerPickerLabel(offlineBox)).toBe("Mac Studio · Offline");
  });

  it("follows desktop, remembered, online with library model, online, then first", () => {
    const offline = computer("c-off", "Offline", "offline", [
      "localmodels-library/m1",
    ]);
    const onlineEmpty = computer("c-empty", "Empty", "online");
    const onlineLoaded = computer("c-loaded", "Loaded", "online", [
      "localmodels-library/m2",
    ]);
    const list = [offline, onlineEmpty, onlineLoaded];

    expect(
      selectDefaultLocalModelsComputer(list, {
        desktopComputerId: "c-empty",
        rememberedComputerId: "c-off",
      })?.computer_id,
    ).toBe("c-empty");

    expect(
      selectDefaultLocalModelsComputer(list, {
        rememberedComputerId: "c-off",
      })?.computer_id,
    ).toBe("c-off");

    expect(
      selectDefaultLocalModelsComputer(list, {
        rememberedComputerId: "c-missing",
      })?.computer_id,
    ).toBe("c-loaded");

    expect(
      selectDefaultLocalModelsComputer([offline, onlineEmpty])?.computer_id,
    ).toBe("c-empty");

    expect(selectDefaultLocalModelsComputer([offline])?.computer_id).toBe(
      "c-off",
    );
  });

  it("reads and writes per-tenant computer preference safely", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
    rememberLocalModelsComputerId("tenant-1", "computer-mac");
    expect(store.get(localModelsComputerStorageKey("tenant-1"))).toBe(
      "computer-mac",
    );
    expect(readRememberedLocalModelsComputerId("tenant-1")).toBe(
      "computer-mac",
    );

    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => rememberLocalModelsComputerId("tenant-1", "c")).not.toThrow();
    expect(readRememberedLocalModelsComputerId("tenant-1")).toBeUndefined();
  });
});
