import { vec3, type GameplayObject, type GameplayValue, type Transform, type Vec3 } from "@web-hammer/shared";
import { type GameplayPathDefinition, type GameplayPathResolver, type GameplayRuntimeSystemDefinition, type GameplaySystemBlueprint } from "./types";

export const GAMEPLAY_SYSTEM_BLUEPRINTS: GameplaySystemBlueprint[] = [
  {
    description: "Queues and dispatches events with target filtering, frame ordering, and recursion guards.",
    id: "event_bus",
    implemented: true,
    label: "EventBus"
  },
  {
    description: "Overlap checks, enter/exit tracking, fire-once, cooldowns, and actor filtering.",
    hookTypes: ["trigger_volume"],
    id: "trigger",
    implemented: false,
    label: "TriggerSystem"
  },
  {
    description: "Selects current interact target and emits interact.requested with actor context.",
    hookTypes: ["interactable"],
    id: "interaction",
    implemented: false,
    label: "InteractionSystem"
  },
  {
    description: "Evaluates keys, items, flags, and codes and emits allow or deny results.",
    hookTypes: ["lock"],
    id: "lock",
    implemented: false,
    label: "LockSystem"
  },
  {
    description: "Tracks door or hatch logical state and forwards movement requests.",
    hookTypes: ["openable"],
    id: "openable",
    implemented: true,
    label: "OpenableSystem"
  },
  {
    description: "Animates transforms or authored clips deterministically.",
    hookTypes: ["mover"],
    id: "mover",
    implemented: true,
    label: "MoverSystem"
  },
  {
    description: "Moves targets along paths or splines and manages progress state.",
    hookTypes: ["path_mover"],
    id: "path_mover",
    implemented: true,
    label: "PathMoverSystem"
  },
  {
    description: "Handles pickups and grants inventory or state rewards.",
    hookTypes: ["pickup"],
    id: "pickup",
    implemented: false,
    label: "PickupSystem"
  },
  {
    description: "Stores inventory state such as keys and items.",
    hookTypes: ["inventory_keys"],
    id: "inventory",
    implemented: false,
    label: "InventorySystem"
  },
  {
    description: "Tracks health state and zero transitions.",
    hookTypes: ["health"],
    id: "health",
    implemented: false,
    label: "HealthSystem"
  },
  {
    description: "Applies damage and kill events with typed payloads.",
    hookTypes: ["damageable"],
    id: "damage",
    implemented: false,
    label: "DamageSystem"
  },
  {
    description: "Creates runtime entities or prefabs and enforces spawn rules.",
    hookTypes: ["spawner"],
    id: "spawner",
    implemented: false,
    label: "SpawnerSystem"
  },
  {
    description: "Manages AI enablement and target assignment.",
    hookTypes: ["ai_agent"],
    id: "ai",
    implemented: false,
    label: "AiSystem"
  },
  {
    description: "Routes gameplay events to audio playback.",
    hookTypes: ["audio_emitter"],
    id: "audio",
    implemented: false,
    label: "AudioSystem"
  },
  {
    description: "Manages world and mission flag writes or queries.",
    hookTypes: ["flag_setter", "flag_condition"],
    id: "flag",
    implemented: false,
    label: "FlagSystem"
  },
  {
    description: "Runs ordered action lists triggered by events.",
    hookTypes: ["sequence"],
    id: "sequence",
    implemented: false,
    label: "SequenceSystem"
  },
  {
    description: "Tracks allOf or anyOf event conditions and fires actions when met.",
    hookTypes: ["condition_listener"],
    id: "condition",
    implemented: false,
    label: "ConditionSystem"
  }
];

export function createOpenableSystemDefinition(): GameplayRuntimeSystemDefinition {
  return {
    description: "Tracks open and close state and emits lifecycle events while delegating movement.",
    hookTypes: ["openable"],
    id: "openable",
    label: "OpenableSystem",
    create(context) {
      const unsubscribeRequests = context.eventBus.subscribe(
        { event: ["open.requested", "close.requested", "toggle.requested"] },
        (event) => {
          if (!event.targetId) {
            return;
          }

          context.getHookTargetsByType("openable")
            .filter((target) => target.targetId === event.targetId && target.hook.enabled !== false)
            .forEach((target) => {
              const currentState = readOpenableState(context.getLocalState(target.targetId, "openable:state"), resolveOpenableInitialState(target.hook.config));
              const nextState =
                event.event === "toggle.requested"
                  ? currentState === "open" || currentState === "opening"
                    ? "closed"
                    : "open"
                  : event.event === "open.requested"
                    ? "open"
                    : "closed";

              if (nextState === "open" && (currentState === "open" || currentState === "opening")) {
                return;
              }

              if (nextState === "closed" && (currentState === "closed" || currentState === "closing")) {
                return;
              }

              context.setLocalState(target.targetId, "openable:state", nextState === "open" ? "opening" : "closing");
              context.emitFromHookTarget(target, nextState === "open" ? "open.started" : "close.started");
              context.emitFromHookTarget(target, "move.to", { state: nextState });
            });
        }
      );
      const unsubscribeMovement = context.eventBus.subscribe({ event: "move.completed" }, (event) => {
        if (!event.targetId) {
          return;
        }

        context.getHookTargetsByType("openable")
          .filter((target) => target.targetId === event.targetId && target.hook.enabled !== false)
          .forEach((target) => {
            const nextState = readStateName(event.payload) === "open" ? "open" : "closed";
            context.setLocalState(target.targetId, "openable:state", nextState);
            context.emitFromHookTarget(target, nextState === "open" ? "open.completed" : "close.completed");
            context.emitFromHookTarget(target, "state.changed", nextState);
          });
      });

      return {
        start() {
          context.getHookTargetsByType("openable").forEach((target) => {
            context.setLocalState(target.targetId, "openable:state", resolveOpenableInitialState(target.hook.config));
          });
        },
        stop() {
          unsubscribeRequests();
          unsubscribeMovement();
        }
      };
    }
  };
}

