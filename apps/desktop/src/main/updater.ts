import { execFile, spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import {
  recordRegionFallback,
  resolveRegion,
  type Region,
} from "@linger/local-installation/region";
import { orderByRegion, sourceRegion } from "@linger/service-kit";

import type { ComputerDaemonModule } from "./computer-daemon.js";
import type { Module, ModuleContext } from "./modules.js";
import {
  DEFAULT_FEED_URL,
  ManifestError,
  UPDATE_PUBLIC_KEY,
  compareVersions,
  feedUrls,
  isReleaseVersion,
  packageFor,
  packageUrl,
  releasePageUrl,
  verifyManifest,
  type UpdateManifest,
  type UpdatePackage,
} from "./update-manifest.js";
import {
  NPM_MANIFEST_MEMBER,
  NPM_PART_MEMBER,
  NPM_REGISTRIES,
  NPM_SIGNATURE_MEMBER,
  UPDATE_NPM_PACKAGE,
  distTagsUrl,
  extractNpmTarball,
  npmTarballUrl,
  partNpmPackage,
} from "./update-npm.js";

export type UpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "downloading"; readonly version: string }
  | { readonly kind: "ready"; readonly version: string }
  // Restart was chosen while tasks ran; it happens once they finish.
  | { readonly kind: "waiting"; readonly version: string }
  | { readonly kind: "installing"; readonly version: string }
  // A newer release this installation cannot apply itself; `url` is its
  // release page.
  | {
      readonly kind: "available";
      readonly version: string;
      readonly url: string;
    }
  | { readonly kind: "failed"; readonly error: string };

export type AnnouncedUpdate = Extract<
  UpdateState,
  { kind: "ready" | "available" }
>;

// How this installation takes a newer release.
export type UpdateInstall =
  // macOS: the installed Linger.app, swapped for the release's app archive.
  | { readonly kind: "app-bundle"; readonly appBundle: string }
  // Windows, installed by the setup program: the release's setup program
  // runs silently over the installation and starts Linger again.
  | { readonly kind: "windows-setup" }
  // Linux and the portable Windows folder: the person downloads the release.
  | { readonly kind: "download" };

export interface UpdaterOptions {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  // Without one (development) the updater asks no feed.
  readonly install: UpdateInstall | undefined;
  // Downloads live here until they are installed.
  readonly downloadDirectory: string;
  // The Linger home whose download region (region.ts) orders the sources
  // of the default feed.
  readonly home: string;
  // Stops modules, including the daemon, and relaunches the app from
  // the app bundle, which by then holds the new version and its daemon.
  readonly restart: () => Promise<void>;
  // Stops modules and quits without relaunching: the setup program, already
  // running, replaces the files and starts the new version.
  readonly quit: () => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
  // Tells the person once per version that an update is ready or available.
  readonly announce?: (state: AnnouncedUpdate) => void;
  readonly fetch?: typeof fetch;
  readonly extract?: (archive: string, directory: string) => Promise<void>;
  readonly spawn?: SpawnSetup;
  readonly publicKey?: string;
  readonly checkDelayMs?: number;
  readonly checkIntervalMs?: number;
  readonly retryDelayMs?: number;
}

export interface SetupProcess {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}
export type SpawnSetup = (
  file: string,
  args: readonly string[],
  options: { detached: true; stdio: "ignore" },
) => SetupProcess;

// installer.nsi: /update shows only its progress page and the questions about
// a locked file, then closes; /relaunch starts Linger after.
export const SETUP_ARGS = ["/update", "/relaunch"] as const;

const CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 60 * 60_000;
// A dropped connection should not cost a whole check interval.
const RETRY_DELAY_MS = 5 * 60_000;
const MANIFEST_MAX = 1024 * 1024;
const SIGNATURE_MAX = 4096;
const STAGED_PREFIX = ".Linger-update-";
const OLD_PREFIX = ".Linger-old-";

const run = promisify(execFile);

// /usr/bin/tar keeps the symlinks and code signatures inside the bundle.
const untar = async (archive: string, directory: string): Promise<void> => {
  await run("/usr/bin/tar", ["-xzf", archive, "-C", directory]);
};

export class UpdateError extends Error {}
// The source does not have the file (yet: the mirror syncs a new version
// minutes after it is published). Unlike other failures it says nothing
// about the region's network.
class UpdateNotFound extends UpdateError {}

