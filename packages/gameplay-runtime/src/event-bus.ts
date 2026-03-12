import { type GameplayEvent, type GameplayEventFilter, type GameplayEventInput, type GameplayRuntimeEventBus } from "./types";

type GameplayEventBusOptions = {
  historyLimit?: number;
  maxMicroPhases?: number;
  onEvent?: (event: GameplayEvent) => void;
};

export function createGameplayEventBus({
  historyLimit = 128,
  maxMicroPhases = 24,
  onEvent
}: GameplayEventBusOptions = {}): GameplayRuntimeEventBus {
  const queue: GameplayEvent[] = [];
  const history: GameplayEvent[] = [];
  const listeners = new Set<(event: GameplayEvent) => void>();
  let sequence = 0;

  return {
    emit(input) {
      const event: GameplayEvent = {
        ...input,
        id: `event:${sequence += 1}`,
        time: performance.now()
      };

      queue.push(event);
      return event;
    },
    flush() {
      const dispatched: GameplayEvent[] = [];
      let phase = 0;

      while (queue.length > 0) {
        phase += 1;

        if (phase > maxMicroPhases) {
          throw new Error("Gameplay event bus exceeded the allowed micro-phase depth.");
        }

        const batch = queue.splice(0, queue.length);

        batch.forEach((event) => {
          dispatched.push(event);
          history.push(event);

          if (history.length > historyLimit) {
            history.splice(0, history.length - historyLimit);
          }

          listeners.forEach((listener) => {
            listener(event);
          });
          onEvent?.(event);
        });
      }

      return dispatched;
    },
    getHistory() {
      return history;
    },
    subscribe(filter, listener) {
      const resolvedListener = typeof filter === "function" ? filter : listener;

      if (!resolvedListener) {
        return () => undefined;
      }

      const wrapped =
        typeof filter === "function"
          ? resolvedListener
          : (event: GameplayEvent) => {
              if (matchesEventFilter(event, filter)) {
                resolvedListener(event);
              }
            };

      listeners.add(wrapped);

      return () => {
        listeners.delete(wrapped);
      };
    }
  };
}

function matchesEventFilter(event: GameplayEvent, filter: GameplayEventFilter) {
  if (filter.event) {
    const allowed = Array.isArray(filter.event) ? filter.event : [filter.event];

    if (!allowed.includes(event.event)) {
      return false;
    }
  }

  if (filter.sourceHookType && filter.sourceHookType !== event.sourceHookType) {
    return false;
  }

  if (filter.sourceId && filter.sourceId !== event.sourceId) {
    return false;
  }

  if (filter.targetId && filter.targetId !== event.targetId) {
    return false;
  }

  return true;
}
