import { addVec3, resolveSceneGraph, type Entity, type GameplayValue, type GeometryNode, type Transform } from "@web-hammer/shared";
import { type GameplayHookTarget, type GameplayRuntimeHost, type GameplayRuntimeScene, type GameplayRuntimeSceneStore } from "./types";

type GameplaySceneStoreOptions = {
  host?: GameplayRuntimeHost;
  scene: GameplayRuntimeScene;
};

export function createGameplaySceneStore({
  host,
  scene
}: GameplaySceneStoreOptions): GameplayRuntimeSceneStore {
  const nodesById = new Map(scene.nodes.map((node) => [node.id, structuredClone(node)] as const));
  const entitiesById = new Map(scene.entities.map((entity) => [entity.id, structuredClone(entity)] as const));
  const initialNodeTransforms = new Map(scene.nodes.map((node) => [node.id, structuredClone(node.transform)] as const));
  const initialEntityTransforms = new Map(scene.entities.map((entity) => [entity.id, structuredClone(entity.transform)] as const));
  const hookTargets = buildHookTargets(nodesById, entitiesById);
  const hookTargetsByType = new Map<string, GameplayHookTarget[]>();
  const hookTargetById = new Map<string, GameplayHookTarget>();
  const localState = new Map<string, Map<string, GameplayValue>>();
  const playerState = new Map<string, GameplayValue>();
  const worldState = new Map<string, GameplayValue>();
  let sceneGraph = resolveSceneGraph(nodesById.values(), entitiesById.values());

  hookTargets.forEach((target) => {
    const byType = hookTargetsByType.get(target.hook.type) ?? [];
    byType.push(target);
    hookTargetsByType.set(target.hook.type, byType);
    hookTargetById.set(`${target.targetId}:${target.hook.id}`, target);
  });

  const syncWorldTransforms = () => {
    sceneGraph = resolveSceneGraph(nodesById.values(), entitiesById.values());

    nodesById.forEach((node, nodeId) => {
      host?.applyNodeWorldTransform?.(nodeId, sceneGraph.nodeWorldTransforms.get(nodeId) ?? node.transform, node);
    });
    entitiesById.forEach((entity, entityId) => {
      host?.applyEntityWorldTransform?.(entityId, sceneGraph.entityWorldTransforms.get(entityId) ?? entity.transform, entity);
    });
  };

  const readScopedState = (scope: Map<string, GameplayValue>, key: string) => scope.get(key);
  const writeScopedState = (scope: Map<string, GameplayValue>, key: string, value: GameplayValue) => {
    scope.set(key, value);
  };

  return {
    entitiesById,
    getEntity(entityId) {
      return entitiesById.get(entityId);
    },
    getLocalState(targetId, key) {
      return localState.get(targetId)?.get(key);
    },
    getEntityWorldTransform(entityId) {
      return sceneGraph.entityWorldTransforms.get(entityId);
    },
    getHookTarget(targetId, hookId) {
      return hookTargetById.get(`${targetId}:${hookId}`);
    },
    getHookTargets() {
      return hookTargets;
    },
    getHookTargetsByType(type) {
      return hookTargetsByType.get(type) ?? [];
    },
    getNode(nodeId) {
      return nodesById.get(nodeId);
    },
    getNodeWorldTransform(nodeId) {
      return sceneGraph.nodeWorldTransforms.get(nodeId);
    },
    getPlayerState(key) {
      return readScopedState(playerState, key);
    },
    getTargetInitialLocalTransform(targetId) {
      return initialNodeTransforms.get(targetId) ?? initialEntityTransforms.get(targetId);
    },
    getTargetLocalTransform(targetId) {
      return nodesById.get(targetId)?.transform ?? entitiesById.get(targetId)?.transform;
    },
    getTargetWorldTransform(targetId) {
      return sceneGraph.nodeWorldTransforms.get(targetId) ?? sceneGraph.entityWorldTransforms.get(targetId);
    },
    getWorldState(key) {
      return readScopedState(worldState, key);
    },
    nodesById,
    resetTargetLocalTransform(targetId) {
      const initialTransform = initialNodeTransforms.get(targetId) ?? initialEntityTransforms.get(targetId);

      if (initialTransform) {
        this.setTargetLocalTransform(targetId, initialTransform);
      }
    },
    setLocalState(targetId, key, value) {
      const scopedState = localState.get(targetId) ?? new Map<string, GameplayValue>();
      scopedState.set(key, value);
      localState.set(targetId, scopedState);
    },
    setPlayerState(key, value) {
      writeScopedState(playerState, key, value);
    },
    setTargetLocalTransform(targetId, transform) {
      const node = nodesById.get(targetId);

      if (node) {
        node.transform = structuredClone(transform);
        syncWorldTransforms();
        return;
      }

      const entity = entitiesById.get(targetId);

      if (entity) {
        entity.transform = structuredClone(transform);
        syncWorldTransforms();
      }
    },
    setWorldState(key, value) {
      writeScopedState(worldState, key, value);
    },
    syncWorldTransforms,
    translateTarget(targetId, offset) {
      const currentTransform = this.getTargetLocalTransform(targetId);

      if (!currentTransform) {
        return;
      }

      this.setTargetLocalTransform(targetId, {
        ...currentTransform,
        position: addVec3(currentTransform.position, offset)
      });
    }
  };
}

function buildHookTargets(nodesById: Map<string, GeometryNode>, entitiesById: Map<string, Entity>): GameplayHookTarget[] {
  const nodeTargets = Array.from(nodesById.values()).flatMap((node) =>
    (node.hooks ?? []).map((hook) => ({
      hook,
      node,
      targetId: node.id,
      targetKind: "node" as const
    }))
  );
  const entityTargets = Array.from(entitiesById.values()).flatMap((entity) =>
    (entity.hooks ?? []).map((hook) => ({
      entity,
      hook,
      targetId: entity.id,
      targetKind: "entity" as const
    }))
  );

  return [...nodeTargets, ...entityTargets];
}