// Where one check takes its files from.
interface Route {
  readonly region: Region;
  // The npm packages mirror the default feed only; a feed of its own is the
  // only source.
  readonly npm: boolean;
  // A source in `region` failed for a reason other than not having the file.
  regionFailed: boolean;
  // The manifest came from npm, so its parts are there too; in cn a manifest
  // only the release had is downloaded from the release.
  fromNpm: boolean;
}

// Self-update without Squirrel: a signed manifest in the newest GitHub
// Release (or a feed with the same layout), a sha256-checked package from
// that same release, and an install that waits for running tasks. The same
// manifest and the package in parts also come as npm packages, which the
// China mirror serves to homes in the cn region (update-npm.ts). Sign-in and
// the computer identity live outside the installed app, so they carry over.
export class UpdaterModule implements Module {
  readonly name = "Updater";
  readonly dependsOn = ["Config", "ComputerDaemon"];
  readonly #options: UpdaterOptions;
  #ctx: ModuleContext | undefined;
  #state: UpdateState = { kind: "idle" };
  // The unpacked app bundle (macOS) or the downloaded setup program
  // (Windows), with the package it came from.
  #staged: { path: string; pkg: UpdatePackage } | undefined;
  #timer: NodeJS.Timeout | undefined;
  #checking: Promise<void> | undefined;
  readonly #announced = new Set<string>();
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: UpdaterOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    if (!this.#options.install) return;
    void this.#cleanup();
    const schedule = (delay: number): void => {
      this.#timer = setTimeout(() => {
        void this.check().finally(() =>
          schedule(
            this.#state.kind === "failed"
              ? (this.#options.retryDelayMs ?? RETRY_DELAY_MS)
              : (this.#options.checkIntervalMs ?? CHECK_INTERVAL_MS),
          ),
        );
      }, delay);
      this.#timer.unref?.();
    };
    schedule(this.#options.checkDelayMs ?? CHECK_DELAY_MS);
  }

  async stop(): Promise<void> {
    clearTimeout(this.#timer);
    for (const off of this.#unsubscribe.splice(0)) off();
  }

  state(): UpdateState {
    return this.#state;
  }

  // Fetches and verifies the manifest, then downloads a newer package. Only
  // one check runs at a time; a downloaded update is not checked again.
  check(): Promise<void> {
    if (!this.#options.install) return Promise.resolve();
    const state = this.#state;
    const settled =
      state.kind === "idle" ||
      state.kind === "failed" ||
      state.kind === "available";
    if (!settled) return this.#checking ?? Promise.resolve();
    this.#checking = this.#check().finally(() => (this.#checking = undefined));
    return this.#checking;
  }

  // "Restart to Update" or "Download". With tasks running, the restart
  // waits for them.
  async install(): Promise<void> {
    const state = this.#state;
    if (state.kind === "available") {
      await this.#options.openExternal(state.url);
      return;
    }
    if (state.kind !== "ready" && state.kind !== "waiting") return;
    const runtime = this.#ctx!.get<ComputerDaemonModule>("ComputerDaemon");
    if (runtime.running() > 0) {
      if (state.kind === "waiting") return;
      this.#setState({ kind: "waiting", version: state.version });
      const off = this.#ctx!.bus.on("runtime.activity", (running) => {
        if (running !== 0) return;
        off();
        void this.install();
      });
      this.#unsubscribe.push(off);
      return;
    }
    this.#setState({ kind: "installing", version: state.version });
    this.#ctx!.log.info("update.installing", { version: state.version });
    try {
      if (this.#options.install?.kind === "windows-setup") {
        await this.#runSetup();
        await this.#options.quit();
      } else {
        await this.#swap();
        await this.#options.restart();
      }
    } catch (error) {
      this.#fail("update.install_failed", error);
    }
  }

  async #check(): Promise<void> {
    const ctx = this.#ctx!;
    const install = this.#options.install!;
    const configured = ctx.config.get().updateFeedUrl;
    const feed = configured ?? DEFAULT_FEED_URL;
    this.#setState({ kind: "checking" });
    try {
      if (new URL(feed).protocol !== "https:")
        throw new UpdateError("The update feed must use https");
      const route = await this.#route(configured === undefined);
      const manifest = await this.#manifest(feed, route);
      if (!manifest) {
        this.#setState({ kind: "idle" });
        return;
      }
      const pkg = packageFor(
        manifest,
        this.#options.platform,
        this.#options.arch,
      );
      if (
        compareVersions(manifest.version, this.#options.version) <= 0 ||
        !pkg
      ) {
        this.#setState({ kind: "idle" });
        return;
      }
      const version = manifest.version;
      if (install.kind === "download") {
        ctx.log.info("update.available", { version });
        this.#announce({
          kind: "available",
          version,
          url: releasePageUrl(feed, version),
        });
        return;
      }
      this.#setState({ kind: "downloading", version });
      const file = path.join(this.#options.downloadDirectory, pkg.file);
      await this.#downloadPackage(feed, version, pkg, file, route);
      this.#staged =
        install.kind === "app-bundle"
          ? { path: await this.#extract(file, version), pkg }
          : { path: file, pkg };
      if (install.kind === "app-bundle") await rm(file, { force: true });
      ctx.log.info("update.ready", { version });
      this.#announce({ kind: "ready", version });
    } catch (error) {
      this.#fail("update.check_failed", error);
    }
  }

  async #route(npm: boolean): Promise<Route> {
    let region: Region = "global";
    if (npm) {
      try {
        region = await resolveRegion(this.#options.home, {
          fetcher: this.#options.fetch ?? fetch,
        });
      } catch (error) {
        this.#ctx!.log.warn("update.region_failed", { error: String(error) });
      }
    }
    return { region, npm, regionFailed: false, fromNpm: false };
  }

