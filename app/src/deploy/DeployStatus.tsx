import { useEffect, useState } from "react";
import type { DeployStatus as Status } from "#/routes/api/deploy-status";

const CLIENT_SHA: string = import.meta.env.VITE_GIT_SHA ?? "dev";

export function DeployStatus() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/deploy-status")
        .then((r) => r.json())
        .then(setStatus, () => {});
    };
    check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);

  return (
    <>
      {status && status.sha !== CLIENT_SHA && (
        <button
          onClick={() => location.reload()}
          className="sticky top-0 z-50 w-full bg-blue-600 px-4 py-2 text-white font-medium"
        >
          New version available: tap to reload
        </button>
      )}
      {status?.failed && (
        <details className="mx-auto max-w-2xl mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <summary className="font-medium">
            Deploy of {status.failed.sha.slice(0, 7)} failed: still running {status.sha.slice(0, 7)}
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">
            {status.failed.log}
          </pre>
        </details>
      )}
    </>
  );
}
