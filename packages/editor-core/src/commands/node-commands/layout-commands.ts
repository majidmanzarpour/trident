import { createAxisAlignedBrushFromBounds } from "@web-hammer/geometry-kernel";
import type { BrushNode, MetadataValue, Vec3 } from "@web-hammer/shared";
import { makeTransform, vec3 } from "@web-hammer/shared";
import type { Command } from "../command-stack";
import type { SceneDocument } from "../../document/scene-document";
import { createDuplicateNodeId } from "./helpers";

export type BlockoutDirection = "east" | "north" | "south" | "west";
export type BlockoutOpenSide = "bottom" | "east" | "north" | "south" | "top" | "west";

export type BlockoutPlatformSpec = {
  materialId?: string;
  metadata?: Record<string, MetadataValue>;
  name?: string;
  position: Vec3;
  size: Vec3;
  tags?: string[];
};

export type BlockoutRoomSpec = {
  ceilingThickness?: number;
  floorThickness?: number;
  materialId?: string;
  metadata?: Record<string, MetadataValue>;
  name?: string;
  openSides?: BlockoutOpenSide[];
  position: Vec3;
  size: Vec3;
  tags?: string[];
  wallThickness?: number;
};

export type BlockoutStairSpec = {
  direction?: BlockoutDirection;
  landingDepth?: number;
  materialId?: string;
  metadata?: Record<string, MetadataValue>;
  name?: string;
  position: Vec3;
  stepCount: number;
  stepHeight: number;
  tags?: string[];
  topLandingDepth?: number;
  treadDepth: number;
  width: number;
};

export function createPlaceBlockoutPlatformCommand(
  scene: SceneDocument,
  spec: BlockoutPlatformSpec
): {
  command: Command;
  nodeId: string;
} {
  const nodeId = createDuplicateNodeId(scene, "node:blockout:platform");
  const materialId = spec.materialId ?? "material:blockout:concrete";
  const tags = dedupeTags(["blockout", "platform", ...(spec.tags ?? [])]);
  const metadata = { ...(spec.metadata ?? {}), blockoutKind: "platform" };
  const node = createBlockoutBrushNode({
    id: nodeId,
    materialId,
    metadata,
    name: spec.name ?? "Blockout Platform",
    position: spec.position,
    size: spec.size,
    tags
  });

  return {
    command: createPlaceNodesCommand("place blockout platform", [node]),
    nodeId
  };
}