  #failed(route: Route, source: URL, error: unknown): void {
    this.#ctx!.log.warn("update.source_failed", {
      source: source.host,
      error: error instanceof Error ? error.message : String(error),
    });
    if (
      !(error instanceof UpdateNotFound) &&
      sourceRegion(source) === route.region
    )
      route.regionFailed = true;
  }

  // The other region served what the home's region could not: downloads
  // from this home prefer it from now on.
  async #served(route: Route, source: URL): Promise<void> {
    const served = sourceRegion(source);
    if (!route.regionFailed || served === route.region) return;
    route.regionFailed = false;
    this.#ctx!.log.info("update.region_fallback", { region: served });
    await recordRegionFallback(this.#options.home, served);
  }

  // The verified manifest, or undefined when there is none to offer. In
  // global the release feed comes first, exactly as without npm, and the npm
  // packages are asked only when it cannot be reached; in cn the npm
  // packages come first, the China mirror's before npm's. Every source's
  // manifest must carry the built-in key's signature.
  async #manifest(
    feed: string,
    route: Route,
  ): Promise<UpdateManifest | undefined> {
    const release = new URL(feed);
    if (!route.npm) return this.#releaseManifest(feed);
    const registries = orderByRegion(route.region, NPM_REGISTRIES);
    if (route.region === "global") {
      try {
        return await this.#releaseManifest(feed);
      } catch (error) {
        // A manifest the key refuses is no network failure.
        if (error instanceof ManifestError) throw error;
        this.#failed(route, release, error);
        for (const registry of registries) {
          try {
            const manifest = await this.#npmManifest(registry);
            if (!manifest) continue;
            await this.#served(route, new URL(registry));
            return manifest;
          } catch (npmError) {
            this.#failed(route, new URL(registry), npmError);
          }
        }
        throw error;
      }
    }
    // npm can lag the release (a publish that failed or was skipped, a
    // stalled mirror sync), so a source with nothing newer than this app
    // passes to the next one, ending with the release itself. The first
    // source offering a newer version wins.
    let first: unknown;
    let current: UpdateManifest | undefined;
    for (const registry of registries) {
      try {
        const manifest = await this.#npmManifest(registry);
        if (!manifest) continue;
        if (!this.#offers(manifest)) {
          current ??= manifest;
          continue;
        }
        route.fromNpm = true;
        await this.#served(route, new URL(registry));
        return manifest;
      } catch (error) {
        first ??= error;
        this.#failed(route, new URL(registry), error);
      }
    }
    let manifest: UpdateManifest | undefined;
    try {
      manifest = await this.#releaseManifest(feed);
    } catch (error) {
      // An npm source that answered says this app is current: the release
      // being unreachable from China is no failure then.
      if (current) {
        this.#failed(route, release, error);
        return current;
      }
      throw first ?? error;
    }
    if (manifest && this.#offers(manifest)) {
      await this.#served(route, release);
      return manifest;
    }
    // Nothing to offer is quiet only when no source failed; a failure is
    // retried sooner than a quiet check.
    if (!manifest && !current && first !== undefined) throw first;
    return manifest ?? current;
  }

  // Whether `manifest` names a newer version with a package for this app.
  #offers(manifest: UpdateManifest): boolean {
    return (
      compareVersions(manifest.version, this.#options.version) > 0 &&
      packageFor(manifest, this.#options.platform, this.#options.arch) !==
        undefined
    );
  }

  // manifest.json and its .sig from the latest release of the feed.
  async #releaseManifest(feed: string): Promise<UpdateManifest | undefined> {
    const urls = feedUrls(feed);
    const [bytes, signature] = await Promise.all([
      this.#get(urls.manifest),
      this.#get(urls.signature),
    ]);
    // The newest release was published without a manifest: nothing to
    // offer until one is.
    if (!bytes || !signature) {
      this.#ctx!.log.info("update.no_manifest", { feed });
      return undefined;
    }
    return verifyManifest(
      bytes,
      signature.toString("utf8"),
      this.#options.publicKey ?? UPDATE_PUBLIC_KEY,
    );
  }

  // The manifest of the update package's `latest` version on `registry`;
  // undefined while the registry has none.
  async #npmManifest(registry: string): Promise<UpdateManifest | undefined> {
    const tags = await this.#get(distTagsUrl(registry, UPDATE_NPM_PACKAGE));
    if (!tags) return undefined;
    let latest: unknown;
    try {
      latest = (JSON.parse(tags.toString("utf8")) as { latest?: unknown })
        .latest;
    } catch {
      throw new UpdateError("The npm dist-tags are not JSON");
    }
    if (!isReleaseVersion(latest))
      throw new UpdateError("The npm dist-tags name no version");
    // A prerelease is never tagged latest on purpose, but npm tags the first
    // version of a package latest whatever it is.
    if (latest.includes("-")) return undefined;
    const url = npmTarballUrl(registry, UPDATE_NPM_PACKAGE, latest);
    const response = await (this.#options.fetch ?? fetch)(url);
    if (response.status === 404) return undefined;
    if (!response.ok || !response.body)
      throw new UpdateError(`${url.pathname} returned ${response.status}`);
    const files: Record<string, Buffer[]> = {};
    await extractNpmTarball(
      Readable.fromWeb(response.body as never),
      {
        [NPM_MANIFEST_MEMBER]: MANIFEST_MAX,
        [NPM_SIGNATURE_MEMBER]: SIGNATURE_MAX,
      },
      (member, chunk) => {
        (files[member] ??= []).push(chunk);
      },
    );
    const manifest = verifyManifest(
      Buffer.concat(files[NPM_MANIFEST_MEMBER] ?? []),
      Buffer.concat(files[NPM_SIGNATURE_MEMBER] ?? []).toString("utf8"),
      this.#options.publicKey ?? UPDATE_PUBLIC_KEY,
    );
    // An older signed manifest under a newer tag is refused here; one under
    // its own older tag is only never newer than this app.
    if (manifest.version !== latest)
      throw new ManifestError("Update manifest does not match its npm version");
    return manifest;
  }

  // The package from the release, or joined from its npm parts. In global
  // the release comes first and the parts only when it fails; in cn the
  // parts come first, and the release when any part fails on every registry,
  // unless the manifest came from the release, whose version npm lacks.
  async #downloadPackage(
    feed: string,
    version: string,
    pkg: UpdatePackage,
    file: string,
    route: Route,
  ): Promise<void> {
    const url = packageUrl(feed, version, pkg.file);
    const release = () => this.#download(url, file, pkg);
    if (!route.npm || !pkg.parts) return release();
    if (route.region === "cn" && !route.fromNpm) {
      await release();
      return;
    }
    const parts = () =>
      this.#downloadParts(
        version,
        `${this.#options.platform}-${this.#options.arch}`,
        pkg,
        file,
        route,
      );
    if (route.region === "global") {
      try {
        await release();
      } catch (error) {
        this.#failed(route, url, error);
        try {
          await parts();
        } catch {
          throw error;
        }
      }
      return;
    }
    try {
      await parts();
      return;
    } catch (error) {
      try {
        await release();
      } catch {
        throw error;
      }
    }
    await this.#served(route, url);
  }

  // Each part from the first registry that serves it, checked against the
  // manifest, then joined into `file` and checked as a whole.
  async #downloadParts(
    version: string,
    target: string,
    pkg: UpdatePackage,
    file: string,
    route: Route,
  ): Promise<void> {
    const parts = pkg.parts!;
    if (parts.reduce((total, part) => total + part.size, 0) !== pkg.size)
      throw new UpdateError("Update parts do not add up to the package");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const registries = orderByRegion(route.region, NPM_REGISTRIES);
    const pieces: string[] = [];
    try {
      for (const [index, part] of parts.entries()) {
        const piece = `${file}.part${index + 1}`;
        pieces.push(piece);
        let first: unknown;
        let served = false;
        for (const registry of registries) {
          const url = npmTarballUrl(
            registry,
            partNpmPackage(target, index),
            version,
          );
          try {
            await this.#downloadPart(url, piece, part);
            await this.#served(route, url);
            served = true;
            break;
          } catch (error) {
            first ??= error;
            this.#failed(route, url, error);
          }
        }
        if (!served) throw first;
      }
      // Each piece is removed once it is joined, so the disk holds about one
      // package's worth at a time.
      async function* joined(): AsyncGenerator<Buffer> {
        for (const piece of pieces) {
          for await (const chunk of createReadStream(piece))
            yield chunk as Buffer;
          await rm(piece, { force: true });
        }
      }
      await this.#verify(
        Readable.from(joined()),
        pkg,
        createWriteStream(file, { mode: 0o600 }),
      );
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    } finally {
      for (const piece of pieces) await rm(piece, { force: true });
    }
  }

  async #downloadPart(
    url: URL,
    piece: string,
    part: { readonly sha256: string; readonly size: number },
  ): Promise<void> {
    const response = await (this.#options.fetch ?? fetch)(url);
    if (response.status === 404) {
      await response.body?.cancel();
      throw new UpdateNotFound(`${url.pathname} returned 404`);
    }
    if (!response.ok || !response.body)
      throw new UpdateError(`${url.pathname} returned ${response.status}`);
    const hash = createHash("sha256");
    let received = 0;
    const handle = await open(piece, "w", 0o600);
    try {
      await extractNpmTarball(
        Readable.fromWeb(response.body as never),
        { [NPM_PART_MEMBER]: part.size },
        async (_member, chunk) => {
          hash.update(chunk);
          received += chunk.length;
          await handle.write(chunk);
        },
      );
    } finally {
      await handle.close();
    }
    if (received !== part.size || hash.digest("hex") !== part.sha256)
      throw new UpdateError("Update part does not match its checksum");
  }

  // Follows redirects: GitHub sends release files from another host. The
  // signature and the checksums, not the host, decide what is trusted.
  // Undefined when the file does not exist.
  async #get(url: URL): Promise<Buffer | undefined> {
    const response = await (this.#options.fetch ?? fetch)(url);
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new UpdateError(`${url.pathname} returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  // Streams to disk while hashing; a mismatch deletes the file.
  async #download(url: URL, file: string, pkg: UpdatePackage): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const response = await (this.#options.fetch ?? fetch)(url);
    if (!response.ok || !response.body)
      throw new UpdateError(`${url.pathname} returned ${response.status}`);
    try {
      await this.#verify(
        Readable.fromWeb(response.body as never),
        pkg,
        createWriteStream(file, { mode: 0o600 }),
      );
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    }
  }

  async #verify(
    source: Readable,
    pkg: UpdatePackage,
    sink?: NodeJS.WritableStream,
  ): Promise<void> {
    const hash = createHash("sha256");
    let received = 0;
    async function* meter(chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        received += chunk.length;
        if (received > pkg.size)
          throw new UpdateError("Update package is larger than announced");
        hash.update(chunk);
        yield chunk;
      }
    }
    if (sink) await pipeline(source, meter, sink);
    else for await (const _chunk of meter(source));
    if (received !== pkg.size || hash.digest("hex") !== pkg.sha256)
      throw new UpdateError("Update package does not match its checksum");
  }

  // Checks the setup program again, since it waited on disk, then starts it
  // detached so it outlives this app, which it replaces.
  async #runSetup(): Promise<void> {
    const staged = this.#staged;
    if (!staged) throw new UpdateError("No update is ready");
    await this.#verify(createReadStream(staged.path), staged.pkg);
    const child = (this.#options.spawn ?? (spawnProcess as SpawnSetup))(
      staged.path,
      SETUP_ARGS,
      { detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    this.#staged = undefined;
  }

  // Unpacks next to the installed bundle so the swap is two renames on one
  // volume.
  async #extract(archive: string, version: string): Promise<string> {
    const appBundle = this.#appBundle();
    const parent = path.dirname(appBundle);
    const staged = path.join(parent, `${STAGED_PREFIX}${version}`);
    await rm(staged, { recursive: true, force: true });
    await mkdir(staged, { recursive: true });
    try {
      await (this.#options.extract ?? untar)(archive, staged);
      const app = path.join(staged, path.basename(appBundle));
      if (!(await stat(app)).isDirectory())
        throw new UpdateError("Update package has no app");
      return app;
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      throw error instanceof UpdateError
        ? error
        : new UpdateError(`Couldn't unpack the update: ${String(error)}`);
    }
  }

  // The running process keeps its open files, so the bundle can be renamed
  // under it. A failed second rename puts the old bundle back.
  async #swap(): Promise<void> {
    const bundle = this.#appBundle();
    const staged = this.#staged?.path;
    if (!staged) throw new UpdateError("No update is ready");
    const old = path.join(path.dirname(bundle), `${OLD_PREFIX}${Date.now()}`);
    await rename(bundle, old);
    try {
      await rename(staged, bundle);
    } catch (error) {
      await rename(old, bundle);
      throw error;
    }
    this.#staged = undefined;
    await rm(path.dirname(staged), { recursive: true, force: true });
  }

  #appBundle(): string {
    const install = this.#options.install;
    if (install?.kind !== "app-bundle")
      throw new UpdateError("This installation has no app bundle");
    return install.appBundle;
  }

  // Leftovers from an earlier update: downloads, the replaced bundle and
  // unused stages.
  async #cleanup(): Promise<void> {
    const leftovers: string[] = [];
    try {
      for (const name of await readdir(this.#options.downloadDirectory))
        leftovers.push(path.join(this.#options.downloadDirectory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.#ctx?.log.warn("update.cleanup_failed", { error: String(error) });
    }
    try {
      const install = this.#options.install;
      if (install?.kind === "app-bundle") {
        const parent = path.dirname(install.appBundle);
        for (const name of await readdir(parent)) {
          if (name.startsWith(OLD_PREFIX) || name.startsWith(STAGED_PREFIX))
            leftovers.push(path.join(parent, name));
        }
      }
      for (const leftover of leftovers)
        await rm(leftover, { recursive: true, force: true });
    } catch (error) {
      this.#ctx?.log.warn("update.cleanup_failed", { error: String(error) });
    }
  }

  // Sets the state and tells the person once per version.
  #announce(state: AnnouncedUpdate): void {
    this.#setState(state);
    if (this.#announced.has(state.version)) return;
    this.#announced.add(state.version);
    this.#options.announce?.(state);
  }

  #fail(event: string, error: unknown): void {
    const message =
      error instanceof UpdateError || error instanceof ManifestError
        ? error.message
        : String(error);
    this.#ctx!.log.warn(event, { error: message });
    this.#setState({ kind: "failed", error: message });
  }

  #setState(state: UpdateState): void {
    this.#state = state;
    this.#ctx?.bus.emit("update.changed", state.kind);
  }
}

// The bundle that contains this executable on macOS, e.g.
// /Applications/Linger.app for /Applications/Linger.app/Contents/MacOS/Linger.
export function appBundleOf(execPath: string): string | undefined {
  const bundle = path.resolve(execPath, "../../..");
  return bundle.endsWith(".app") ? bundle : undefined;
}

// How a packaged app at execPath takes updates. A Windows installation from
// the setup program has its uninstaller beside Linger.exe (installer.nsi);
// the portable folder has none.
export function updateInstallFor(
  platform: string,
  execPath: string,
  exists: (file: string) => boolean,
): UpdateInstall {
  if (platform === "darwin") {
    const appBundle = appBundleOf(execPath);
    if (appBundle) return { kind: "app-bundle", appBundle };
  }
  if (
    platform === "win32" &&
    exists(
      path.win32.join(path.win32.dirname(execPath), "Uninstall Linger.exe"),
    )
  )
    return { kind: "windows-setup" };
  return { kind: "download" };
}
