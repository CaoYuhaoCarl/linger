import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ComputerDaemonModule } from "./computer-daemon.js";
import type { DesktopConfig } from "./config.js";
import {
  npmTarball,
  stubModule,
  tempDirectory,
  testHost,
} from "./test-support.js";
import {
  UPDATE_NPM_PACKAGE,
  distTagsUrl,
  npmTarballUrl,
  partNpmPackage,
} from "./update-npm.js";
import {
  type SpawnSetup,
  type UpdateState,
  type UpdaterOptions,
  UpdaterModule,
  appBundleOf,
  updateInstallFor,
} from "./updater.js";

const RELEASES = "https://github.com/simplexai-labs/linger/releases";
const MIRROR = "https://registry.npmmirror.com/";
const NPMJS = "https://registry.npmjs.org/";
const PACKAGE = Buffer.from("new app archive");
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const PACKAGE_JSON: [string, Buffer] = [
  "package/package.json",
  Buffer.from('{"name":"x"}'),
];

beforeEach(() => {
  vi.stubEnv("SIMPLEX_REGION", "");
  return () => vi.unstubAllEnvs();
});

const release = (
  version: string,
  {
    body = PACKAGE,
    target = "darwin-arm64",
    file = `Linger-${version}-macos-arm64.app.tar.gz`,
    feed = RELEASES,
    // Splits the package into parts of this size, as the release does.
    partSize = 0,
    // Registries that hold the npm packages of the release.
    npm = [] as readonly string[],
    // The version npm has, when it lags the release.
    npmVersion = version,
  } = {},
) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pieces: Buffer[] = [];
  for (let i = 0; partSize && i < PACKAGE.length; i += partSize)
    pieces.push(PACKAGE.subarray(i, i + partSize));
  const manifestOf = (version: string) =>
    Buffer.from(
      JSON.stringify({
        schema: 2,
        version,
        packages: {
          [target]: {
            file,
            sha256: sha256(PACKAGE),
            size: PACKAGE.length,
            ...(partSize
              ? {
                  parts: pieces.map((piece) => ({
                    sha256: sha256(piece),
                    size: piece.length,
                  })),
                }
              : {}),
          },
        },
      }),
    );
  const signatureOf = (manifest: Buffer) =>
    Buffer.from(sign(null, manifest, privateKey).toString("base64"));
  const manifest = manifestOf(version);
  const signature = signatureOf(manifest);
  const npmManifest = manifestOf(npmVersion);
  const files: Record<string, Buffer> = {
    [`${feed}/latest/download/manifest.json`]: manifest,
    [`${feed}/latest/download/manifest.json.sig`]: signature,
    [`${feed}/download/desktop-v${version}/${file}`]: body,
  };
  for (const registry of npm) {
    files[distTagsUrl(registry, UPDATE_NPM_PACKAGE).toString()] = Buffer.from(
      JSON.stringify({ latest: npmVersion }),
    );
    files[npmTarballUrl(registry, UPDATE_NPM_PACKAGE, npmVersion).toString()] =
      npmTarball([
        PACKAGE_JSON,
        ["package/manifest.json", npmManifest],
        ["package/manifest.json.sig", signatureOf(npmManifest)],
      ]);
    pieces.forEach((piece, index) => {
      files[partUrl(registry, target, index, npmVersion)] = npmTarball([
        PACKAGE_JSON,
        ["package/part", piece],
      ]);
    });
  }
  const requested: string[] = [];
  // Hosts whose connections fail.
  const unreachable = new Set<string>();
  const fetch = (async (url: URL) => {
    requested.push(url.toString());
    if (unreachable.has(url.host)) throw new TypeError("fetch failed");
    const content = files[url.toString()];
    return content
      ? new Response(new Uint8Array(content))
      : new Response("missing", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    files,
    manifest,
    signature,
    requested,
    unreachable,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};

const partUrl = (
  registry: string,
  target: string,
  index: number,
  version: string,
) => npmTarballUrl(registry, partNpmPackage(target, index), version).toString();
const manifestUrl = (registry: string, version: string) =>
  npmTarballUrl(registry, UPDATE_NPM_PACKAGE, version).toString();
const tagsUrl = (registry: string) =>
  distTagsUrl(registry, UPDATE_NPM_PACKAGE).toString();

const setup = async (
  feed: ReturnType<typeof release>,
  options: Partial<UpdaterOptions> = {},
  config: Partial<DesktopConfig> = {},
  region: "cn" | "global" = "global",
) => {
  const root = tempDirectory();
  // The home's download region, resolved earlier (region.ts).
  const home = path.join(root, "home");
  mkdirSync(path.join(home, "runtime"), { recursive: true });
  writeFileSync(
    path.join(home, "runtime", "region.json"),
    JSON.stringify({
      schema: "simplex.region/v1",
      region,
      resolved_at: new Date().toISOString(),
      method: "probe",
    }),
  );
  const applications = path.join(root, "Applications");
  const bundle = path.join(applications, "Linger.app");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(path.join(bundle, "version"), "0.16.7");
  const downloads = path.join(root, "updates");
  let running = 0;
  let restarts = 0;
  let quits = 0;
  const opened: string[] = [];
  const announced: UpdateState[] = [];
  const runtime = {
    ...stubModule("ComputerDaemon"),
    running: () => running,
  } as unknown as ComputerDaemonModule;
  const updater = new UpdaterModule({
    version: "0.16.7",
    platform: "darwin",
    arch: "arm64",
    install: { kind: "app-bundle", appBundle: bundle },
    downloadDirectory: downloads,
    home,
    restart: async () => {
      restarts += 1;
    },
    quit: async () => {
      quits += 1;
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    announce: (state) => announced.push(state),
    fetch: feed.fetch,
    publicKey: feed.publicKey,
    checkDelayMs: 60 * 60_000,
    // The test archive holds the new version marker, not a real tarball.
    extract: async (archive, directory) => {
      const app = path.join(directory, "Linger.app");
      mkdirSync(app);
      writeFileSync(path.join(app, "version"), readFileSync(archive));
    },
    ...options,
  });
  const host = testHost([stubModule("Config"), runtime, updater], config);
  await host.start();
  const setRunning = (n: number) => {
    running = n;
    host.ctx.bus.emit("runtime.activity", n);
  };
  return {
    host,
    updater,
    bundle,
    applications,
    downloads,
    home,
    region: () =>
      JSON.parse(
        readFileSync(path.join(home, "runtime", "region.json"), "utf8"),
      ) as { region: string; method: string },
    setRunning,
    opened,
    announced,
    restarts: () => restarts,
    quits: () => quits,
  };
};

describe("UpdaterModule", () => {
  it("installs a verified update from the latest release once running tasks finish", async () => {
    const feed = release("0.17.0");
    const {
      updater,
      bundle,
      applications,
      setRunning,
      restarts,
      host,
      announced,
    } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    expect(feed.requested).toEqual([
      `${RELEASES}/latest/download/manifest.json`,
      `${RELEASES}/latest/download/manifest.json.sig`,
      // From the release the signed manifest names, not whatever is latest
      // by the time of the download.
      `${RELEASES}/download/desktop-v0.17.0/Linger-0.17.0-macos-arm64.app.tar.gz`,
    ]);
    expect(announced).toEqual([{ kind: "ready", version: "0.17.0" }]);
    expect(readFileSync(path.join(bundle, "version"), "utf8")).toBe("0.16.7");

    setRunning(1);
    await updater.install();
    expect(updater.state()).toEqual({ kind: "waiting", version: "0.17.0" });
    expect(restarts()).toBe(0);

    setRunning(0);
    await waitFor(() => restarts() === 1);
    expect(readFileSync(path.join(bundle, "version"), "utf8")).toBe(
      PACKAGE.toString(),
    );
    // The replaced bundle stays until the next launch cleans it up.
    expect(readdirSync(applications).sort()).toEqual([
      expect.stringMatching(/^\.Linger-old-/),
      "Linger.app",
    ]);
    await host.stop("update");
    const next = new UpdaterModule({
      version: "0.17.0",
      platform: "darwin",
      arch: "arm64",
      install: { kind: "app-bundle", appBundle: bundle },
      downloadDirectory: tempDirectory(),
      home: tempDirectory(),
      restart: async () => {},
      quit: async () => {},
      openExternal: async () => {},
      checkDelayMs: 60 * 60_000,
    });
    await testHost([stubModule("Config"), stubModule("ComputerDaemon"), next])
      .start()
      .then(() => waitFor(() => readdirSync(applications).length === 1));
    expect(readdirSync(applications)).toEqual(["Linger.app"]);
  });

  it("refuses a manifest signed by another key", async () => {
    const feed = {
      ...release("0.17.0"),
      publicKey: release("0.17.0").publicKey,
    };
    const { updater } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Update signature does not match",
    });
    expect(feed.requested).toHaveLength(2);
  });

  it("refuses a package that does not match its checksum", async () => {
    const feed = release("0.17.0", { body: Buffer.from("new app archivX") });
    const { updater, downloads, applications } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Update package does not match its checksum",
    });
    expect(readdirSync(downloads)).toEqual([]);
    expect(readdirSync(applications)).toEqual(["Linger.app"]);
    await updater.install();
    expect(updater.state().kind).toBe("failed");
  });

  it("retries a dropped download soon instead of waiting a full interval", async () => {
    const feed = release("0.17.0");
    let drops = 1;
    const flaky = (async (url: URL) => {
      if (url.pathname.endsWith(".tar.gz") && drops-- > 0)
        throw new TypeError("terminated");
      return feed.fetch(url);
    }) as unknown as typeof globalThis.fetch;
    const { updater, host } = await setup(feed, {
      fetch: flaky,
      checkDelayMs: 1,
      retryDelayMs: 1,
      checkIntervalMs: 60 * 60_000,
    });
    await waitFor(() => updater.state().kind === "ready");
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    await host.stop("quit");
  });

  it("stays idle when the latest release is not newer", async () => {
    const feed = release("0.16.7");
    const { updater } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({ kind: "idle" });
    expect(feed.requested).toHaveLength(2);
  });

  it("updates a prerelease to its release", async () => {
    const feed = release("0.16.7");
    const { updater } = await setup(feed, { version: "0.16.7-rc.2" });
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: "0.16.7" });
  });

  it("stays idle when the latest release has no manifest", async () => {
    const feed = release("0.17.0");
    delete feed.files[`${RELEASES}/latest/download/manifest.json.sig`];
    const { updater, announced } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({ kind: "idle" });
    expect(announced).toEqual([]);
  });

  it("reads the feed the config names and refuses one without https", async () => {
    const own = "https://releases.example.com/linger";
    const feed = release("0.17.0", { feed: own });
    const { updater } = await setup(feed, {}, { updateFeedUrl: own });
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    expect(feed.requested[0]).toBe(`${own}/latest/download/manifest.json`);

    const plain = await setup(
      release("0.17.0"),
      {},
      { updateFeedUrl: "http://releases.example.com/linger" },
    );
    await plain.updater.check();
    expect(plain.updater.state()).toEqual({
      kind: "failed",
      error: "The update feed must use https",
    });
  });
});

