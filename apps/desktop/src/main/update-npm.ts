import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import {
  npmMirrorRegistry,
  npmRegistry,
} from "@linger/local-installation/npm-registry";

// The update feed as npm packages, which the China mirror (npmmirror)
// serves where GitHub is slow or unreachable. Each release version V
// publishes UPDATE_NPM_PACKAGE@V with the signed manifest.json and
// manifest.json.sig, and every package that the manifest splits into `parts`
// as one npm package per part, `partNpmPackage(target, n)`@V, holding the
// single file `part`. scripts/ci/desktop-release.sh (npm-pack, npm-publish)
// writes them; nothing here is trusted before the manifest signature and the
// sha256 of each part and of the whole package match.
export const UPDATE_NPM_PACKAGE = "@simplexai/linger-desktop-update";
export const NPM_MANIFEST_MEMBER = "package/manifest.json";
export const NPM_SIGNATURE_MEMBER = "package/manifest.json.sig";
export const NPM_PART_MEMBER = "package/part";
// npm pack always adds it; it is read past, never used.
const PACKAGE_JSON_MEMBER = "package/package.json";
const PACKAGE_JSON_MAX = 64 * 1024;

export const NPM_REGISTRIES = [npmMirrorRegistry, npmRegistry] as const;

/** The npm package of part `index` (from 0) of a target's update package. */
export function partNpmPackage(target: string, index: number): string {
  return `@simplexai/linger-desktop-${target}-part${index + 1}`;
}

export function distTagsUrl(registry: string, name: string): URL {
  return new URL(`-/package/${name}/dist-tags`, registry);
}

// The mirror's registry redirects tarballs to its CDN; asking the CDN saves
// the round trip.
export function npmTarballUrl(
  registry: string,
  name: string,
  version: string,
): URL {
  const basename = name.slice(name.lastIndexOf("/") + 1);
  return registry === npmMirrorRegistry
    ? new URL(
        `https://cdn.npmmirror.com/packages/${name}/${version}/${basename}-${version}.tgz`,
      )
    : new URL(`${name}/-/${basename}-${version}.tgz`, registry);
}

export class NpmTarError extends Error {}

const BLOCK = 512;

// Pulls exact byte counts out of a stream of chunks.
class ByteReader {
  readonly #chunks: AsyncIterator<Buffer>;
  #pending: Buffer = Buffer.alloc(0);

  constructor(chunks: AsyncIterable<Buffer>) {
    this.#chunks = chunks[Symbol.asyncIterator]();
  }

  async #fill(): Promise<boolean> {
    const next = await this.#chunks.next();
    if (next.done) return false;
    this.#pending =
      this.#pending.length === 0
        ? next.value
        : Buffer.concat([this.#pending, next.value]);
    return true;
  }

  async exactly(size: number): Promise<Buffer> {
    while (this.#pending.length < size)
      if (!(await this.#fill()))
        throw new NpmTarError("Update package ends early");
    const bytes = this.#pending.subarray(0, size);
    this.#pending = this.#pending.subarray(size);
    return bytes;
  }

  // Yields `size` bytes as they arrive, without holding them all.
  async *stream(size: number): AsyncGenerator<Buffer> {
    let left = size;
    while (left > 0) {
      if (this.#pending.length === 0 && !(await this.#fill()))
        throw new NpmTarError("Update package ends early");
      const take = Math.min(left, this.#pending.length);
      yield this.#pending.subarray(0, take);
      this.#pending = this.#pending.subarray(take);
      left -= take;
    }
  }
}

const text = (header: Buffer, start: number, length: number): string => {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? length : end).toString("utf8");
};

const octal = (header: Buffer, start: number, length: number): number => {
  const value = text(header, start, length).trim();
  if (!/^[0-7]+$/.test(value))
    throw new NpmTarError("Update package has a malformed entry");
  return parseInt(value, 8);
};

// The checksum counts its own field as eight spaces.
const checksumMatches = (header: Buffer): boolean => {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++)
    sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return sum === octal(header, 148, 8);
};

/**
 * Reads a gzipped npm tarball and hands each wanted member's bytes to
 * `write`. `wanted` maps a member name (such as `package/part`) to its largest
 * accepted size. Only regular files are accepted: each wanted member exactly
 * once, and npm's own package.json, which is skipped. Anything else (another
 * name, a directory, a link, a pax header, a member over its size) rejects the
 * whole tarball. Reading stops at the end-of-archive block.
 */
export async function extractNpmTarball(
  gzipped: AsyncIterable<Uint8Array>,
  wanted: Readonly<Record<string, number>>,
  write: (member: string, chunk: Buffer) => void | Promise<void>,
): Promise<void> {
  const seen = new Set<string>();
  const source = Readable.from(gzipped);
  const gunzip = createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  // Leaving at the end-of-archive block tears both streams down, so bytes
  // after it are neither inflated nor downloaded.
  try {
    const reader = new ByteReader(gunzip);
    for (;;) {
      const header = await reader.exactly(BLOCK);
      if (header.every((byte) => byte === 0)) break;
      if (!checksumMatches(header))
        throw new NpmTarError("Update package has a malformed entry");
      const prefix = text(header, 345, 155);
      const name = prefix
        ? `${prefix}/${text(header, 0, 100)}`
        : text(header, 0, 100);
      const type = String.fromCharCode(header[156]!);
      const size = octal(header, 124, 12);
      const max =
        name === PACKAGE_JSON_MEMBER ? PACKAGE_JSON_MAX : wanted[name];
      if ((type !== "0" && type !== "\0") || max === undefined)
        throw new NpmTarError("Update package has an unexpected entry");
      if (size > max)
        throw new NpmTarError("Update package entry is larger than expected");
      if (seen.has(name))
        throw new NpmTarError("Update package repeats an entry");
      seen.add(name);
      for await (const chunk of reader.stream(size))
        if (name !== PACKAGE_JSON_MEMBER) await write(name, chunk);
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      if (padding) await reader.exactly(padding);
    }
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  for (const name of Object.keys(wanted))
    if (!seen.has(name))
      throw new NpmTarError("Update package is missing an entry");
}
