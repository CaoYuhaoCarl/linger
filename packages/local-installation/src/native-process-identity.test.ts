import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));

import {
  currentNativeBirth,
  nativeProcessIdentity,
} from "./native-process-identity.js";

const lease = "a".repeat(64);
const pid = 43190;
const uid = 501;
// lstart as macOS ps prints it (strftime %c) for one start time.
const lstart: Record<string, string> = {
  C: "Wed Nov 18 14:36:05 2026",
  "zh_CN.UTF-8": "三 11月/18 14:36:05 2026",
  "de_DE.UTF-8": "Mi 18 Nov 14:36:05 2026",
  "ja_JP.UTF-8": "水 11/18 14:36:05 2026",
};
const birth = `darwin:Wed:Nov:18:14:36:05:2026:${uid}:${pid}`;

// A stand-in for /bin/ps that honours LC_ALL > LANG like the real one.
function fakePs(terminalLocale: string, state = "Ss") {
  execFile.mockImplementation(
    (
      _file: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
      done: (error: Error | null, stdout: string) => void,
    ) => {
      const locale = options.env.LC_ALL ?? options.env.LANG ?? "C";
      const start = lstart[locale] ?? lstart.C!;
      const format = args[args.length - 1]!;
      if (format === "command=")
        done(null, `/node worker.mjs LINGER_NATIVE_PROCESS_LEASE=${lease}\n`);
      else if (format === "uid=,pgid=,stat=,lstart=")
        done(null, `  ${uid} ${pid} ${state}   ${start}\n`);
      else if (format === "lstart=,uid=,pgid=,stat=")
        done(null, `${start}   ${uid} ${pid} ${state}\n`);
      else done(new Error(`unexpected ps ${format}`), "");
    },
  );
  vi.stubEnv("LANG", terminalLocale);
}

describe("nativeProcessIdentity on macOS", () => {
  const platform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.spyOn(process, "getuid").mockReturnValue(uid);
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    execFile.mockReset();
  });

  it.each(Object.keys(lstart))(
    "records the C-locale birth when launched under %s",
    async (locale) => {
      fakePs(locale);
      await expect(nativeProcessIdentity(pid, lease)).resolves.toBe(birth);
    },
  );

  it("parses the fixed fields even if ps ignores the C locale", async () => {
    fakePs("zh_CN.UTF-8");
    execFile.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        done: (error: Error | null, stdout: string) => void,
      ) => done(null, ` ${uid} ${pid} Ss ${lstart["zh_CN.UTF-8"]}\n`),
    );
    await expect(nativeProcessIdentity(pid, lease)).resolves.toBe(
      `darwin:三:11月/18:14:36:05:2026:${uid}:${pid}`,
    );
  });

  it("rejects another user's process, a non-leader and a zombie", async () => {
    fakePs("zh_CN.UTF-8");
    vi.spyOn(process, "getuid").mockReturnValue(502);
    await expect(nativeProcessIdentity(pid, lease)).resolves.toBeUndefined();
    vi.spyOn(process, "getuid").mockReturnValue(uid);
    await expect(
      nativeProcessIdentity(pid + 1, lease),
    ).resolves.toBeUndefined();
    await expect(
      nativeProcessIdentity(pid + 1, lease, false),
    ).resolves.toBeDefined();
    fakePs("zh_CN.UTF-8", "Z");
    await expect(nativeProcessIdentity(pid, lease)).resolves.toBeUndefined();
  });

  it("carries a record written in a terminal's locale over to the C form", async () => {
    fakePs("de_DE.UTF-8");
    await expect(
      currentNativeBirth(
        pid,
        lease,
        `darwin:Mi:18:Nov:14:36:05:2026:${uid}:${pid}`,
      ),
    ).resolves.toBe(birth);
  });

  it("leaves C-locale and mismatched records alone", async () => {
    fakePs("de_DE.UTF-8");
    await expect(
      currentNativeBirth(pid, lease, birth),
    ).resolves.toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
    await expect(
      currentNativeBirth(
        pid,
        lease,
        `darwin:Di:17:Nov:09:00:00:2026:${uid}:${pid}`,
      ),
    ).resolves.toBeUndefined();
  });
});
