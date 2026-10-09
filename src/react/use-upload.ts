import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { RouteInput, RouteName } from "../core/types";
import { UploadQueue, type QueueOptions } from "./queue";
import type { BatchResult, QueueSnapshot, Transport, UploadSource } from "./types";

export type UseUploadOptions<U, R extends RouteName<U>> = {
  transport: Transport<U>;
  route: R;
  input?: RouteInput<U, R>;
} & Omit<QueueOptions, "transport" | "route" | "input">;

export type UseUploadResult<U, R extends RouteName<U>> = QueueSnapshot & {
  upload: (sources: UploadSource | UploadSource[], opts?: { input?: RouteInput<U, R> }) => Promise<BatchResult[]>;
  cancel: (id?: string) => void;
  /** Retry an item that failed with a retryable error or was cancelled. Resolves when it settles again. */
  retry: (id: string) => Promise<void>;
  reset: () => void;
};

export function useUpload<U, R extends RouteName<U>>(options: UseUploadOptions<U, R>): UseUploadResult<U, R> {
  const ref = useRef<UploadQueue | null>(null);
  if (ref.current === null) ref.current = new UploadQueue(options as QueueOptions);
  const queue = ref.current;

  useEffect(() => { queue.setOptions(options as QueueOptions); });
  useEffect(() => () => queue.cancel(), [queue]);

  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const upload = useCallback((s: UploadSource | UploadSource[], o?: { input?: RouteInput<U, R> }) => queue.upload(s, o ?? {}), [queue]);
  const cancel = useCallback((id?: string) => queue.cancel(id), [queue]);
  const retry = useCallback((id: string) => queue.retry(id), [queue]);
  const reset = useCallback(() => queue.reset(), [queue]);
  return { ...snapshot, upload, cancel, retry, reset };
}
