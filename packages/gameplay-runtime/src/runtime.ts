import { createGameplayEventBus } from "./event-bus";
import { createGameplaySceneStore } from "./scene-store";
import { type GameplayActor, type GameplayEventInput, type GameplayHookTarget, type GameplayRuntime, type GameplayRuntimeApi, type GameplayRuntimeHost, type GameplayRuntimeScene, type GameplayRuntimeSystemContext, type GameplayRuntimeSystemDefinition } from "./types";

type GameplayRuntimeOptions = {
  host?: GameplayRuntimeHost;
  scene: GameplayRuntimeScene;
  systems?: GameplayRuntimeSystemDefinition[];
};

export function createGameplayRuntime({
  host,
  scene,
  systems = []
}: GameplayRuntimeOptions): GameplayRuntime {
  const sceneStore = createGameplaySceneStore({ host, scene });
  const eventBus = createGameplayEventBus({
    onEvent: host?.onEvent
  });
  const api: GameplayRuntimeApi = {
    emitEvent(input: GameplayEventInput) {
      return eventBus.emit(input);
    },
    emitFromHookTarget(target: GameplayHookTarget, eventName, payload, targetId = target.targetId) {
      return eventBus.emit({
        event: eventName,
        payload,
        sourceHookType: target.hook.type,
        sourceId: target.targetId,
        sourceKind: target.targetKind,
        targetId
      });
    },
    getActor: sceneStore.getActor,
    getActors: sceneStore.getActors,
    getEntity: sceneStore.getEntity,
    getEntityWorldTransform: sceneStore.getEntityWorldTransform,
    getHookTarget: sceneStore.getHookTarget,
    getHookTargets: sceneStore.getHookTargets,
    getHookTargetsByType: sceneStore.getHookTargetsByType,
    getLocalState: sceneStore.getLocalState,
    getNode: sceneStore.getNode,
    getNodeWorldTransform: sceneStore.getNodeWorldTransform,
    getPlayerState: sceneStore.getPlayerState,
    getTargetInitialLocalTransform: sceneStore.getTargetInitialLocalTransform,
    getTargetLocalTransform: sceneStore.getTargetLocalTransform,
    getTargetWorldTransform: sceneStore.getTargetWorldTransform,
    getWorldState: sceneStore.getWorldState,
    onEvent: eventBus.subscribe,
    removeActor(actorId: string) {
      sceneStore.removeActor(actorId);
    },
    resetTargetLocalTransform: sceneStore.resetTargetLocalTransform,
    setLocalState: sceneStore.setLocalState,
    setPlayerState: sceneStore.setPlayerState,
    setTargetLocalTransform: sceneStore.setTargetLocalTransform,
    setWorldState: sceneStore.setWorldState,
    translateTarget: sceneStore.translateTarget,
    updateActor(actor: GameplayActor) {
      sceneStore.upsertActor(actor);
    }
  };
  const context: GameplayRuntimeSystemContext = {
    ...api,
    eventBus,
    scene: sceneStore
  };
  const systemInstances = systems.map((systemDefinition) => ({
    definition: systemDefinition,
    instance: systemDefinition.create(context)
  }));
  let started = false;

  return {
    ...api,
    dispose() {
      systemInstances.forEach((system) => {
        system.instance.stop?.();
      });
      eventBus.flush();
    },
    eventBus,
    scene: sceneStore,
    start() {
      if (started) {
        return;
      }

      sceneStore.syncWorldTransforms();
      systemInstances.forEach((system) => {
        system.instance.start?.();
      });
      eventBus.flush();
      started = true;
    },
    stop() {
      if (!started) {
        return;
      }

      systemInstances.forEach((system) => {
        system.instance.stop?.();
      });
      started = false;
    },
    update(deltaSeconds) {
      if (!started) {
        return;
      }

      eventBus.flush();
      systemInstances.forEach((system) => {
        system.instance.update?.(deltaSeconds);
      });
      eventBus.flush();
    }
  };
}
