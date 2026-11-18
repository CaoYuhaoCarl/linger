import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export async function verifyRunEvidence(file, expected, log, runID, signal) {
  try {
    const fileInfo = await lstat(file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink())
      throw new Error("Acceptance file must be a regular file");
    const marker = Buffer.from(expected);
    if (
      fileInfo.size !== marker.length ||
      !(await readFile(file, { signal })).equals(marker)
    )
      return false;
    let successfulWrite = false;
    let succeeded = false;
    const stream = createReadStream(log, { encoding: "utf8", signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if ((event?.runId ?? event?.run_id) !== runID) continue;
        if (
          event.event === "agent.tool_call" &&
          event.tool_name === "write" &&
          event.is_error === false
        )
          successfulWrite = true;
        if (
          event.event === "local_run.terminal_persisted" &&
          event.resultCode === "succeeded"
        )
          succeeded = true;
        if (successfulWrite && succeeded) return true;
      }
    } finally {
      stream.destroy();
    }
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function main() {
  const file = process.env.LINGER_ACCEPTANCE_FILE?.trim();
  const expected = process.env.LINGER_ACCEPTANCE_EXPECTED?.trim();
  const log = process.env.LINGER_ACCEPTANCE_AGENT_LOG?.trim();
  const runID = process.env.LINGER_ACCEPTANCE_RUN_ID?.trim();
  if (!file || !log || !isAbsolute(file) || !isAbsolute(log))
    throw new Error("File and log paths must be absolute");
  if (!runID || !/^LINGER_ACCEPTANCE_[A-F0-9]{16}$/.test(expected ?? ""))
    throw new Error("A Room journey marker and run ID are required");
  if (
    !(await verifyRunEvidence(
      file,
      expected,
      log,
      runID,
      AbortSignal.timeout(15_000),
    ))
  )
    throw new Error(
      "Exact file bytes and successful write/terminal evidence are required",
    );
  console.log(
    JSON.stringify({
      result: "verified",
      run_id: runID,
      file_content: "exact",
      successful_write: true,
      terminal_succeeded: true,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`Evidence check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
