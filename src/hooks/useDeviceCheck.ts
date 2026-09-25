import { useEffect, useState } from "react";
import { runDeviceChecks, type DeviceReport } from "../lib/device";

/// Runs the device probe once per mount. Everything except
/// storage.estimate() is synchronous and cheap, so it starts when
/// onboarding opens — results are ready by the time the user reaches the
/// check page. `null` means still measuring.
export function useDeviceCheck(): DeviceReport | null {
  const [report, setReport] = useState<DeviceReport | null>(null);

  useEffect(() => {
    let live = true;
    void runDeviceChecks().then((r) => {
      if (live) setReport(r);
    });
    return () => {
      live = false;
    };
  }, []);

  return report;
}
