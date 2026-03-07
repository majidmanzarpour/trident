import {
  createAxisAlignedBrushFromBounds,
  extrudeAxisAlignedBrush,
  inflateEditableMesh,
  offsetAxisAlignedBrushFace,
  offsetEditableMeshTop,
  splitAxisAlignedBrush,
  splitAxisAlignedBrushAtCoordinate,
  type BrushAxis
} from "@web-hammer/geometry-kernel";
import type {
  Brush,
  BrushNode,
  EditableMesh,
  Entity,
  GeometryNode,
  MeshNode,
  ModelNode,
  Transform,
  Vec3
} from "@web-hammer/shared";
import { addVec3, isBrushNode, isMeshNode, scaleVec3, vec3 } from "@web-hammer/shared";
import type { Command } from "./command-stack";
import type { SceneDocument } from "../document/scene-document";

export type TransformAxis = "x" | "y" | "z";

export function createTranslateNodesCommand(nodeIds: string[], delta: Vec3): Command {
  return {
    label: "translate selection",
    execute(scene) {
      applyPositionDelta(scene, nodeIds, delta);
    },
    undo(scene) {
      applyPositionDelta(scene, nodeIds, scaleVec3(delta, -1));
    }
  };
}

export function createMirrorNodesCommand(nodeIds: string[], axis: TransformAxis): Command {
  return {
    label: `mirror ${axis}`,
    execute(scene) {
      flipScaleAxis(scene, nodeIds, axis);
    },
    undo(scene) {
      flipScaleAxis(scene, nodeIds, axis);
    }
  };
}

export function createSetNodeTransformCommand(
  scene: SceneDocument,
  nodeId: string,
  nextTransform: Transform,
  beforeTransform?: Transform
): Command {
  const node = scene.getNode(nodeId);

  if (!node) {
    return {
      label: "set transform",
      execute() {},
      undo() {}
    };
  }

  const before = structuredClone(beforeTransform ?? node.transform);
  const next = structuredClone(nextTransform);

  return {
    label: "set transform",
    execute(nextScene) {
      const nextNode = nextScene.getNode(nodeId);

      if (!nextNode) {
        return;
      }

      nextNode.transform = structuredClone(next);
      nextScene.touch();
    },
    undo(nextScene) {
      const nextNode = nextScene.getNode(nodeId);

      if (!nextNode) {
        return;
      }

      nextNode.transform = structuredClone(before);
      nextScene.touch();
    }
  };
}

export function createSetBrushDataCommand(
  scene: SceneDocument,
  nodeId: string,
  nextData: Brush,
  beforeData?: Brush
): Command {
  const node = scene.getNode(nodeId);

  if (!node || !isBrushNode(node)) {
    return {
      label: "set brush",
      execute() {},
      undo() {}
    };
  }

  const before = structuredClone(beforeData ?? node.data);
  const next = structuredClone(nextData);

  return {
    label: "set brush",
    execute(nextScene) {
      const nextNode = nextScene.getNode(nodeId);

      if (!nextNode || !isBrushNode(nextNode)) {
        return;
      }

      nextNode.data = structuredClone(next);
      nextScene.touch();
    },
    undo(nextScene) {
      const nextNode = nextScene.getNode(nodeId);

      if (!nextNode || !isBrushNode(nextNode)) {
        return;
      }

      nextNode.data = structuredClone(before);
      nextScene.touch();
    }
  };
}

export function createSetMeshDataCommand(
  scene: SceneDocument,
  nodeId: string,
  nextData: EditableMesh,
  beforeData?: EditableMesh
): Command {
  const node = scene.getNode(nodeId);

  if (!node || !isMeshNode(node)) {
    return {
      label: "set mesh",
      execute() {},
      undo() {}
    };
  }

  const before = structuredClone(beforeData ?? node.data);
  const next = structuredClone(nextData);

  return {
    label: "set mesh",
    execute(nextScene) {
      const nextNode = nextScene.getNode(nodeId);

      if (!nextNode || !isMeshNode(nextNode)) {
        return;
      }

      nextNode.data = structuredClone(next);
      nextScene.touch();
    },
    undo(nextScene) {
      const nextNode = nextScene.getNode(nodeId);

      if (!nextNode || !isMeshNode(nextNode)) {
        return;
      }

      nextNode.data = structuredClone(before);
      nextScene.touch();
    }
  };
}

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