describe("UpdaterModule with the npm packages", () => {
  const VERSION = "0.17.0";
  const TARGET = "darwin-arm64";
  const ASSET = `${RELEASES}/download/desktop-v${VERSION}/Linger-${VERSION}-macos-arm64.app.tar.gz`;
  const parts = (registry: string) =>
    [0, 1, 2].map((index) => partUrl(registry, TARGET, index, VERSION));
  const published = (npm: readonly string[] = [MIRROR, NPMJS]) =>
    release(VERSION, { partSize: 6, npm });

  it("in cn takes the manifest and the parts from the China mirror", async () => {
    const feed = published();
    const { updater, bundle, downloads, restarts, region } = await setup(
      feed,
      {},
      {},
      "cn",
    );
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: VERSION });
    expect(feed.requested).toEqual([
      tagsUrl(MIRROR),
      manifestUrl(MIRROR, VERSION),
      ...parts(MIRROR),
    ]);
    expect(feed.requested[1]).toMatch(/^https:\/\/cdn\.npmmirror\.com\//);
    expect(readdirSync(downloads)).toEqual([]);
    await updater.install();
    await waitFor(() => restarts() === 1);
    // The joined parts are the package the manifest names.
    expect(readFileSync(path.join(bundle, "version"))).toEqual(PACKAGE);
    expect(region()).toMatchObject({ region: "cn", method: "probe" });
  });

  it("in cn takes a tampered part from npm instead and prefers global after", async () => {
    const feed = published();
    feed.files[parts(MIRROR)[1]!] = npmTarball([
      ["package/part", Buffer.from("XXXXXX")],
    ]);
    const { updater, bundle, restarts, region } = await setup(
      feed,
      {},
      {},
      "cn",
    );
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: VERSION });
    expect(feed.requested.slice(2)).toEqual([
      parts(MIRROR)[0],
      parts(MIRROR)[1],
      parts(NPMJS)[1],
      parts(MIRROR)[2],
    ]);
    await updater.install();
    await waitFor(() => restarts() === 1);
    expect(readFileSync(path.join(bundle, "version"))).toEqual(PACKAGE);
    expect(region()).toMatchObject({ region: "global", method: "fallback" });
  });

  it("in cn takes the release asset when a part is on no registry", async () => {
    const feed = published([MIRROR]);
    delete feed.files[parts(MIRROR)[2]!];
    const { updater, downloads, region } = await setup(feed, {}, {}, "cn");
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: VERSION });
    expect(feed.requested.slice(-3)).toEqual([
      parts(MIRROR)[2],
      parts(NPMJS)[2],
      ASSET,
    ]);
    expect(readdirSync(downloads)).toEqual([]);
    // A part the mirror has not synced yet says nothing about the network.
    expect(region()).toMatchObject({ region: "cn", method: "probe" });
  });

  it("in cn refuses a manifest whose package was tampered with", async () => {
    const feed = published([MIRROR]);
    const tampered = Buffer.from(
      feed.manifest.toString().replace(sha256(PACKAGE), "0".repeat(64)),
    );
    feed.files[manifestUrl(MIRROR, VERSION)] = npmTarball([
      ["package/manifest.json", tampered],
      ["package/manifest.json.sig", feed.signature],
    ]);
    delete feed.files[`${RELEASES}/latest/download/manifest.json`];
    const { updater } = await setup(feed, {}, {}, "cn");
    await updater.check();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Update signature does not match",
    });
    expect(feed.requested.some((url) => url.includes("-part"))).toBe(false);
  });

  it("in cn checks a manifest from npm against the built-in key", async () => {
    // Signed by the release key, so only UPDATE_PUBLIC_KEY decides.
    const feed = published([MIRROR]);
    const { updater } = await setup(feed, { publicKey: undefined }, {}, "cn");
    await updater.check();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Update signature does not match",
    });
  });

  it("in cn falls back to the release feed when npm is unreachable", async () => {
    const feed = published();
    feed.unreachable.add("registry.npmmirror.com");
    feed.unreachable.add("cdn.npmmirror.com");
    feed.unreachable.add("registry.npmjs.org");
    const { updater, region } = await setup(feed, {}, {}, "cn");
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: VERSION });
    expect(feed.requested).toEqual([
      tagsUrl(MIRROR),
      tagsUrl(NPMJS),
      `${RELEASES}/latest/download/manifest.json`,
      `${RELEASES}/latest/download/manifest.json.sig`,
      // A manifest only the release served: its package comes from there.
      ASSET,
    ]);
    expect(region()).toMatchObject({ region: "global", method: "fallback" });
  });

  it("in cn takes a version npm lacks from the release", async () => {
    // npm still has the running version: its publish failed or was skipped.
    const feed = release(VERSION, {
      partSize: 6,
      npm: [MIRROR, NPMJS],
      npmVersion: "0.16.7",
    });
    const { updater, bundle, restarts, region } = await setup(
      feed,
      {},
      {},
      "cn",
    );
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: VERSION });
    expect(feed.requested).toEqual([
      tagsUrl(MIRROR),
      manifestUrl(MIRROR, "0.16.7"),
      tagsUrl(NPMJS),
      manifestUrl(NPMJS, "0.16.7"),
      `${RELEASES}/latest/download/manifest.json`,
      `${RELEASES}/latest/download/manifest.json.sig`,
      ASSET,
    ]);
    await updater.install();
    await waitFor(() => restarts() === 1);
    expect(readFileSync(path.join(bundle, "version"))).toEqual(PACKAGE);
    expect(region()).toMatchObject({ region: "cn", method: "probe" });
  });

  it("in cn stays idle when npm is current and GitHub cannot be reached", async () => {
    const feed = release("0.16.7", { partSize: 6, npm: [MIRROR, NPMJS] });
    feed.unreachable.add("github.com");
    const { updater } = await setup(feed, {}, {}, "cn");
    await updater.check();
    expect(updater.state()).toEqual({ kind: "idle" });
  });

  it("does not offer a prerelease npm tags latest", async () => {
    const feed = release("0.17.0-rc.1", { partSize: 6, npm: [MIRROR] });
    delete feed.files[`${RELEASES}/latest/download/manifest.json`];
    const { updater } = await setup(feed, {}, {}, "cn");
    await updater.check();
    expect(updater.state()).toEqual({ kind: "idle" });
    expect(feed.requested).toContain(tagsUrl(MIRROR));
    expect(feed.requested).not.toContain(manifestUrl(MIRROR, "0.17.0-rc.1"));
  });

  it("in global keeps to the release while it answers", async () => {
    const feed = published();
    const { updater } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: VERSION });
    expect(feed.requested).toEqual([
      `${RELEASES}/latest/download/manifest.json`,
      `${RELEASES}/latest/download/manifest.json.sig`,
      ASSET,
    ]);
  });

  it("in global falls back to npm when the release cannot be reached", async () => {
    const feed = published();
    feed.unreachable.add("github.com");
    const { updater, bundle, restarts, region } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: VERSION });
    expect(feed.requested).toEqual([
      `${RELEASES}/latest/download/manifest.json`,
      `${RELEASES}/latest/download/manifest.json.sig`,
      tagsUrl(NPMJS),
      manifestUrl(NPMJS, VERSION),
      ASSET,
      ...parts(NPMJS),
    ]);
    await updater.install();
    await waitFor(() => restarts() === 1);
    expect(readFileSync(path.join(bundle, "version"))).toEqual(PACKAGE);
    expect(region()).toMatchObject({ region: "global", method: "probe" });
  });

  it("asks no npm registry for a feed of its own", async () => {
    const own = "https://releases.example.com/linger";
    const feed = release(VERSION, { feed: own, partSize: 6, npm: [MIRROR] });
    const { updater } = await setup(feed, {}, { updateFeedUrl: own }, "cn");
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: VERSION });
    expect(feed.requested.every((url) => url.startsWith(own))).toBe(true);
  });
});

