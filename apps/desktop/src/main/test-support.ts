import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { ConfigStore, type DesktopConfig } from "./config.js";
import type { Logger } from "./log.js";
import { EventBus, ModuleHost, type Module } from "./modules.js";

export const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const tempDirectory = (): string =>
  mkdtempSync(path.join(os.tmpdir(), "desktop-test-"));

export const testHost = (
  modules: readonly Module[],
  defaults: Partial<DesktopConfig> = {},
  bus = new EventBus(),
): ModuleHost =>
  new ModuleHost(modules, {
    config: new ConfigStore(
      path.join(tempDirectory(), "config.json"),
      defaults,
    ),
    log: silentLog,
    bus,
  });

export const stubModule = (name: string, dependsOn: string[] = []): Module => ({
  name,
  dependsOn,
  start: async () => {},
  stop: async () => {},
});

// One tar member as `npm pack` writes it: a ustar header, the body and the
// padding to the next 512-byte block. `type` "0" is a regular file.
export const tarEntry = (name: string, body: Buffer, type = "0"): Buffer => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
};

/** A gzipped tarball of `members` (name, body[, type]) and its end blocks. */
export const npmTarball = (
  members: readonly (readonly [string, Buffer, string?])[],
): Buffer =>
  gzipSync(
    Buffer.concat([
      ...members.map(([name, body, type]) => tarEntry(name, body, type)),
      Buffer.alloc(1024),
    ]),
  );
