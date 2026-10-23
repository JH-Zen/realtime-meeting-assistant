export {};
declare global {
  interface Window {
    rccDesktop?: {
      setCaptureActive(active: boolean): void;
      onPrepareQuit(callback: () => void | Promise<void>): () => void;
    };
  }
}
