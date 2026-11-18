import type {
  ComputerProfile,
  RunnerComputerProfile as RunnerComputerProfileFrame,
} from "@linger/wire-contracts/runner-gateway/types";

import { logAgentEvent } from "../observability/agent-log.js";
import { LatestRecordRelay } from "./latest-record-relay.js";
import type {
  ConnectedRunner,
  RunnerGatewayContext,
} from "./runner-gateway-context.js";

interface ProfileRecord {
  readonly observedAt: string;
  readonly profile: ComputerProfile;
}

/**
 * Relays a Computer's runner.computer_profile to TeamHub. The Computer sends
 * one when its welcome names computer_profile and again whenever the profile
 * changes; TeamHub keeps only the latest.
 */
export class RunnerComputerProfiles {
  readonly #context: RunnerGatewayContext;

  readonly #profiles = new LatestRecordRelay<ProfileRecord>(
    "runner.computer_profile",
    (computerId, { observedAt, profile }) =>
      this.#context.computerRegistry?.recordComputerProfile(
        computerId,
        observedAt,
        profile,
      ),
  );

  constructor(context: RunnerGatewayContext) {
    this.#context = context;
  }

  receive(connection: ConnectedRunner, frame: RunnerComputerProfileFrame) {
    if (frame.revision <= connection.computerProfileRevision) {
      logAgentEvent("warn", "runner.computer_profile.stale", {
        runnerId: connection.runnerId,
        revision: frame.revision,
        currentRevision: connection.computerProfileRevision,
      });
      return;
    }
    connection.computerProfileRevision = frame.revision;
    this.#profiles.push(connection.runnerId, {
      observedAt: frame.sent_at,
      profile: frame.profile,
    });
  }
}
