import type { BrushNode, Entity, ModelNode, Transform, Vec3 } from "@web-hammer/shared";
import { vec3 } from "@web-hammer/shared";
import type { Command } from "../command-stack";
import type { SceneDocument } from "../../document/scene-document";
import { createDuplicateNodeId } from "./helpers";

export function createPlaceModelNodeCommand(
  scene: SceneDocument,
  position: Vec3,
  model: Pick<ModelNode, "data" | "name">
): {
  command: Command;
  nodeId: string;
} {
  const nodeId = createDuplicateNodeId(scene, "node:model:placed");
  const node: ModelNode = {
    id: nodeId,
    kind: "model",
    name: model.name,
    transform: {
      position,
      rotation: vec3(0, 0, 0),
      scale: vec3(1, 1, 1)
    },
    data: structuredClone(model.data)
  };

  return {
    command: {
      label: "place asset",
      execute(nextScene) {
        nextScene.addNode(structuredClone(node));
      },
      undo(nextScene) {
        nextScene.removeNode(node.id);
      }
    },
    nodeId
  };
}

export function createPlaceEntityCommand(entity: Entity): Command {
  return {
    label: "place entity",
    execute(scene) {
      scene.addEntity(structuredClone(entity));
    },
    undo(scene) {
      scene.removeEntity(entity.id);
    }
  };
}