export function createSplitBrushNodesCommand(
  scene: SceneDocument,
  nodeIds: string[],
  axis: BrushAxis
): {
  command: Command;
  splitIds: string[];
} {
  const plannedSplits = nodeIds
    .map((nodeId) => scene.getNode(nodeId))
    .filter((node): node is BrushNode => Boolean(node && isBrushNode(node)))
    .map((node) => {
      const splitBrushes = splitAxisAlignedBrush(node.data, axis);

      if (!splitBrushes) {
        return undefined;
      }

      return {
        original: structuredClone(node),
        replacements: splitBrushes.map((brush, index) => ({
          ...structuredClone(node),
          id: createDuplicateNodeId(scene, `${node.id}:clip:${axis}:${index + 1}`),
          name: `${node.name} ${axis.toUpperCase()}${index + 1}`,
          data: brush
        }))
      };
    })
    .filter((plan): plan is { original: BrushNode; replacements: BrushNode[] } => Boolean(plan));

  return {
    command: {
      label: `clip ${axis}`,
      execute(nextScene) {
        plannedSplits.forEach((plan) => {
          nextScene.removeNode(plan.original.id);
          plan.replacements.forEach((replacement) => {
            nextScene.addNode(structuredClone(replacement));
          });
        });
      },
      undo(nextScene) {
        plannedSplits.forEach((plan) => {
          plan.replacements.forEach((replacement) => {
            nextScene.removeNode(replacement.id);
          });
          nextScene.addNode(structuredClone(plan.original));
        });
      }
    },
    splitIds: plannedSplits.flatMap((plan) => plan.replacements.map((replacement) => replacement.id))
  };
}

export function createSplitBrushNodeAtCoordinateCommand(
  scene: SceneDocument,
  nodeId: string,
  axis: BrushAxis,
  coordinate: number
): {
  command: Command;
  splitIds: string[];
} {
  const node = scene.getNode(nodeId);

  if (!node || !isBrushNode(node)) {
    return {
      command: {
        label: `clip ${axis}`,
        execute() {},
        undo() {}
      },
      splitIds: []
    };
  }

  const splitBrushes = splitAxisAlignedBrushAtCoordinate(node.data, axis, coordinate);

  if (!splitBrushes) {
    return {
      command: {
        label: `clip ${axis}`,
        execute() {},
        undo() {}
      },
      splitIds: []
    };
  }

  const original = structuredClone(node);
  const replacements = splitBrushes.map((brush, index) => ({
    ...structuredClone(node),
    id: createDuplicateNodeId(scene, `${node.id}:clip:${axis}:${index + 1}`),
    name: `${node.name} ${axis.toUpperCase()}${index + 1}`,
    data: brush
  }));

  return {
    command: {
      label: `clip ${axis}`,
      execute(nextScene) {
        nextScene.removeNode(original.id);
        replacements.forEach((replacement) => {
          nextScene.addNode(structuredClone(replacement));
        });
      },
      undo(nextScene) {
        replacements.forEach((replacement) => {
          nextScene.removeNode(replacement.id);
        });
        nextScene.addNode(structuredClone(original));
      }
    },
    splitIds: replacements.map((replacement) => replacement.id)
  };
}

export function createExtrudeBrushNodesCommand(
  scene: SceneDocument,
  nodeIds: string[],
  axis: BrushAxis,
  amount: number,
  direction: -1 | 1
): Command {
  const snapshots = nodeIds
    .map((nodeId) => scene.getNode(nodeId))
    .filter((node): node is BrushNode => Boolean(node && isBrushNode(node)))
    .map((node) => ({
      before: structuredClone(node.data),
      next: extrudeAxisAlignedBrush(node.data, axis, amount, direction),
      nodeId: node.id
    }))
    .filter((snapshot): snapshot is { before: BrushNode["data"]; next: BrushNode["data"]; nodeId: string } => Boolean(snapshot.next));

  return {
    label: `extrude ${axis}`,
    execute(nextScene) {
      snapshots.forEach((snapshot) => {
        const node = nextScene.getNode(snapshot.nodeId);

        if (node && isBrushNode(node)) {
          node.data = structuredClone(snapshot.next);
          nextScene.touch();
        }
      });
    },
    undo(nextScene) {
      snapshots.forEach((snapshot) => {
        const node = nextScene.getNode(snapshot.nodeId);

        if (node && isBrushNode(node)) {
          node.data = structuredClone(snapshot.before);
          nextScene.touch();
        }
      });
    }
  };
}

