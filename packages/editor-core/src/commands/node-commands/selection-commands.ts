import type { Entity, GeometryNode, Vec3 } from "@web-hammer/shared";
import { addVec3 } from "@web-hammer/shared";
import type { Command } from "../command-stack";
import type { SceneDocument } from "../../document/scene-document";
import { createDuplicateNodeId } from "./helpers";

export function createDuplicateNodesCommand(
  scene: SceneDocument,
  nodeIds: string[],
  offset: Vec3
): {
  command: Command;
  duplicateIds: string[];
} {
  const duplicates = nodeIds
    .map((nodeId) => scene.getNode(nodeId))
    .filter((node): node is GeometryNode => Boolean(node))
    .map((node) => {
      const duplicate = structuredClone(node);
      duplicate.id = createDuplicateNodeId(scene, node.id);
      duplicate.name = `${node.name} Copy`;
      duplicate.transform.position = addVec3(node.transform.position, offset);
      return duplicate;
    });

  return {
    command: {
      label: "duplicate selection",
      execute(nextScene) {
        duplicates.forEach((duplicate) => {
          nextScene.addNode(structuredClone(duplicate));
        });
      },
      undo(nextScene) {
        duplicates.forEach((duplicate) => {
          nextScene.removeNode(duplicate.id);
        });
      }
    },
    duplicateIds: duplicates.map((duplicate) => duplicate.id)
  };
}

export function createDeleteSelectionCommand(scene: SceneDocument, ids: string[]): Command {
  const nodes = ids
    .map((id) => scene.getNode(id))
    .filter((node): node is GeometryNode => Boolean(node))
    .map((node) => structuredClone(node));
  const entities = ids
    .map((id) => scene.getEntity(id))
    .filter((entity): entity is Entity => Boolean(entity))
    .map((entity) => structuredClone(entity));

  return {
    label: "delete selection",
    execute(nextScene) {
      nodes.forEach((node) => {
        nextScene.removeNode(node.id);
      });
      entities.forEach((entity) => {
        nextScene.removeEntity(entity.id);
      });
    },
    undo(nextScene) {
      nodes.forEach((node) => {
        nextScene.addNode(structuredClone(node));
      });
      entities.forEach((entity) => {
        nextScene.addEntity(structuredClone(entity));
      });
    }
  };
}

export function createReplaceNodesCommand(
  scene: SceneDocument,
  nextNodes: GeometryNode[],
  label = "replace nodes"
): Command {
  const snapshots = nextNodes
    .map((nextNode) => {
      const before = scene.getNode(nextNode.id);

      if (!before) {
        return undefined;
      }

      return {
        before: structuredClone(before),
        next: structuredClone(nextNode)
      };
    })
    .filter((snapshot): snapshot is { before: GeometryNode; next: GeometryNode } => Boolean(snapshot));

  return {
    label,
    execute(nextScene) {
      snapshots.forEach((snapshot) => {
        nextScene.nodes.set(snapshot.next.id, structuredClone(snapshot.next));
        nextScene.touch();
      });
    },
    undo(nextScene) {
      snapshots.forEach((snapshot) => {
        nextScene.nodes.set(snapshot.before.id, structuredClone(snapshot.before));
        nextScene.touch();
      });
    }
  };
}