export function createMoverSystemDefinition(): GameplayRuntimeSystemDefinition {
  return {
    description: "Animates local transforms toward named target states.",
    hookTypes: ["mover"],
    id: "mover",
    label: "MoverSystem",
    create(context) {
      const activeAnimations = new Map<
        string,
        {
          duration: number;
          from: Transform;
          progress: number;
          state: string;
          targetId: string;
          to: Transform;
        }
      >();
      const unsubscribe = context.eventBus.subscribe({ event: ["move.to", "open.started", "close.started"] }, (event) => {
        if (!event.targetId) {
          return;
        }

        context.getHookTargetsByType("mover")
          .filter((target) => target.targetId === event.targetId && target.hook.enabled !== false)
          .forEach((target) => {
            const state =
              event.event === "open.started"
                ? "open"
                : event.event === "close.started"
                  ? "closed"
                  : readStateName(event.payload);
            const targetTransform = resolveMoverTargetTransform(target.hook.config, state, context.getTargetInitialLocalTransform(target.targetId));
            const currentTransform = context.getTargetLocalTransform(target.targetId);

            if (!targetTransform || !currentTransform) {
              return;
            }

            activeAnimations.set(target.hook.id, {
              duration: Math.max(0.001, readNumber(target.hook.config.duration, 0.8)),
              from: structuredClone(currentTransform),
              progress: 0,
              state,
              targetId: target.targetId,
              to: targetTransform
            });
            context.emitFromHookTarget(target, "move.started", { state });
          });
      });

      return {
        stop() {
          unsubscribe();
          activeAnimations.clear();
        },
        update(deltaSeconds) {
          activeAnimations.forEach((animation, hookId) => {
            const hookTarget = context.getHookTargets().find((target) => target.hook.id === hookId);

            if (!hookTarget) {
              activeAnimations.delete(hookId);
              return;
            }

            animation.progress = Math.min(1, animation.progress + deltaSeconds / animation.duration);
            context.setTargetLocalTransform(animation.targetId, interpolateTransform(animation.from, animation.to, animation.progress));

            if (animation.progress >= 1) {
              activeAnimations.delete(hookId);
              context.emitFromHookTarget(hookTarget, "move.completed", { state: animation.state });
            }
          });
        }
      };
    }
  };
}

export function createPathMoverSystemDefinition(resolvePath: GameplayPathResolver): GameplayRuntimeSystemDefinition {
  return {
    description: "Moves targets along consumer-provided paths and emits start, stop, and completion events.",
    hookTypes: ["path_mover"],
    id: "path_mover",
    label: "PathMoverSystem",
    create(context) {
      const unsubscribe = context.eventBus.subscribe(
        { event: ["path.start", "path.stop", "path.pause", "path.resume", "path.reverse"] },
        (event) => {
          if (!event.targetId) {
            return;
          }

          context.getHookTargetsByType("path_mover")
            .filter((target) => target.targetId === event.targetId && target.hook.enabled !== false)
            .forEach((target) => {
              const nextState = ensurePathState(context, target.targetId, target.hook.config);

              if (event.event === "path.start") {
                nextState.active = true;
                nextState.paused = false;
                context.emitFromHookTarget(target, "path.started");
              } else if (event.event === "path.stop") {
                nextState.active = false;
                nextState.paused = false;
                context.emitFromHookTarget(target, "path.stopped");
              } else if (event.event === "path.pause") {
                nextState.paused = true;
              } else if (event.event === "path.resume") {
                nextState.paused = false;
              } else if (event.event === "path.reverse") {
                nextState.direction = nextState.direction === 1 ? -1 : 1;
              }

              context.setLocalState(target.targetId, "path_mover:state", nextState);
            });
        }
      );

      return {
        start() {
          context.getHookTargetsByType("path_mover").forEach((target) => {
            const state = ensurePathState(context, target.targetId, target.hook.config);

            if (state.active) {
              context.emitFromHookTarget(target, "path.started");
            }
          });
        },
        stop() {
          unsubscribe();
        },
        update(deltaSeconds) {
          context.getHookTargetsByType("path_mover")
            .filter((target) => target.hook.enabled !== false)
            .forEach((target) => {
              const state = ensurePathState(context, target.targetId, target.hook.config);
              const path = resolvePath(target);
              const baseTransform = context.getTargetInitialLocalTransform(target.targetId);

              if (!state.active || state.paused || !path || !baseTransform) {
                return;
              }

              const speed = Math.max(0.001, readNumber(target.hook.config.speed, 0.1));
              state.progress += deltaSeconds * speed * state.direction;

              if (readBoolean(target.hook.config.loop, path.loop ?? false)) {
                state.progress = wrapProgress(state.progress);
              } else if (state.progress >= 1 || state.progress <= 0) {
                state.progress = clampProgress(state.progress);

                if (readBoolean(target.hook.config.stopAtEnd, true)) {
                  state.active = false;
                  context.emitFromHookTarget(target, "path.completed");
                }
              }

              context.setTargetLocalTransform(target.targetId, {
                ...baseTransform,
                position: path.sample(state.progress)
              });
              context.setLocalState(target.targetId, "path_mover:state", state);
            });
        }
      };
    }
  };
}