export function createOffsetBrushFaceCommand(
  scene: SceneDocument,
  nodeId: string,
  axis: BrushAxis,
  side: "max" | "min",
  amount: number
): Command {
  const node = scene.getNode(nodeId);

  if (!node || !isBrushNode(node)) {
    return {
      label: `extrude ${axis}`,
      execute() {},
      undo() {}
    };
  }

  const next = offsetAxisAlignedBrushFace(node.data, axis, side, amount);

  if (!next) {
    return {
      label: `extrude ${axis}`,
      execute() {},
      undo() {}
    };
  }

  return createSetBrushDataCommand(scene, nodeId, next, node.data);
}

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

export function createPlaceBrushNodeCommand(
  scene: SceneDocument,
  transform: Transform,
  brush: Pick<BrushNode, "data" | "name"> = {
    data: createAxisAlignedBrushFromBounds({
      x: { min: -2, max: 2 },
      y: { min: -1.5, max: 1.5 },
      z: { min: -2, max: 2 }
    }),
    name: "Blockout Brush"
  }
): {
  command: Command;
  nodeId: string;
} {
  const nodeId = createDuplicateNodeId(scene, "node:brush:placed");
  const node: BrushNode = {
    id: nodeId,
    kind: "brush",
    name: brush.name,
    transform: structuredClone(transform),
    data: structuredClone(brush.data)
  };

  return {
    command: {
      label: "place brush",
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

export function createAssignMaterialToBrushesCommand(
  scene: SceneDocument,
  nodeIds: string[],
  materialId: string
): Command {
  const snapshots = nodeIds
    .map((nodeId) => scene.getNode(nodeId))
    .filter((node): node is BrushNode => Boolean(node && isBrushNode(node)))
    .map((node) => ({
      before: structuredClone(node.data.faces),
      nodeId: node.id,
      next: node.data.planes.map((plane, index) => ({
        id: node.data.faces[index]?.id ?? `face:${node.id}:${index}`,
        materialId,
        plane,
        vertexIds: node.data.faces[index]?.vertexIds ?? []
      }))
    }));

  return {
    label: "assign material",
    execute(nextScene) {
      snapshots.forEach((snapshot) => {
        const node = nextScene.getNode(snapshot.nodeId);

        if (node && isBrushNode(node)) {
          node.data.faces = structuredClone(snapshot.next);
          nextScene.touch();
        }
      });
    },
    undo(nextScene) {
      snapshots.forEach((snapshot) => {
        const node = nextScene.getNode(snapshot.nodeId);

        if (node && isBrushNode(node)) {
          node.data.faces = structuredClone(snapshot.before);
          nextScene.touch();
        }
      });
    }
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

function applyPositionDelta(scene: SceneDocument, nodeIds: string[], delta: Vec3) {
  nodeIds.forEach((nodeId) => {
    const node = scene.getNode(nodeId);

    if (!node) {
      return;
    }

    node.transform.position = addVec3(node.transform.position, delta);
    scene.touch();
  });
}

function flipScaleAxis(scene: SceneDocument, nodeIds: string[], axis: TransformAxis) {
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

function createDuplicateNodeId(scene: SceneDocument, sourceId: string): string {
  let attempt = 1;

  while (true) {
    const nodeId = `${sourceId}:copy:${attempt}`;

    if (!scene.getNode(nodeId)) {
      return nodeId;
    }

    attempt += 1;
  }
}

function createMeshMutationCommand(
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

export function axisDelta(axis: TransformAxis, amount: number): Vec3 {
  if (axis === "x") {
    return vec3(amount, 0, 0);
  }

  if (axis === "y") {
    return vec3(0, amount, 0);
  }

  return vec3(0, 0, amount);
}
