import { TeamHubRuntimeStateError } from "../executor/teamhub-runtime-state-client.js";
import { logAgentEvent } from "../observability/agent-log.js";

interface RecordQueue<T> {
  next: T | undefined;
  /** Ends a retry delay early: a newer record is written at once. */
  wake?: () => void;
}

// A record TeamHub failed to store is written again after these delays.
const FIRST_RECORD_RETRY_MS = 1_000;
const MAX_RECORD_RETRY_MS = 60_000;

/**
 * Writes each Computer's newest report to TeamHub, one at a time, so TeamHub
 * never stores an older report last. A report TeamHub could not store is
 * kept and written again, because the Computer reports again only when
 * something changes; a newer report that arrives meanwhile replaces it. A
 * report TeamHub refused as invalid is dropped.
 */
export class LatestRecordRelay<T> {
  readonly #queues = new Map<string, RecordQueue<T>>();

  readonly #event: string;

  readonly #write: (computerId: string, record: T) => Promise<void> | undefined;

  /**
   * event names the log events; write stores one report and returns nothing
   * when no TeamHub is configured.
   */
  constructor(
    event: string,
    write: (computerId: string, record: T) => Promise<void> | undefined,
  ) {
    this.#event = event;
    this.#write = write;
  }

  push(computerId: string, record: T): void {
    const queue = this.#queues.get(computerId);
    if (queue) {
      queue.next = record;
      queue.wake?.();
      return;
    }
    const started: RecordQueue<T> = { next: record };
    this.#queues.set(computerId, started);
    void this.#drain(computerId, started);
  }

  async #drain(computerId: string, queue: RecordQueue<T>): Promise<void> {
    let retryMs = FIRST_RECORD_RETRY_MS;
    for (let record = queue.next; record !== undefined; record = queue.next) {
      queue.next = undefined;
      try {
        await this.#write(computerId, record);
        retryMs = FIRST_RECORD_RETRY_MS;
      } catch (error) {
        const retryable = !(
          error instanceof TeamHubRuntimeStateError && !error.retryable
        );
        logAgentEvent("warn", `${this.#event}.record_failed`, {
          runnerId: computerId,
          retryable,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!retryable || queue.next !== undefined) continue;
        queue.next = record;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryMs);
          timer.unref();
          queue.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        queue.wake = undefined;
        retryMs = Math.min(2 * retryMs, MAX_RECORD_RETRY_MS);
      }
    }
    this.#queues.delete(computerId);
  }
}
