#!/usr/bin/env node
// Packs a release's China update feed as npm packages (desktop-release.sh
// npm-pack): @simplexai/linger-desktop-update with the signed manifest.json
// and manifest.json.sig, and each package the manifest splits into `parts` as
// @simplexai/linger-desktop-<target>-part<N>, one file `part` each. The
// parts are cut at the sizes the signed manifest pins, and each must match
// its sha256 there, so the packages hold exactly what installed apps accept
// (apps/desktop/src/main/update-npm.ts reads them).
//
//   node desktop-npm-pack.mjs <release dir> <version> <out dir>
//
// Writes the .tgz files into <out dir> and packages.txt, one
// "<name> <tarball>" line per package in publishing order: the parts first,
// so the manifest naming them is published last.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const UPDATE_PACKAGE = "@simplexai/linger-desktop-update";
const REPOSITORY = "github:simplexai-labs/linger";
const LICENSE =
  "SEE LICENSE IN https://github.com/simplexai-labs/linger/blob/main/LICENSE";

const fail = (message) => {
  console.error(`desktop-npm-pack: ${message}`);
  process.exit(1);
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const [dir, version, out] = process.argv.slice(2);
if (!dir || !version || !out)
  fail("usage: desktop-npm-pack.mjs <release dir> <version> <out dir>");
if (path.resolve(out) === path.resolve(dir))
  fail("the out folder must not be the release folder");
if (existsSync(out) && readdirSync(out).length > 0) fail(`${out} is not empty`);

let manifest;
try {
  manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
} catch {
  fail(`${dir} has no readable manifest.json`);
}
if (!existsSync(path.join(dir, "manifest.json.sig")))
  fail(`${dir} has no manifest.json.sig`);
if (manifest.schema !== 2 || manifest.version !== version)
  fail(`manifest.json is not the schema 2 manifest of ${version}`);

mkdirSync(out, { recursive: true });
const staging = path.join(out, ".staging");
const published = [];

// One package from `files` (name -> bytes), packed with npm into `out`.
const pack = (name, description, files) => {
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const packageJson = {
    name,
    version,
    description,
    license: LICENSE,
    repository: REPOSITORY,
    files: Object.keys(files),
  };
  writeFileSync(
    path.join(staging, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  for (const [file, bytes] of Object.entries(files))
    writeFileSync(path.join(staging, file), bytes);
  const [result] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        path.resolve(out),
      ],
      { cwd: staging, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  rmSync(staging, { recursive: true, force: true });
  published.push(`${name} ${result.filename}`);
  console.log(`desktop-npm-pack: packed ${name}@${version}`);
};

for (const [target, pkg] of Object.entries(manifest.packages).sort()) {
  if (!/^[a-z0-9]+-[a-z0-9]+$/.test(target))
    fail(`${target} is not a platform-arch target`);
  if (!Array.isArray(pkg.parts) || pkg.parts.length === 0)
    fail(`manifest.json lists no parts for ${target}`);
  const file = path.join(dir, pkg.file);
  if (!existsSync(file)) fail(`${dir} has no ${pkg.file}`);
  if (statSync(file).size !== pkg.size)
    fail(`${pkg.file} does not match manifest.json`);
  const whole = createHash("sha256");
  const fd = openSync(file, "r");
  let offset = 0;
  try {
    for (const [index, part] of pkg.parts.entries()) {
      const bytes = Buffer.alloc(part.size);
      if (readSync(fd, bytes, 0, part.size, offset) !== part.size)
        fail(`${pkg.file} is shorter than its parts`);
      offset += part.size;
      if (sha256(bytes) !== part.sha256)
        fail(`part ${index + 1} of ${pkg.file} does not match manifest.json`);
      whole.update(bytes);
      pack(
        `@simplexai/linger-desktop-${target}-part${index + 1}`,
        `Part ${index + 1} of ${pkg.parts.length} of ${pkg.file}, checked by the signed manifest in ${UPDATE_PACKAGE}@${version}.`,
        { part: bytes },
      );
    }
  } finally {
    closeSync(fd);
  }
  if (offset !== pkg.size || whole.digest("hex") !== pkg.sha256)
    fail(`${pkg.file} does not match manifest.json`);
}

pack(UPDATE_PACKAGE, `Signed update manifest of Linger desktop ${version}.`, {
  "manifest.json": readFileSync(path.join(dir, "manifest.json")),
  "manifest.json.sig": readFileSync(path.join(dir, "manifest.json.sig")),
});
writeFileSync(path.join(out, "packages.txt"), `${published.join("\n")}\n`);
