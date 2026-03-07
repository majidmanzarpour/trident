import type { MeshNode, Vec3 } from "@web-hammer/shared";
import { addVec3, isMeshNode } from "@web-hammer/shared";
import type { Command } from "../command-stack";
import type { SceneDocument } from "../../document/scene-document";
import type { TransformAxis } from "./transform-commands";

export function applyPositionDelta(scene: SceneDocument, nodeIds: string[], delta: Vec3) {
  nodeIds.forEach((nodeId) => {
    const node = scene.getNode(nodeId);

    if (!node) {
      return;
    }

    node.transform.position = addVec3(node.transform.position, delta);
    scene.touch();
  });
}

export function flipScaleAxis(scene: SceneDocument, nodeIds: string[], axis: TransformAxis) {
  nodeIds.forEach((nodeId) => {
    const node = scene.getNode(nodeId);

    if (!node) {
      return;
    }

    node.transform.scale = {
      ...node.transform.scale,
      [axis]: node.transform.scale[axis] * -1
    };
    scene.touch();
  });
}

export function createDuplicateNodeId(scene: SceneDocument, sourceId: string): string {
  let attempt = 1;

  while (true) {
    const nodeId = `${sourceId}:copy:${attempt}`;

    if (!scene.getNode(nodeId)) {
      return nodeId;
    }

    attempt += 1;
  }
}

export function createMeshMutationCommand(
  label: string,
  snapshots: Array<{ before: MeshNode["data"]; next: MeshNode["data"]; nodeId: string }>
): Command {
  return {
    label,
    execute(nextScene) {
      snapshots.forEach((snapshot) => {
        const node = nextScene.getNode(snapshot.nodeId);

        if (node && isMeshNode(node)) {
          node.data = structuredClone(snapshot.next);
          nextScene.touch();
        }
      });
    },
    undo(nextScene) {
      snapshots.forEach((snapshot) => {
        const node = nextScene.getNode(snapshot.nodeId);

        if (node && isMeshNode(node)) {
          node.data = structuredClone(snapshot.before);
          nextScene.touch();
        }
      });
    }
  };
}