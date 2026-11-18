import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  UPDATE_NPM_PACKAGE,
  extractNpmTarball,
  partNpmPackage,
} from "../../apps/desktop/src/main/update-npm.ts";

const script = join(process.cwd(), "scripts/ci/desktop-release.sh");
const temporary: string[] = [];

function run(args: string[], env: Record<string, string> = {}, file = script) {
  const result = spawnSync("bash", [file, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "desktop-release-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("desktop-release.sh version", () => {
  it("reads a release tag", () => {
    const result = run(["version", "desktop-v0.16.33"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "tag=desktop-v0.16.33\nversion=0.16.33\nprerelease=false\n",
    );
  });

  it("marks a hyphenated version as a prerelease", () => {
    const result = run(["version", "desktop-v0.16.33-rc.1"]);
    expect(result.stdout).toBe(
      "tag=desktop-v0.16.33-rc.1\nversion=0.16.33-rc.1\nprerelease=true\n",
    );
  });

  it("gives a bare version from a manual run its tag", () => {
    expect(run(["version", "1.2.3"]).stdout).toContain("tag=desktop-v1.2.3\n");
  });

  it.each([
    "v0.16.33",
    "cli-v0.16.33",
    "desktop-v0.16",
    "desktop-v0.16.33-",
    "",
  ])("rejects %j", (tag) => {
    const result = run(["version", tag]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});

describe("desktop-release.sh checksums", () => {
  const version = "0.16.33";
  const required = [
    `Linger-${version}-macos-arm64.dmg`,
    `Linger-${version}-linux-x64.tar.gz`,
    `Linger-${version}-windows-x64-setup.exe`,
  ];

  it("lists every file of the version", () => {
    const dir = folder();
    const files = [...required, `Linger-${version}-windows-x64-portable.zip`];
    for (const name of files) writeFileSync(join(dir, name), name);
    writeFileSync(join(dir, "Linger-0.16.32-macos-arm64.dmg"), "older");

    const result = run(["checksums", dir, version]);

    expect(result.status).toBe(0);
    const expected = [...files]
      .sort()
      .map(
        (name) =>
          `${createHash("sha256").update(name).digest("hex")}  ${name}\n`,
      )
      .join("");
    expect(readFileSync(join(dir, "SHA256SUMS.txt"), "utf8")).toBe(expected);
  });

  it("refuses a release without one of the installers", () => {
    const dir = folder();
    for (const name of required.slice(0, 2))
      writeFileSync(join(dir, name), name);

    const result = run(["checksums", dir, version]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Linger-${version}-windows-x64-setup.exe`);
  });

  // The DMG names its platform like the other packages.
  it("refuses a DMG without macos in its name", () => {
    const dir = folder();
    for (const name of [`Linger-${version}-arm64.dmg`, ...required.slice(1)])
      writeFileSync(join(dir, name), name);

    const result = run(["checksums", dir, version]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Linger-${version}-macos-arm64.dmg`);
  });
});

describe("desktop-release.sh manifest", () => {
  const version = "0.16.33";
  const packages = {
    "darwin-arm64": `Linger-${version}-macos-arm64.app.tar.gz`,
    "linux-x64": `Linger-${version}-linux-x64.tar.gz`,
    "win32-x64": `Linger-${version}-windows-x64-setup.exe`,
  };
  const release = () => {
    const dir = folder();
    for (const name of Object.values(packages))
      writeFileSync(join(dir, name), name);
    writeFileSync(join(dir, `Linger-${version}-macos-arm64.dmg`), "dmg");
    return dir;
  };
  // A copy of the script beside an update-manifest.ts holding a throwaway
  // key's public half, so the test never needs the release key.
  const checkout = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const root = folder();
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    mkdirSync(join(root, "apps/desktop/src/main"), { recursive: true });
    copyFileSync(script, join(root, "scripts/ci/desktop-release.sh"));
    const publicPem = publicKey.export({ type: "spki", format: "pem" });
    writeFileSync(
      join(root, "apps/desktop/src/main/update-manifest.ts"),
      `export const UPDATE_PUBLIC_KEY = \`${publicPem.toString().trim()}\`;\n`,
    );
    const key = join(folder(), "update.pem");
    writeFileSync(
      key,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    return {
      script: join(root, "scripts/ci/desktop-release.sh"),
      key,
      publicKey,
    };
  };

  it("signs a manifest of every platform's package", () => {
    const dir = release();
    const repo = checkout();

    const result = run(
      ["manifest", dir, version],
      { DESKTOP_UPDATE_KEY: repo.key },
      repo.script,
    );

    expect(result.status).toBe(0);
    const bytes = readFileSync(join(dir, "manifest.json"));
    const signature = readFileSync(join(dir, "manifest.json.sig"), "utf8");
    expect(
      verify(null, bytes, repo.publicKey, Buffer.from(signature, "base64")),
    ).toBe(true);
    expect(JSON.parse(bytes.toString())).toEqual({
      schema: 2,
      version,
      packages: Object.fromEntries(
        Object.entries(packages).map(([target, file]) => [
          target,
          {
            file,
            sha256: createHash("sha256").update(file).digest("hex"),
            size: file.length,
            parts: [
              {
                sha256: createHash("sha256").update(file).digest("hex"),
                size: file.length,
              },
            ],
          },
        ]),
      ),
    });

    run(["checksums", dir, version]);
    const sums = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8");
    expect(sums).toContain("  manifest.json\n");
    expect(sums).toContain("  manifest.json.sig\n");
  });

  it("pins the parts of each package npm-pack publishes", () => {
    const dir = release();
    const repo = checkout();

    const result = run(
      ["manifest", dir, version],
      { DESKTOP_UPDATE_KEY: repo.key, DESKTOP_NPM_PART_BYTES: "16" },
      repo.script,
    );

    expect(result.status).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    ) as { packages: Record<string, { parts: { size: number }[] }> };
    // Linger-0.16.33-windows-x64-setup.exe is 36 bytes.
    expect(
      manifest.packages["win32-x64"]!.parts.map((part) => part.size),
    ).toEqual([16, 16, 4]);
    expect(
      run(
        ["manifest", dir, version],
        { DESKTOP_UPDATE_KEY: repo.key, DESKTOP_NPM_PART_BYTES: "0" },
        repo.script,
      ).stderr,
    ).toContain("DESKTOP_NPM_PART_BYTES");
  });

  it("warns and writes nothing without the key", () => {
    const dir = release();

    const result = run(["manifest", dir, version]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning::DESKTOP_UPDATE_KEY_PEM");
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
  });

  it("refuses a key installed apps would not accept", () => {
    const dir = release();
    // The throwaway key against this checkout's UPDATE_PUBLIC_KEY.
    const other = checkout();

    const result = run(["manifest", dir, version], {
      DESKTOP_UPDATE_KEY: other.key,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("UPDATE_PUBLIC_KEY");
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
  });

  it("refuses a release without a platform's package", () => {
    const dir = release();
    rmSync(join(dir, packages["darwin-arm64"]));
    const repo = checkout();

    const result = run(
      ["manifest", dir, version],
      { DESKTOP_UPDATE_KEY: repo.key },
      repo.script,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(packages["darwin-arm64"]);
  });
});

describe("desktop-release.sh build", () => {
  it("needs a known target and a version", () => {
    expect(
      run(["build", "darwin-x64"], { DESKTOP_VERSION: "1.0.0" }).status,
    ).toBe(1);
    expect(run(["compile", "linux-x64"]).stderr).toContain("DESKTOP_VERSION");
  });

  it("stops before building when a pinned archive has no source", () => {
    const result = run(["build", "linux-x64"], {
      DESKTOP_VERSION: "1.0.0",
      RELEASE_OUT: folder(),
      LINGER_NATIVE_POSTGRES_DIR: folder(),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LINGER_NATIVE_DEPS_URL");
  });

  it("keeps the archive folder's address out of the log", () => {
    const result = run(["fetch-native", "linux-x64"], {
      LINGER_NATIVE_POSTGRES_DIR: folder(),
      LINGER_NATIVE_DEPS_URL: "http://deps.invalid/private/folder",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot download");
    expect(result.stdout + result.stderr).not.toContain("deps.invalid");
  });
});

describe("desktop-release.sh gitlab-upload", () => {
  it("needs GitLab CI", () => {
    const result = run(["gitlab-upload", ".", "1.0.0"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CI_API_V4_URL is not set");
  });

  it.each(["target", "gitlab-release"])(
    "has no %s command: releases publish only on GitHub",
    (command) => {
      expect(run([command]).status).toBe(2);
    },
  );
});

describe("desktop-release.sh github-release", () => {
  const version = "1.0.0-rc.1";
  const tag = `desktop-v${version}`;

  // A gh that records its arguments and has no release yet.
  function release(env: Record<string, string>) {
    const dir = folder();
    const bin = folder();
    const log = join(dir, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >>"${log}"\n[ "$2" != view ]\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(join(dir, "SHA256SUMS.txt"), "");
    const result = run(["github-release", dir, tag, version], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ...env,
    });
    let calls = "";
    try {
      calls = readFileSync(log, "utf8");
    } catch {
      // gh was not run
    }
    return { ...result, calls };
  }

  it("publishes to simplexai-labs/linger by default", () => {
    const result = release({
      GITHUB_REPOSITORY: "simplexai-labs/linger",
      GITHUB_SHA: "abc123",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toContain(`release create ${tag} `);
    expect(result.calls).toContain("--repo simplexai-labs/linger");
    expect(result.calls).toContain("--target abc123");
    expect(result.calls).toContain("--prerelease");
    expect(result.calls).not.toContain("--latest");
  });

  it("leaves another repository's commit out of a cross-repository release", () => {
    const result = release({
      GITHUB_REPOSITORY: "example/linger-copy",
      GITHUB_SHA: "abc123",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toContain("--repo simplexai-labs/linger");
    expect(result.calls).not.toContain("abc123");
  });

  it("marks a stable release as the latest", () => {
    const dir = folder();
    const bin = folder();
    const log = join(dir, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >>"${log}"\n[ "$2" != view ]\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(join(dir, "SHA256SUMS.txt"), "");

    const result = run(["github-release", dir, "desktop-v1.0.0", "1.0.0"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "simplexai-labs/linger",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("--latest");
  });

  it("needs LINGER_RELEASE_TOKEN to publish from another repository", () => {
    const result = release({ GITHUB_REPOSITORY: "example/linger-copy" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LINGER_RELEASE_TOKEN");
    expect(result.calls).toBe("");
  });

  it("refuses a RELEASE_REPO that is not owner/name", () => {
    const result = release({
      RELEASE_REPO: "https://github.com/simplexai-labs/linger",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("owner/name");
  });
});

describe("desktop-release.sh install-scripts", () => {
  const version = "0.16.33";

  it("exports verified install.sh and install.ps1 and covers them in SHA256SUMS.txt", () => {
    const dir = folder();
    for (const suffix of [
      "macos-arm64.dmg",
      "linux-x64.tar.gz",
      "windows-x64-setup.exe",
    ]) {
      writeFileSync(join(dir, `Linger-${version}-${suffix}`), suffix);
    }

    const exported = run(["install-scripts", dir, version]);
    expect(exported.status).toBe(0);
    expect(exported.stdout).toContain(
      `copied install.sh and install.ps1 for ${version}`,
    );
    expect(statSync(join(dir, "install.sh")).mode & 0o111).toBe(0o111);
    expect(existsSync(join(dir, "install.ps1"))).toBe(true);

    const sums = run(["checksums", dir, version]);
    expect(sums.status).toBe(0);
    const checksumText = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8");
    const shHash = createHash("sha256")
      .update(readFileSync(join(process.cwd(), "scripts/install/install.sh")))
      .digest("hex");
    const ps1Hash = createHash("sha256")
      .update(readFileSync(join(process.cwd(), "scripts/install/install.ps1")))
      .digest("hex");
    expect(checksumText).toContain(`${shHash}  install.sh\n`);
    expect(checksumText).toContain(`${ps1Hash}  install.ps1\n`);
  });

  it("refuses install-scripts when standalone pins drift from scripts/installs", () => {
    const checkout = folder();
    for (const rel of ["scripts/ci", "scripts/install", "scripts/installs"]) {
      mkdirSync(join(checkout, rel), { recursive: true });
    }
    for (const file of [
      "scripts/ci/desktop-release.sh",
      "scripts/sync-install-stack-pin.mjs",
      "scripts/installs/stack.sh",
      "scripts/installs/stack.ps1",
      "scripts/install/install.sh",
      "scripts/install/install.ps1",
    ]) {
      copyFileSync(join(process.cwd(), file), join(checkout, file));
    }
    const driftedSh = readFileSync(
      join(checkout, "scripts/install/install.sh"),
      "utf8",
    ).replace(
      /STACK_PIN_SHA256='[a-f0-9]+'/,
      `STACK_PIN_SHA256='${"0".repeat(64)}'`,
    );
    writeFileSync(join(checkout, "scripts/install/install.sh"), driftedSh);

    const dir = folder();
    const result = run(
      ["install-scripts", dir, version],
      {},
      join(checkout, "scripts/ci/desktop-release.sh"),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Stack release pin drift");
    expect(existsSync(join(dir, "install.sh"))).toBe(false);
  });
});

describe("desktop-release.sh npm-pack and npm-publish", () => {
  const version = "0.16.33";
  const packages = {
    "darwin-arm64": `Linger-${version}-macos-arm64.app.tar.gz`,
    "linux-x64": `Linger-${version}-linux-x64.tar.gz`,
    "win32-x64": `Linger-${version}-windows-x64-setup.exe`,
  };
  // A release of the three packages, 40 bytes each, signed with parts of
  // at most 16 bytes by a throwaway key.
  const signedRelease = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const root = folder();
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    mkdirSync(join(root, "apps/desktop/src/main"), { recursive: true });
    copyFileSync(script, join(root, "scripts/ci/desktop-release.sh"));
    writeFileSync(
      join(root, "apps/desktop/src/main/update-manifest.ts"),
      `export const UPDATE_PUBLIC_KEY = \`${publicKey.export({ type: "spki", format: "pem" }).toString().trim()}\`;\n`,
    );
    const key = join(folder(), "update.pem");
    writeFileSync(
      key,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    const dir = folder();
    for (const [target, name] of Object.entries(packages))
      writeFileSync(join(dir, name), `${target}:`.padEnd(40, target[0]));
    const signed = run(
      ["manifest", dir, version],
      { DESKTOP_UPDATE_KEY: key, DESKTOP_NPM_PART_BYTES: "16" },
      join(root, "scripts/ci/desktop-release.sh"),
    );
    expect(signed.status).toBe(0);
    return dir;
  };

  // The members of a packed tarball, read as installed apps read them.
  const extract = async (tarball: string, ...members: string[]) => {
    const chunks: Record<string, Buffer[]> = {};
    await extractNpmTarball(
      [readFileSync(tarball)],
      Object.fromEntries(members.map((member) => [member, 1024 * 1024])),
      (member, chunk) => {
        (chunks[member] ??= []).push(Buffer.from(chunk));
      },
    );
    return Object.fromEntries(
      Object.entries(chunks).map(([member, parts]) => [
        member,
        Buffer.concat(parts),
      ]),
    );
  };

  it("packs the manifest and every part the way installed apps read them", async () => {
    const dir = signedRelease();
    const out = join(folder(), "npm");

    const result = run(["npm-pack", dir, version, out]);

    expect(result.status, result.stderr).toBe(0);
    const lines = readFileSync(join(out, "packages.txt"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" ") as [string, string]);
    const targets = Object.keys(packages).sort();
    expect(lines.map(([name]) => name)).toEqual([
      ...targets.flatMap((target) =>
        [0, 1, 2].map((index) => partNpmPackage(target, index)),
      ),
      // Last, so no manifest names parts npm does not have yet.
      UPDATE_NPM_PACKAGE,
    ]);
    const tarballs = Object.fromEntries(lines);
    for (const [target, file] of Object.entries(packages)) {
      const joined = Buffer.concat(
        await Promise.all(
          [0, 1, 2].map((index) =>
            extract(
              join(out, tarballs[partNpmPackage(target, index)]!),
              "package/part",
            ).then((members) => members["package/part"]!),
          ),
        ),
      );
      expect(joined).toEqual(readFileSync(join(dir, file)));
    }
    expect(
      await extract(
        join(out, tarballs[UPDATE_NPM_PACKAGE]!),
        "package/manifest.json",
        "package/manifest.json.sig",
      ),
    ).toEqual({
      "package/manifest.json": readFileSync(join(dir, "manifest.json")),
      "package/manifest.json.sig": readFileSync(join(dir, "manifest.json.sig")),
    });
    expect(existsSync(join(out, ".staging"))).toBe(false);
  });

  it("refuses a package that changed after the manifest was signed", () => {
    const dir = signedRelease();
    writeFileSync(join(dir, packages["linux-x64"]), "x".repeat(40));

    const result = run(["npm-pack", dir, version, join(folder(), "npm")]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(packages["linux-x64"]);
  });

  it("needs the signed manifest", () => {
    const dir = folder();
    const result = run(["npm-pack", dir, version, join(folder(), "npm")]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("signed manifest");
  });

  // An npm and a curl that record their arguments, the npm config they
  // were given, and an npm that has no version yet.
  const publish = (args: string[], env: Record<string, string> = {}) => {
    const out = folder();
    const bin = folder();
    const log = join(out, "calls.log");
    writeFileSync(join(out, "a.tgz"), "");
    writeFileSync(join(out, "b.tgz"), "");
    writeFileSync(
      join(out, "packages.txt"),
      "@simplexai/linger-desktop-linux-x64-part1 a.tgz\n@simplexai/linger-desktop-update b.tgz\n",
    );
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh\necho "npm $*" >>"${log}"\nprev=\nfor a; do [ "$prev" = --userconfig ] && cat "$a" >>"${log}"; prev=$a; done\nexit 0\n`,
    );
    writeFileSync(join(bin, "curl"), `#!/bin/sh\necho "curl $*" >>"${log}"\n`);
    chmodSync(join(bin, "npm"), 0o755);
    chmodSync(join(bin, "curl"), 0o755);
    const result = run(["npm-publish", out, ...args], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ...env,
    });
    let calls = "";
    try {
      calls = readFileSync(log, "utf8");
    } catch {
      // nothing ran
    }
    return { ...result, calls };
  };

  it("only lists the packages without --publish", () => {
    const result = publish([version], { NPM_TOKEN: "token" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `would publish @simplexai/linger-desktop-update@${version} (latest)`,
    );
    expect(result.calls).toBe("");
  });

  it("needs NPM_TOKEN to publish", () => {
    const result = publish([version, "--publish"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NPM_TOKEN");
    expect(result.calls).toBe("");
  });

  it("publishes the parts, then the manifest, and asks npmmirror to sync", () => {
    const result = publish([version, "--publish"], {
      NPM_TOKEN: "secret-token",
    });

    expect(result.status, result.stderr).toBe(0);
    const publishes = result.calls
      .split("\n")
      .filter((line) => line.startsWith("npm publish"));
    expect(publishes).toHaveLength(2);
    expect(publishes[0]).toContain("/a.tgz --access public --tag latest");
    expect(publishes[1]).toContain("/b.tgz --access public --tag latest");
    expect(result.calls).toContain(
      "curl -fsS --retry 3 -X PUT https://registry-direct.npmmirror.com/-/package/@simplexai/linger-desktop-update/syncs",
    );
    // npm expands the token itself; it is never written to a file.
    expect(result.calls).toContain(
      "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
    );
    expect(result.calls + result.stdout).not.toContain("secret-token");
  });

  it("tags a prerelease next", () => {
    const result = publish(["1.0.0-rc.1", "--publish"], { NPM_TOKEN: "t" });

    expect(result.status).toBe(0);
    expect(result.calls).toContain("--tag next");
    expect(result.calls).not.toContain("--tag latest");
  });
});