describe("UpdaterModule with the Windows setup program", () => {
  const SETUP = "Linger-0.17.0-windows-x64-setup.exe";
  const windows = async (spawn: SpawnSetup) => {
    const feed = release("0.17.0", { target: "win32-x64", file: SETUP });
    return {
      feed,
      ...(await setup(feed, {
        platform: "win32",
        arch: "x64",
        install: { kind: "windows-setup" },
        spawn,
      })),
    };
  };
  const recorder = () => {
    const calls: { file: string; args: readonly string[]; options: object }[] =
      [];
    const spawn: SpawnSetup = (file, args, options) => {
      calls.push({ file, args, options });
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    };
    return { calls, spawn };
  };

  it("runs the verified setup program silently once tasks finish, then quits", async () => {
    const { calls, spawn } = recorder();
    const { updater, downloads, feed, setRunning, quits, restarts } =
      await windows(spawn);
    await updater.check();
    expect(feed.requested.at(-1)).toBe(
      `${RELEASES}/download/desktop-v0.17.0/${SETUP}`,
    );
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    expect(readdirSync(downloads)).toEqual([SETUP]);

    setRunning(2);
    await updater.install();
    expect(updater.state()).toEqual({ kind: "waiting", version: "0.17.0" });
    expect(calls).toEqual([]);

    setRunning(0);
    await waitFor(() => quits() === 1);
    expect(calls).toEqual([
      {
        file: path.join(downloads, SETUP),
        args: ["/update", "/relaunch"],
        options: { detached: true, stdio: "ignore" },
      },
    ]);
    expect(restarts()).toBe(0);
  });

  it("does not run a setup program that changed after its download", async () => {
    const { calls, spawn } = recorder();
    const { updater, downloads, quits } = await windows(spawn);
    await updater.check();
    writeFileSync(path.join(downloads, SETUP), "something else");
    await updater.install();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Update package does not match its checksum",
    });
    expect(calls).toEqual([]);
    expect(quits()).toBe(0);
  });

  it("stays when the setup program cannot start", async () => {
    const spawn: SpawnSetup = () => {
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
      return child;
    };
    const { updater, quits } = await windows(spawn);
    await updater.check();
    await updater.install();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Error: spawn EACCES",
    });
    expect(quits()).toBe(0);
  });
});