export function createPlaceBlockoutRoomCommand(
  scene: SceneDocument,
  spec: BlockoutRoomSpec
): {
  command: Command;
  groupId: string;
  nodeIds: string[];
} {
  const groupId = createDuplicateNodeId(scene, "group:blockout:room");
  const floorThickness = Math.max(0.1, spec.floorThickness ?? 0.25);
  const ceilingThickness = Math.max(0.1, spec.ceilingThickness ?? 0.25);
  const wallThickness = Math.max(0.1, spec.wallThickness ?? 0.25);
  const materialId = spec.materialId ?? "material:blockout:concrete";
  const openSides = new Set(spec.openSides ?? []);
  const tags = dedupeTags(["blockout", "room", ...(spec.tags ?? [])]);
  const metadata = {
    ...(spec.metadata ?? {}),
    blockoutGroup: groupId,
    blockoutKind: "room"
  };
  const outerWidth = spec.size.x + wallThickness * 2;
  const outerDepth = spec.size.z + wallThickness * 2;
  const nodes: BrushNode[] = [];

  if (!openSides.has("bottom")) {
    nodes.push(
      createBlockoutBrushNode({
        id: `${groupId}:floor`,
        materialId,
        metadata: { ...metadata, blockoutPart: "floor" },
        name: `${spec.name ?? "Blockout Room"} Floor`,
        position: vec3(spec.position.x, spec.position.y - floorThickness * 0.5, spec.position.z),
        size: vec3(outerWidth, floorThickness, outerDepth),
        tags: dedupeTags([...tags, "floor"])
      })
    );
  }

  if (!openSides.has("top")) {
    nodes.push(
      createBlockoutBrushNode({
        id: `${groupId}:ceiling`,
        materialId,
        metadata: { ...metadata, blockoutPart: "ceiling" },
        name: `${spec.name ?? "Blockout Room"} Ceiling`,
        position: vec3(spec.position.x, spec.position.y + spec.size.y + ceilingThickness * 0.5, spec.position.z),
        size: vec3(outerWidth, ceilingThickness, outerDepth),
        tags: dedupeTags([...tags, "ceiling"])
      })
    );
  }

  if (!openSides.has("west")) {
    nodes.push(
      createBlockoutBrushNode({
        id: `${groupId}:wall:west`,
        materialId,
        metadata: { ...metadata, blockoutPart: "wall", blockoutSide: "west" },
        name: `${spec.name ?? "Blockout Room"} West Wall`,
        position: vec3(
          spec.position.x - (spec.size.x + wallThickness) * 0.5,
          spec.position.y + spec.size.y * 0.5,
          spec.position.z
        ),
        size: vec3(wallThickness, spec.size.y, outerDepth),
        tags: dedupeTags([...tags, "wall", "west"])
      })
    );
  }

  if (!openSides.has("east")) {
    nodes.push(
      createBlockoutBrushNode({
        id: `${groupId}:wall:east`,
        materialId,
        metadata: { ...metadata, blockoutPart: "wall", blockoutSide: "east" },
        name: `${spec.name ?? "Blockout Room"} East Wall`,
        position: vec3(
          spec.position.x + (spec.size.x + wallThickness) * 0.5,
          spec.position.y + spec.size.y * 0.5,
          spec.position.z
        ),
        size: vec3(wallThickness, spec.size.y, outerDepth),
        tags: dedupeTags([...tags, "wall", "east"])
      })
    );
  }

  if (!openSides.has("north")) {
    nodes.push(
      createBlockoutBrushNode({
        id: `${groupId}:wall:north`,
        materialId,
        metadata: { ...metadata, blockoutPart: "wall", blockoutSide: "north" },
        name: `${spec.name ?? "Blockout Room"} North Wall`,
        position: vec3(
          spec.position.x,
          spec.position.y + spec.size.y * 0.5,
          spec.position.z - (spec.size.z + wallThickness) * 0.5
        ),
        size: vec3(spec.size.x, spec.size.y, wallThickness),
        tags: dedupeTags([...tags, "wall", "north"])
      })
    );
  }

  if (!openSides.has("south")) {
    nodes.push(
      createBlockoutBrushNode({
        id: `${groupId}:wall:south`,
        materialId,
        metadata: { ...metadata, blockoutPart: "wall", blockoutSide: "south" },
        name: `${spec.name ?? "Blockout Room"} South Wall`,
        position: vec3(
          spec.position.x,
          spec.position.y + spec.size.y * 0.5,
          spec.position.z + (spec.size.z + wallThickness) * 0.5
        ),
        size: vec3(spec.size.x, spec.size.y, wallThickness),
        tags: dedupeTags([...tags, "wall", "south"])
      })
    );
  }

  return {
    command: createPlaceNodesCommand("place blockout room", nodes),
    groupId,
    nodeIds: nodes.map((node) => node.id)
  };
}

export function createPlaceBlockoutStairCommand(
  scene: SceneDocument,
  spec: BlockoutStairSpec
): {
  command: Command;
  groupId: string;
  nodeIds: string[];
  topLandingCenter: Vec3;
} {
  const direction = spec.direction ?? "north";
  const groupId = createDuplicateNodeId(scene, "group:blockout:stairs");
  const materialId = spec.materialId ?? "material:blockout:orange";
  const landingDepth = Math.max(0.25, spec.landingDepth ?? spec.treadDepth * 1.25);
  const topLandingDepth = Math.max(0.25, spec.topLandingDepth ?? landingDepth);
  const totalRise = spec.stepCount * spec.stepHeight;
  const totalRun = spec.stepCount * spec.treadDepth;
  const tags = dedupeTags(["blockout", "connector", "stairs", ...(spec.tags ?? [])]);
  const metadata = {
    ...(spec.metadata ?? {}),
    blockoutDirection: direction,
    blockoutGroup: groupId,
    blockoutKind: "stairs",
    blockoutRise: totalRise,
    blockoutRun: totalRun,
    blockoutSteps: spec.stepCount
  };
  const forward = resolveDirectionOffset(direction, 1);
  const nodes: BrushNode[] = [
    createDirectionalBrushNode({
      depth: landingDepth,
      id: `${groupId}:landing:lower`,
      materialId,
      metadata: { ...metadata, blockoutPart: "landing-lower" },
      name: `${spec.name ?? "Blockout Stairs"} Lower Landing`,
      position: spec.position,
      rightSpan: spec.width,
      tags: dedupeTags([...tags, "landing", "lower"]),
      verticalSpan: 0.2
    })
  ];

  for (let stepIndex = 1; stepIndex <= spec.stepCount; stepIndex += 1) {
    const height = spec.stepHeight * stepIndex;
    const centerOffset = landingDepth * 0.5 + (totalRun + (stepIndex - 1) * spec.treadDepth) * 0.5;
    const center = addHorizontalOffset(spec.position, direction, centerOffset, height * 0.5);

    nodes.push(
      createDirectionalBrushNode({
        depth: totalRun - (stepIndex - 1) * spec.treadDepth,
        id: `${groupId}:step:${stepIndex}`,
        materialId,
        metadata: { ...metadata, blockoutPart: "step", blockoutStepIndex: stepIndex },
        name: `${spec.name ?? "Blockout Stairs"} Step ${stepIndex}`,
        position: center,
        rightSpan: spec.width,
        tags: dedupeTags([...tags, "step"]),
        verticalSpan: height
      })
    );
  }

  const topLandingCenter = addHorizontalOffset(
    spec.position,
    direction,
    landingDepth * 0.5 + totalRun + topLandingDepth * 0.5,
    totalRise
  );

  nodes.push(
    createDirectionalBrushNode({
      depth: topLandingDepth,
      id: `${groupId}:landing:upper`,
      materialId,
      metadata: { ...metadata, blockoutPart: "landing-upper" },
      name: `${spec.name ?? "Blockout Stairs"} Upper Landing`,
      position: topLandingCenter,
      rightSpan: spec.width,
      tags: dedupeTags([...tags, "landing", "upper"]),
      verticalSpan: 0.2
    })
  );

  if (forward.x !== 0 || forward.z !== 0) {
    nodes.forEach((node) => {
      node.metadata = {
        ...(node.metadata ?? {}),
        blockoutForwardX: forward.x,
        blockoutForwardZ: forward.z
      };
    });
  }

  return {
    command: createPlaceNodesCommand("place blockout stairs", nodes),
    groupId,
    nodeIds: nodes.map((node) => node.id),
    topLandingCenter
  };
}

