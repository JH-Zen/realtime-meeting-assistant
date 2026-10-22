import Emittery from "emittery";
import type { BusEventName, BusEvents, ModuleError, ModuleId } from "@rcc/shared";

/**
 * The in-process bus (design doc §17), backed by emittery. One fault rule: a listener that throws
 * is contained, reported on `module.error`, and cannot stop the emit or any sibling listener —
 * emittery runs every listener even if some reject, so a broken MindMap cannot break subtitles.
 *
 * Emittery's `{ name, data }` listener shape stays inside this file; the rest of the app only ever
 * sees `AppBus`.
 */
export interface AppBus {
  emit<K extends BusEventName>(name: K, payload: BusEvents[K][0]): void;
  /** Returns an unsubscribe function. `module` labels the listener so failures are attributable. */
  on<K extends BusEventName>(
    module: ModuleId,
    name: K,
    handler: (payload: BusEvents[K][0]) => void | Promise<void>,
  ): () => void;
  onError(handler: (error: ModuleError) => void): () => void;
  snapshot(): { events: Partial<Record<BusEventName, number>>; listeners: number; errorListeners: number };
  clear(): void;
}

export function createBus(): AppBus {
  const emittery = new Emittery<BusEvents>();
  const counts: Partial<Record<BusEventName, number>> = {};
  const errorListeners = new Set<(error: ModuleError) => void>();
  let reportingError = false;

  const report = (error: ModuleError) => {
    // A broken error listener must not recurse into another emit.
    if (reportingError) return;
    reportingError = true;
    try {
      for (const listener of errorListeners) {
        try {
          listener(error);
        } catch {
          // A logger that fails cannot take the process down.
        }
      }
      emittery.emit("module.error", [error]).catch(() => undefined);
    } finally {
      reportingError = false;
    }
  };

  return {
    emit(name, payload) {
      counts[name] = (counts[name] ?? 0) + 1;
      if (name === "module.error") {
        report(payload as ModuleError);
        return;
      }
      emittery.emit(name, [payload] as BusEvents[typeof name]).catch((aggregate: unknown) => {
        report({
          module: "bus",
          code: "listener_threw",
          message: `${String(name)}: ${aggregate instanceof Error ? aggregate.message : String(aggregate)}`,
          at: Date.now(),
          recoverable: true,
        });
      });
    },

    on(module, name, handler) {
      // Emittery settles listeners with `allSettled`, so a rejection here would otherwise be
      // dropped silently: both the sync throw and the rejected promise must be reported.
      const listener = (event: { data: BusEvents[typeof name] }): Promise<void> => {
        const fail = (error: unknown) => {
          report({
            module,
            code: "handler_failed",
            message: `${String(name)}: ${error instanceof Error ? error.message : String(error)}`,
            at: Date.now(),
            recoverable: true,
          });
        };
        try {
          return Promise.resolve(handler(event.data[0])).catch(fail);
        } catch (error) {
          fail(error);
          return Promise.resolve();
        }
      };
      const off = emittery.on(name, listener as never);
      return () => {
        off();
      };
    },

    onError(handler) {
      errorListeners.add(handler);
      return () => {
        errorListeners.delete(handler);
      };
    },

    snapshot() {
      // Test F's "no leak" is mostly a listener question: a socket that closed or a core that
      // restarted without unsubscribing shows up here as a count that never comes back down, which
      // is invisible in `events` and shows in the heap only after it has already cost something.
      return { events: { ...counts }, listeners: emittery.listenerCount(), errorListeners: errorListeners.size };
    },

    clear() {
      emittery.clearListeners();
      errorListeners.clear();
      for (const key of Object.keys(counts)) delete counts[key as BusEventName];
    },
  };
}