describe("UpdaterModule for a download", () => {
  it("links a newer release without downloading it", async () => {
    const feed = release("0.17.0", {
      target: "linux-x64",
      file: "Linger-0.17.0-linux-x64.tar.gz",
    });
    const { updater, opened, announced, downloads } = await setup(feed, {
      platform: "linux",
      arch: "x64",
      install: { kind: "download" },
    });
    await updater.check();
    const available = {
      kind: "available",
      version: "0.17.0",
      url: `${RELEASES}/tag/desktop-v0.17.0`,
    };
    expect(updater.state()).toEqual(available);
    expect(feed.requested).toHaveLength(2);
    expect(() => readdirSync(downloads)).toThrow();

    await updater.check();
    expect(announced).toEqual([available]);
    await updater.install();
    expect(opened).toEqual([available.url]);
    expect(updater.state()).toEqual(available);
  });

  it("stays idle when the release has nothing for this platform", async () => {
    const feed = release("0.17.0");
    const { updater } = await setup(feed, {
      platform: "linux",
      arch: "x64",
      install: { kind: "download" },
    });
    await updater.check();
    expect(updater.state()).toEqual({ kind: "idle" });
  });
});

describe("updateInstallFor", () => {
  it("swaps the macOS bundle, runs the Windows setup and links elsewhere", () => {
    const none = () => false;
    expect(
      updateInstallFor(
        "darwin",
        "/Applications/Linger.app/Contents/MacOS/Linger",
        none,
      ),
    ).toEqual({ kind: "app-bundle", appBundle: "/Applications/Linger.app" });
    const installed = "C:\\Users\\a\\AppData\\Local\\Programs\\Linger";
    expect(
      updateInstallFor(
        "win32",
        `${installed}\\Linger.exe`,
        (file) => file === `${installed}\\Uninstall Linger.exe`,
      ),
    ).toEqual({ kind: "windows-setup" });
    // The portable folder has no uninstaller.
    expect(updateInstallFor("win32", "D:\\Linger\\Linger.exe", none)).toEqual({
      kind: "download",
    });
    expect(updateInstallFor("linux", "/opt/linger/linger", none)).toEqual({
      kind: "download",
    });
  });
});

describe("appBundleOf", () => {
  it("finds the app bundle around the executable", () => {
    expect(appBundleOf("/Applications/Linger.app/Contents/MacOS/Linger")).toBe(
      "/Applications/Linger.app",
    );
    expect(appBundleOf("/usr/lib/electron/electron")).toBeUndefined();
  });
});

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
};