function createDirectionalBrushNode(input: {
  depth: number;
  id: string;
  materialId: string;
  metadata: Record<string, MetadataValue>;
  name: string;
  position: Vec3;
  rightSpan: number;
  tags: string[];
  verticalSpan: number;
}) {
  const isDepthAlongX = input.metadata.blockoutDirection === "east" || input.metadata.blockoutDirection === "west";

  return createBlockoutBrushNode({
    id: input.id,
    materialId: input.materialId,
    metadata: input.metadata,
    name: input.name,
    position: input.position,
    size: isDepthAlongX
      ? vec3(input.depth, input.verticalSpan, input.rightSpan)
      : vec3(input.rightSpan, input.verticalSpan, input.depth),
    tags: input.tags
  });
}

function createBlockoutBrushNode(input: {
  id: string;
  materialId: string;
  metadata: Record<string, MetadataValue>;
  name: string;
  position: Vec3;
  size: Vec3;
  tags: string[];
}): BrushNode {
  const halfSize = vec3(input.size.x * 0.5, input.size.y * 0.5, input.size.z * 0.5);
  const data = createAxisAlignedBrushFromBounds({
    x: { min: -halfSize.x, max: halfSize.x },
    y: { min: -halfSize.y, max: halfSize.y },
    z: { min: -halfSize.z, max: halfSize.z }
  });

  data.faces = data.planes.map((plane, index) => ({
    id: `${input.id}:face:${index}`,
    materialId: input.materialId,
    plane,
    vertexIds: []
  }));

  return {
    data,
    id: input.id,
    kind: "brush",
    metadata: structuredClone(input.metadata),
    name: input.name,
    tags: [...input.tags],
    transform: makeTransform(structuredClone(input.position))
  };
}

function createPlaceNodesCommand(label: string, nodes: BrushNode[]): Command {
  return {
    label,
    execute(nextScene) {
      nodes.forEach((node) => {
        nextScene.addNode(structuredClone(node));
      });
    },
    undo(nextScene) {
      nodes.forEach((node) => {
        nextScene.removeNode(node.id);
      });
    }
  };
}

function addHorizontalOffset(origin: Vec3, direction: BlockoutDirection, amount: number, yOffset: number) {
  const offset = resolveDirectionOffset(direction, amount);
  return vec3(origin.x + offset.x, origin.y + yOffset, origin.z + offset.z);
}

function resolveDirectionOffset(direction: BlockoutDirection, amount: number) {
  if (direction === "east") {
    return vec3(amount, 0, 0);
  }

  if (direction === "west") {
    return vec3(-amount, 0, 0);
  }

  if (direction === "south") {
    return vec3(0, 0, amount);
  }

  return vec3(0, 0, -amount);
}

function dedupeTags(tags: string[]) {
  return Array.from(new Set(tags));
}
