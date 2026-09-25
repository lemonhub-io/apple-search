import { useCallback, useEffect, useState } from "react";
import { isStandalone, type BeforeInstallPromptEvent } from "../lib/platform";

/// Captures `beforeinstallprompt` so we can offer install from our own UI;
/// hides once installed (or when already running standalone).
export function useInstallPrompt() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setEvt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!evt) return;
    await evt.prompt();
    if ((await evt.userChoice).outcome === "accepted") setEvt(null);
  }, [evt]);

  return { canInstall: !installed && evt !== null, install };
}
