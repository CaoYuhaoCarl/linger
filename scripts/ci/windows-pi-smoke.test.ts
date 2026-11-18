import { expect, it } from "vitest";
import { probePi } from "./windows-pi-smoke.mjs";

function fixture(commands: unknown[]) {
  return `
    const readline = require("node:readline");
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const { id, type } = JSON.parse(line);
      console.log(JSON.stringify({
        id, type: "response", command: type, success: true,
        data: type === "get_commands" ? { commands: ${JSON.stringify(commands)} } : {},
      }));
    });
  `;
}

it("passes only after the state reply and MCP extension registration", async () => {
  const script = fixture([{ name: "mcp", source: "extension" }]);
  await expect(
    probePi(process.execPath, ["-e", script], {}),
  ).resolves.toBeUndefined();
});

it("rejects state success when the packaged extension did not load", async () => {
  const script = fixture([{ name: "mcp", source: "prompt" }]);
  await expect(probePi(process.execPath, ["-e", script], {})).rejects.toThrow(
    "the managed MCP command was not registered",
  );
});

it("retains bounded startup diagnostics on real subprocess exit", async () => {
  await expect(
    probePi(
      process.execPath,
      ["-e", 'console.error("Cannot find module jiti"); process.exitCode = 1'],
      {},
    ),
  ).rejects.toThrow(
    /process closed before handshake \(exit 1\)\nCannot find module jiti/,
  );
});

it("kills a silent probe at its deadline", async () => {
  await expect(
    probePi(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {}, 200),
  ).rejects.toThrow("RPC deadline exceeded");
});
