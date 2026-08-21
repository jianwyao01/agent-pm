import type {
  DiscoveryProjectInput,
  Gap,
  RunningProject,
  StartResult
} from "@behavior-map/contracts";

export function usableProject(input: DiscoveryProjectInput | null | undefined): RunningProject | undefined {
  if (!input) {
    return undefined;
  }
  if (isStartResult(input)) {
    if (input.status !== "success") {
      return undefined;
    }
    return input.project;
  }
  if (input.usable_for_explore === true && input.base_url) {
    return input;
  }
  return undefined;
}

export function refusedGap(): Gap {
  return {
    reason: "start_not_success",
    message: "explore/execute only use RunningProject when start status === success"
  };
}

function isStartResult(value: DiscoveryProjectInput): value is StartResult {
  return "status" in value && ("components" in value || "gaps" in value);
}
