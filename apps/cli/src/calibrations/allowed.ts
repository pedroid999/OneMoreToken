import { loadSubscriptions, loadUserSubscriptions } from "@omt/core";
import type { createCalibrationStore } from "./store";

/**
 * Which window kinds a subscription may calibrate: the kinds its plan declares (D1). Resolved on
 * every call, so a subscriptions edit is picked up without a restart.
 */
export function allowedWindowsFor(
  configPath: string,
): Parameters<typeof createCalibrationStore>[1] {
  return () => {
    const plans = loadSubscriptions();
    const config = loadUserSubscriptions(configPath, plans);
    if (!config.ok) return null;
    const windows = new Map(
      plans.plans.map((plan) => [plan.id, plan.windows.map((window) => window.kind)]),
    );
    return new Map(
      config.file.subscriptions.map((subscription) => [
        subscription.id,
        new Set(windows.get(subscription.planId) ?? []),
      ]),
    );
  };
}
