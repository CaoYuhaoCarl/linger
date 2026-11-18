import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { npmTarball, tarEntry } from "./test-support.js";
import {
  NPM_PART_MEMBER,
  NpmTarError,
  distTagsUrl,
  extractNpmTarball,
  npmTarballUrl,
  partNpmPackage,
} from "./update-npm.js";

const PACKAGE_JSON = Buffer.from('{"name":"x","version":"1.0.0"}');

async function* chunked(bytes: Buffer, size = 7): AsyncGenerator<Buffer> {
  for (let i = 0; i < bytes.length; i += size)
    yield bytes.subarray(i, i + size);
}

const extract = async (
  tarball: Buffer,
  wanted: Record<string, number> = { [NPM_PART_MEMBER]: 4096 },
  chunk = 7,
) => {
  const files: Record<string, Buffer[]> = {};
  await extractNpmTarball(chunked(tarball, chunk), wanted, (member, chunk) => {
    (files[member] ??= []).push(Buffer.from(chunk));
  });
  return Object.fromEntries(
    Object.entries(files).map(([name, chunks]) => [
      name,
      Buffer.concat(chunks).toString(),
    ]),
  );
};

describe("npm update packages", () => {
  it("names the packages and where each registry serves them", () => {
    expect(partNpmPackage("darwin-arm64", 0)).toBe(
      "@simplexai/linger-desktop-darwin-arm64-part1",
    );
    const name = "@simplexai/linger-desktop-update";
    expect(
      distTagsUrl("https://registry.npmmirror.com/", name).toString(),
    ).toBe(
      "https://registry.npmmirror.com/-/package/@simplexai/linger-desktop-update/dist-tags",
    );
    expect(
      npmTarballUrl(
        "https://registry.npmmirror.com/",
        name,
        "1.2.3",
      ).toString(),
    ).toBe(
      "https://cdn.npmmirror.com/packages/@simplexai/linger-desktop-update/1.2.3/linger-desktop-update-1.2.3.tgz",
    );
    expect(
      npmTarballUrl("https://registry.npmjs.org/", name, "1.2.3").toString(),
    ).toBe(
      "https://registry.npmjs.org/@simplexai/linger-desktop-update/-/linger-desktop-update-1.2.3.tgz",
    );
  });
});

describe("extractNpmTarball", () => {
  it("hands over the wanted member and reads past package.json", async () => {
    const body = Buffer.alloc(1300, "p");
    const files = await extract(
      npmTarball([
        ["package/package.json", PACKAGE_JSON],
        [NPM_PART_MEMBER, body],
      ]),
    );
    expect(files).toEqual({ [NPM_PART_MEMBER]: body.toString() });
  });

  // Bytes after the end blocks, however many they inflate to, are not read.
  it("stops at the end of the archive", async () => {
    const tar = Buffer.concat([
      tarEntry(NPM_PART_MEMBER, Buffer.from("part")),
      Buffer.alloc(1024),
      tarEntry("package/evil", Buffer.from("never read")),
      Buffer.alloc(64 * 1024 * 1024, 1),
    ]);
    expect(await extract(gzipSync(tar), undefined, 64 * 1024)).toEqual({
      [NPM_PART_MEMBER]: "part",
    });
  });

  it.each([
    ["another file", [["package/other", Buffer.from("x")]]],
    ["a path outside package/", [["part", Buffer.from("x")]]],
    ["a traversal", [["package/../part", Buffer.from("x")]]],
    ["a directory", [[NPM_PART_MEMBER, Buffer.alloc(0), "5"]]],
    ["a symlink", [[NPM_PART_MEMBER, Buffer.alloc(0), "2"]]],
    ["a pax header", [[NPM_PART_MEMBER, Buffer.from("x"), "x"]]],
  ] as const)("rejects %s", async (_label, members) => {
    await expect(
      extract(npmTarball([...members, [NPM_PART_MEMBER, Buffer.from("p")]])),
    ).rejects.toThrow(NpmTarError);
  });

  it("rejects a member over its size before reading it", async () => {
    const written: Buffer[] = [];
    await expect(
      extractNpmTarball(
        chunked(npmTarball([[NPM_PART_MEMBER, Buffer.alloc(5000)]])),
        { [NPM_PART_MEMBER]: 4096 },
        (_member, chunk) => {
          written.push(chunk);
        },
      ),
    ).rejects.toThrow("larger than expected");
    expect(written).toEqual([]);
  });

  it("rejects an oversized package.json", async () => {
    await expect(
      extract(
        npmTarball([
          ["package/package.json", Buffer.alloc(70 * 1024)],
          [NPM_PART_MEMBER, Buffer.from("p")],
        ]),
      ),
    ).rejects.toThrow(NpmTarError);
  });

  it("rejects a repeated, missing or damaged member", async () => {
    await expect(
      extract(
        npmTarball([
          [NPM_PART_MEMBER, Buffer.from("a")],
          [NPM_PART_MEMBER, Buffer.from("b")],
        ]),
      ),
    ).rejects.toThrow("repeats");
    await expect(
      extract(npmTarball([["package/package.json", PACKAGE_JSON]])),
    ).rejects.toThrow("missing");
    const entry = tarEntry(NPM_PART_MEMBER, Buffer.from("p"));
    entry[0] = "q".charCodeAt(0);
    await expect(
      extract(gzipSync(Buffer.concat([entry, Buffer.alloc(1024)]))),
    ).rejects.toThrow("malformed");
    const cut = tarEntry(NPM_PART_MEMBER, Buffer.alloc(600)).subarray(0, 700);
    await expect(extract(gzipSync(cut))).rejects.toThrow("ends early");
  });

  it("rejects bytes that are not gzip", async () => {
    await expect(extract(Buffer.from("not gzip at all"))).rejects.toThrow();
  });
});
