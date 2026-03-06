import { reconstructBrushFaces, triangulateEditableMesh } from "@web-hammer/geometry-kernel";
import type { GeometryNode, NodeID, Vec3 } from "@web-hammer/shared";
import { isBrushNode, isMeshNode, isModelNode } from "@web-hammer/shared";

export type RenderPrimitive =
  | {
      kind: "box";
      size: Vec3;
    }
  | {
      kind: "icosahedron";
      radius: number;
      detail: number;
    }
  | {
      kind: "cylinder";
      radiusTop: number;
      radiusBottom: number;
      height: number;
      radialSegments: number;
    };

export type RenderMaterial = {
  color: string;
  flatShaded: boolean;
  wireframe: boolean;
};

export type DerivedSurfaceGeometry = {
  positions: number[];
  indices: number[];
};

export type DerivedRenderMesh = {
  nodeId: NodeID;
  sourceKind: GeometryNode["kind"];
  dirty: boolean;
  bvhEnabled: boolean;
  label: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  primitive?: RenderPrimitive;
  surface?: DerivedSurfaceGeometry;
  material: RenderMaterial;
};

export function createDerivedRenderMesh(node: GeometryNode): DerivedRenderMesh {
  const appearance = getRenderAppearance(node);
  const surface = isBrushNode(node)
    ? createBrushSurface(node.data)
    : isMeshNode(node)
      ? createEditableMeshSurface(node.data)
      : undefined;

  return {
    nodeId: node.id,
    sourceKind: node.kind,
    dirty: false,
    bvhEnabled: true,
    label: `${node.name} (${appearance.primitiveLabel})`,
    position: node.transform.position,
    rotation: node.transform.rotation,
    scale: node.transform.scale,
    primitive: isModelNode(node)
      ? {
            kind: "cylinder",
            radiusTop: 0.65,
            radiusBottom: 0.65,
            height: 2.2,
            radialSegments: 12
          }
      : undefined,
    surface,
    material: {
      color: appearance.color,
      flatShaded: appearance.flatShaded,
      wireframe: appearance.wireframe
    }
  };
}

function getRenderAppearance(node: GeometryNode): {
  color: string;
  flatShaded: boolean;
  wireframe: boolean;
  primitiveLabel: string;
} {
  if (isBrushNode(node)) {
    return {
      color: "#f69036",
      flatShaded: true,
      wireframe: false,
      primitiveLabel: "box"
    };
  }

  if (isMeshNode(node)) {
    return {
      color: "#6ed5c0",
      flatShaded: true,
      wireframe: true,
      primitiveLabel: "poly"
    };
  }

  if (isModelNode(node)) {
    return {
      color: "#7f8ea3",
      flatShaded: false,
      wireframe: false,
      primitiveLabel: "model"
    };
  }

  return {
    color: "#ffffff",
    flatShaded: false,
    wireframe: false,
    primitiveLabel: "mesh"
  };
}

function createBrushSurface(node: Extract<GeometryNode, { kind: "brush" }>["data"]): DerivedSurfaceGeometry | undefined {
  const rebuilt = reconstructBrushFaces(node);

  if (!rebuilt.valid || rebuilt.faces.length === 0) {
    return undefined;
  }

  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  rebuilt.faces.forEach((face) => {
    face.vertices.forEach((vertex) => {
      positions.push(vertex.position.x, vertex.position.y, vertex.position.z);
    });

    face.triangleIndices.forEach((index) => {
      indices.push(vertexOffset + index);
    });

    vertexOffset += face.vertices.length;
  });

  return {
    positions,
    indices
  };
}

function createEditableMeshSurface(node: Extract<GeometryNode, { kind: "mesh" }>["data"]): DerivedSurfaceGeometry | undefined {
  const triangulated = triangulateEditableMesh(node);

  if (!triangulated.valid) {
    return undefined;
  }

  return {
    positions: triangulated.positions,
    indices: triangulated.indices
  };
}
