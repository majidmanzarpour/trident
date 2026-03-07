import { inflateEditableMesh, offsetEditableMeshTop } from "@web-hammer/geometry-kernel";
import type { MeshNode } from "@web-hammer/shared";
import { isMeshNode } from "@web-hammer/shared";
import type { Command } from "../command-stack";
import type { SceneDocument } from "../../document/scene-document";
import { createMeshMutationCommand } from "./helpers";

export function createMeshInflateCommand(scene: SceneDocument, nodeIds: string[], factor: number): Command {
  const snapshots = nodeIds
    .map((nodeId) => scene.getNode(nodeId))
    .filter((node): node is MeshNode => Boolean(node && isMeshNode(node)))
    .map((node) => ({
      before: structuredClone(node.data),
      next: inflateEditableMesh(node.data, factor),
      nodeId: node.id
    }));

  return createMeshMutationCommand("mesh inflate", snapshots);
}

export function createMeshRaiseTopCommand(scene: SceneDocument, nodeIds: string[], amount: number): Command {
  const snapshots = nodeIds
    .map((nodeId) => scene.getNode(nodeId))
    .filter((node): node is MeshNode => Boolean(node && isMeshNode(node)))
    .map((node) => ({
      before: structuredClone(node.data),
      next: offsetEditableMeshTop(node.data, amount),
      nodeId: node.id
    }));

  return createMeshMutationCommand("mesh raise top", snapshots);
}