export function createWaypointPath(points: Vec3[], loop = false): GameplayPathDefinition {
  const normalizedPoints = points.length > 0 ? points : [vec3(0, 0, 0)];

  return {
    loop,
    sample(progress) {
      if (normalizedPoints.length === 1) {
        return normalizedPoints[0];
      }

      const clampedProgress = clampProgress(progress);
      const scaled = clampedProgress * (normalizedPoints.length - 1);
      const index = Math.min(normalizedPoints.length - 2, Math.floor(scaled));
      const nextIndex = Math.min(normalizedPoints.length - 1, index + 1);
      const alpha = scaled - index;
      const start = normalizedPoints[index];
      const end = normalizedPoints[nextIndex];

      return vec3(
        start.x + (end.x - start.x) * alpha,
        start.y + (end.y - start.y) * alpha,
        start.z + (end.z - start.z) * alpha
      );
    }
  };
}

function resolveOpenableInitialState(config: GameplayObject) {
  return readString(config.initialState, "closed") === "open" ? "open" : "closed";
}

function resolveMoverTargetTransform(config: GameplayObject, state: string, fallback?: Transform) {
  const targets = asObject(config.targets);
  const nextState = asObject(targets?.[state]);
  const base = structuredClone(fallback);

  if (!base || !nextState) {
    return undefined;
  }

  return {
    ...base,
    position: readVec3(nextState.position, base.position),
    rotation: readVec3(nextState.rotation, base.rotation),
    scale: readVec3(nextState.scale, base.scale)
  };
}

function ensurePathState(context: Parameters<Exclude<GameplayRuntimeSystemDefinition["create"], undefined>>[0], targetId: string, config: GameplayObject) {
  const current = asObject(context.getLocalState(targetId, "path_mover:state"));

  if (current) {
    return {
      active: readBoolean(current.active, false),
      direction: readNumber(current.direction, 1) < 0 ? -1 as const : 1 as const,
      paused: readBoolean(current.paused, false),
      progress: readNumber(current.progress, 0)
    };
  }

  return {
    active: readBoolean(config.active, false),
    direction: readBoolean(config.reverse, false) ? -1 as const : 1 as const,
    paused: false,
    progress: 0
  };
}

function interpolateTransform(from: Transform, to: Transform, progress: number): Transform {
  return {
    pivot: to.pivot ?? from.pivot,
    position: interpolateVec3(from.position, to.position, progress),
    rotation: interpolateVec3(from.rotation, to.rotation, progress),
    scale: interpolateVec3(from.scale, to.scale, progress)
  };
}

function interpolateVec3(from: Vec3, to: Vec3, progress: number): Vec3 {
  return vec3(
    from.x + (to.x - from.x) * progress,
    from.y + (to.y - from.y) * progress,
    from.z + (to.z - from.z) * progress
  );
}

function readOpenableState(value: GameplayValue | undefined, fallback: "closed" | "open") {
  return value === "opening" || value === "closing" || value === "open" || value === "closed" ? value : fallback;
}

function readStateName(payload: unknown) {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload && typeof payload === "object" && "state" in payload && typeof payload.state === "string") {
    return payload.state;
  }

  return "open";
}

function readString(value: GameplayValue | undefined, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: GameplayValue | undefined, fallback: number) {
  return typeof value === "number" ? value : fallback;
}

function readBoolean(value: GameplayValue | undefined, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function readVec3(value: GameplayValue | undefined, fallback: Vec3) {
  if (!Array.isArray(value) || value.length < 3) {
    return fallback;
  }

  return vec3(
    typeof value[0] === "number" ? value[0] : fallback.x,
    typeof value[1] === "number" ? value[1] : fallback.y,
    typeof value[2] === "number" ? value[2] : fallback.z
  );
}

function asObject(value: GameplayValue | undefined) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function clampProgress(value: number) {
  return Math.min(1, Math.max(0, value));
}

function wrapProgress(value: number) {
  if (value < 0) {
    return 1 - (Math.abs(value) % 1);
  }

  return value % 1;
}
