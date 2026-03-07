import {
  computePolygonNormal,
  getFaceVertexIds,
  getFaceVertices,
  reconstructBrushFaces,
  sortVerticesOnPlane,
  type ReconstructedBrushFace
} from "@web-hammer/geometry-kernel";
import type { BrushAxis } from "@web-hammer/geometry-kernel";
import type { Brush, EditableMesh, Face, Plane, Transform, Vec3 } from "@web-hammer/shared";
import { addVec3, averageVec3, dotVec3, normalizeVec3, scaleVec3, snapValue, vec3 } from "@web-hammer/shared";
import { Euler, Quaternion, Vector3 } from "three";
import { ConvexHull } from "three/examples/jsm/math/ConvexHull.js";

export type MeshEditMode = "edge" | "face" | "vertex";

export type ClipPreview = {
  axis: BrushAxis;
  coordinate: number;
  end: Vec3;
  start: Vec3;
};

export type MeshEditHandle = {
  id: string;
  normal?: Vec3;
  position: Vec3;
  points?: Vec3[];
  vertexIds: string[];
};

export type BrushEditHandle = {
  faceIds: string[];
  id: string;
  normal?: Vec3;
  position: Vec3;
  points?: Vec3[];
  vertexIds: string[];
};

export type BrushExtrudeHandle = BrushEditHandle & {
  kind: "edge" | "face";
};

export type MeshExtrudeHandle = MeshEditHandle & {
  kind: "edge" | "face";
  normal: Vec3;
};

type AxisKey = "x" | "y" | "z";

type BrushFaceAxis = {
  axis: BrushAxis;
  side: "max" | "min";
};

const ZERO_VECTOR = vec3(0, 0, 0);

export function resolveBrushFaceAxis(face: ReconstructedBrushFace): BrushFaceAxis | undefined {
  const normalAxis = getDominantAxis(face.normal);

  if (!normalAxis) {
    return undefined;
  }

  return {
    axis: normalAxis,
    side: face.normal[normalAxis] >= 0 ? "max" : "min"
  };
}

export function buildClipPreview(
  face: ReconstructedBrushFace,
  localPoint: Vec3,
  snapSize: number,
  epsilon = 0.0001
): ClipPreview | undefined {
  const planeAxes = getPlaneAxes(face.normal);

  if (!planeAxes) {
    return undefined;
  }

  const bounds = getFaceBounds(face);
  const firstDelta = Math.abs(localPoint[planeAxes.first] - face.center[planeAxes.first]);
  const secondDelta = Math.abs(localPoint[planeAxes.second] - face.center[planeAxes.second]);
  const axis = firstDelta >= secondDelta ? planeAxes.first : planeAxes.second;
  const lineAxis = axis === planeAxes.first ? planeAxes.second : planeAxes.first;
  const coordinate = snapValue(localPoint[axis], snapSize);

  if (coordinate <= bounds[axis].min + epsilon || coordinate >= bounds[axis].max - epsilon) {
    return undefined;
  }

  return {
    axis,
    coordinate,
    start: vec3ForAxis(face.center, axis, coordinate, lineAxis, bounds[lineAxis].min),
    end: vec3ForAxis(face.center, axis, coordinate, lineAxis, bounds[lineAxis].max)
  };
}

export function createMeshEditHandles(mesh: EditableMesh, mode: MeshEditMode): MeshEditHandle[] {
  if (mode === "vertex") {
    return mesh.vertices.map((vertex) => ({
      id: vertex.id,
      points: [vec3(vertex.position.x, vertex.position.y, vertex.position.z)],
      position: vec3(vertex.position.x, vertex.position.y, vertex.position.z),
      vertexIds: [vertex.id]
    }));
  }

  if (mode === "face") {
    const handles: MeshEditHandle[] = [];

    mesh.faces.forEach((face) => {
      const vertices = getFaceVertices(mesh, face.id);

      if (vertices.length === 0) {
        return;
      }

      handles.push({
        id: face.id,
        normal: computePolygonNormal(vertices.map((vertex) => vertex.position)),
        points: vertices.map((vertex) => vec3(vertex.position.x, vertex.position.y, vertex.position.z)),
        position: averageVec3(vertices.map((vertex) => vertex.position)),
        vertexIds: vertices.map((vertex) => vertex.id)
      });
    });

    return handles;
  }

  const verticesById = new Map(mesh.vertices.map((vertex) => [vertex.id, vertex]));
  const handles = new Map<string, MeshEditHandle>();

  mesh.halfEdges.forEach((halfEdge) => {
    if (!halfEdge.next) {
      return;
    }

    const nextHalfEdge = mesh.halfEdges.find((candidate) => candidate.id === halfEdge.next);

    if (!nextHalfEdge) {
      return;
    }

    const ids = [halfEdge.vertex, nextHalfEdge.vertex].sort();
    const key = ids.join(":");

    if (handles.has(key)) {
      return;
    }

    const first = verticesById.get(ids[0]);
    const second = verticesById.get(ids[1]);

    if (!first || !second) {
      return;
    }

    handles.set(key, {
      id: key,
      points: [vec3(first.position.x, first.position.y, first.position.z), vec3(second.position.x, second.position.y, second.position.z)],
      position: averageVec3([first.position, second.position]),
      vertexIds: ids
    });
  });

  return Array.from(handles.values());
}

export function computeMeshEditSelectionCenter(
  handles: MeshEditHandle[],
  selectedIds: string[]
): Vec3 {
  const positions = handles
    .filter((handle) => selectedIds.includes(handle.id))
    .map((handle) => handle.position);

  if (positions.length === 0) {
    return ZERO_VECTOR;
  }

  return averageVec3(positions);
}

export function applyMeshEditTransform(
  mesh: EditableMesh,
  mode: MeshEditMode,
  selectedIds: string[],
  baselineTransform: Transform,
  currentTransform: Transform
): EditableMesh {
  const affectedVertexIds = new Set(expandMeshEditSelection(mesh, mode, selectedIds));

  if (affectedVertexIds.size === 0) {
    return structuredClone(mesh);
  }

  const center = toVector3(baselineTransform.position);
  const translationDelta = toVector3(currentTransform.position).sub(toVector3(baselineTransform.position));
  const baselineQuaternion = new Quaternion().setFromEuler(
    new Euler(
      baselineTransform.rotation.x,
      baselineTransform.rotation.y,
      baselineTransform.rotation.z,
      "XYZ"
    )
  );
  const currentQuaternion = new Quaternion().setFromEuler(
    new Euler(currentTransform.rotation.x, currentTransform.rotation.y, currentTransform.rotation.z, "XYZ")
  );
  const rotationDelta = currentQuaternion.multiply(baselineQuaternion.invert());
  const scaleFactor = new Vector3(
    safeDivide(currentTransform.scale.x, baselineTransform.scale.x),
    safeDivide(currentTransform.scale.y, baselineTransform.scale.y),
    safeDivide(currentTransform.scale.z, baselineTransform.scale.z)
  );

  return {
    ...structuredClone(mesh),
    vertices: mesh.vertices.map((vertex) => {
      if (!affectedVertexIds.has(vertex.id)) {
        return structuredClone(vertex);
      }

      const nextPosition = toVector3(vertex.position)
        .sub(center)
        .multiply(scaleFactor)
        .applyQuaternion(rotationDelta)
        .add(center)
        .add(translationDelta);

      return {
        ...structuredClone(vertex),
        position: vec3(nextPosition.x, nextPosition.y, nextPosition.z)
      };
    })
  };
}

export function createBrushEditHandles(brush: Brush, mode: MeshEditMode): BrushEditHandle[] {
  const rebuilt = reconstructBrushFaces(brush);

  if (!rebuilt.valid) {
    return [];
  }

  const topology = buildBrushTopology(rebuilt);

  if (mode === "face") {
    return rebuilt.faces.map((face) => {
      const faceTopology = topology.faces.get(face.id);

      return {
      faceIds: [face.id],
      id: face.id,
      normal: vec3(face.normal.x, face.normal.y, face.normal.z),
      points: face.vertices.map((vertex) => vec3(vertex.position.x, vertex.position.y, vertex.position.z)),
      position: vec3(face.center.x, face.center.y, face.center.z),
      vertexIds: faceTopology ? [...faceTopology.vertexIds] : [...face.vertexIds]
    };
    });
  }

  if (mode === "edge") {
    const edges = new Map<string, BrushEditHandle>();

    rebuilt.faces.forEach((face) => {
      const faceTopology = topology.faces.get(face.id);

      if (!faceTopology) {
        return;
      }

      face.vertices.forEach((vertex, index) => {
        const nextVertex = face.vertices[(index + 1) % face.vertices.length];
        const currentStableVertexId = faceTopology.vertexIds[index];
        const nextStableVertexId = faceTopology.vertexIds[(index + 1) % faceTopology.vertexIds.length];
        const vertexIds = [currentStableVertexId, nextStableVertexId].sort();
        const key = vertexIds.join(":");
        const existing = edges.get(key);

        if (existing) {
          existing.faceIds = Array.from(new Set([...existing.faceIds, face.id]));
          return;
        }

        edges.set(key, {
          faceIds: [face.id],
          id: `edge:${key}`,
          points: [
            vec3(vertex.position.x, vertex.position.y, vertex.position.z),
            vec3(nextVertex.position.x, nextVertex.position.y, nextVertex.position.z)
          ],
          position: averageVec3([vertex.position, nextVertex.position]),
          vertexIds
        });
      });
    });

    return Array.from(edges.values());
  }

  return Array.from(topology.vertices.values()).map((vertex) => ({
    faceIds: [...vertex.faceIds],
    id: vertex.id,
    points: [vec3(vertex.position.x, vertex.position.y, vertex.position.z)],
    position: vec3(vertex.position.x, vertex.position.y, vertex.position.z),
    vertexIds: [vertex.id]
  }));
}

export function createBrushExtrudeHandles(brush: Brush): BrushExtrudeHandle[] {
  const rebuilt = reconstructBrushFaces(brush);

  if (!rebuilt.valid) {
    return [];
  }

  const faceHandles = createBrushEditHandles(brush, "face").map((handle) => ({
    ...handle,
    kind: "face" as const
  }));
  const edgeHandles = createBrushEditHandles(brush, "edge")
    .map((handle) => ({
      ...handle,
      kind: "edge" as const,
      normal: computeBrushExtrusionNormal(rebuilt.faces, handle.faceIds)
    }))
    .filter((handle) => Boolean(handle.normal));

  return [...faceHandles, ...edgeHandles];
}

export function createMeshExtrudeHandles(mesh: EditableMesh): MeshExtrudeHandle[] {
  const faceHandles = createMeshEditHandles(mesh, "face").filter(
    (handle): handle is MeshEditHandle & { normal: Vec3 } => Boolean(handle.normal)
  );
  const faceExtrudeHandles: MeshExtrudeHandle[] = faceHandles.map((handle) => ({
    ...handle,
    kind: "face" as const,
    normal: handle.normal
  }));
  const edgeNormals = new Map<string, Vec3[]>();

  faceHandles.forEach((handle) => {
    handle.vertexIds.forEach((vertexId, index) => {
      const nextVertexId = handle.vertexIds[(index + 1) % handle.vertexIds.length];
      const key = makeMeshEdgeKey(vertexId, nextVertexId);
      const normals = edgeNormals.get(key) ?? [];

      normals.push(handle.normal);
      edgeNormals.set(key, normals);
    });
  });

  const edgeHandles = createMeshEditHandles(mesh, "edge").flatMap((handle) => {
    const normals = edgeNormals.get(handle.id);

    // Valid edge extrusion supports manifold edges with one or two incident faces.
    if (!normals || normals.length === 0 || normals.length > 2) {
      return [];
    }

    return [
      {
        ...handle,
        kind: "edge" as const,
        normal: normalizeVec3(averageVec3(normals))
      }
    ];
  });

  return [...faceExtrudeHandles, ...edgeHandles];
}

export function collectMeshEdgeLoop(mesh: EditableMesh, edge: [string, string]) {
  const facesById = new Map(mesh.faces.map((face) => [face.id, getFaceVertexIds(mesh, face.id)]));
  const visited = new Set<string>();
  const loop: Array<[string, string]> = [];
  const adjacentFaces = Array.from(facesById.entries())
    .filter(([, vertexIds]) => findLoopEdgeIndex(vertexIds, edge) >= 0)
    .map(([faceId]) => faceId);

  const visitEdge = (candidate: [string, string]) => {
    const key = makeMeshEdgeKey(candidate[0], candidate[1]);

    if (visited.has(key)) {
      return false;
    }

    visited.add(key);
    loop.push(candidate[0] < candidate[1] ? candidate : [candidate[1], candidate[0]]);
    return true;
  };

  const traverse = (faceId: string, incomingEdge: [string, string]) => {
    const vertexIds = facesById.get(faceId);

    if (!vertexIds || vertexIds.length < 4 || vertexIds.length % 2 !== 0) {
      return;
    }

    const edgeIndex = findLoopEdgeIndex(vertexIds, incomingEdge);

    if (edgeIndex < 0) {
      return;
    }

    const oppositeIndex = (edgeIndex + vertexIds.length / 2) % vertexIds.length;
    const oppositeEdge: [string, string] = [
      vertexIds[oppositeIndex],
      vertexIds[(oppositeIndex + 1) % vertexIds.length]
    ];

    if (!visitEdge(oppositeEdge)) {
      return;
    }

    const nextFaceId = Array.from(facesById.entries()).find(
      ([candidateFaceId, candidateVertexIds]) =>
        candidateFaceId !== faceId && findLoopEdgeIndex(candidateVertexIds, oppositeEdge) >= 0
    )?.[0];

    if (nextFaceId) {
      traverse(nextFaceId, oppositeEdge);
    }
  };

  visitEdge(edge);
  adjacentFaces.forEach((faceId) => {
    traverse(faceId, edge);
  });

  return loop;
}

export function extrudeBrushHandle(
  brush: Brush,
  handle: BrushExtrudeHandle,
  amount: number,
  overrideNormal?: Vec3,
  epsilon = 0.0001
): Brush | undefined {
  if (amount <= epsilon) {
    return structuredClone(brush);
  }

  const rebuilt = reconstructBrushFaces(brush);

  if (!rebuilt.valid) {
    return undefined;
  }

  const topology = buildBrushTopology(rebuilt);
  const extrusionNormal = overrideNormal ?? handle.normal ?? computeBrushExtrusionNormal(rebuilt.faces, handle.faceIds);

  if (!extrusionNormal) {
    return undefined;
  }

  const extrudedPoints = handle.vertexIds
    .map((vertexId) => topology.vertices.get(vertexId))
    .filter((vertex): vertex is { faceIds: string[]; id: string; position: Vec3 } => Boolean(vertex))
    .map((vertex) => addVec3(vertex.position, scaleVec3(extrusionNormal, amount)));

  if (extrudedPoints.length === 0) {
    return undefined;
  }

  return rebuildBrushFromPoints(
    brush,
    rebuilt.faces,
    [...Array.from(topology.vertices.values(), (vertex) => vertex.position), ...extrudedPoints],
    epsilon
  );
}

export function computeBrushEditSelectionCenter(handles: BrushEditHandle[], selectedIds: string[]): Vec3 {
  const positions = handles
    .filter((handle) => selectedIds.includes(handle.id))
    .map((handle) => handle.position);

  return positions.length > 0 ? averageVec3(positions) : ZERO_VECTOR;
}

export function applyBrushEditTransform(
  brush: Brush,
  handles: BrushEditHandle[],
  selectedIds: string[],
  baselineTransform: Transform,
  currentTransform: Transform,
  snapSize: number,
  epsilon = 0.0001
): Brush | undefined {
  const rebuilt = reconstructBrushFaces(brush);

  if (!rebuilt.valid) {
    return undefined;
  }

  const topology = buildBrushTopology(rebuilt);

  const selectedHandles = handles.filter((handle) => selectedIds.includes(handle.id));

  if (selectedHandles.length === 0) {
    return structuredClone(brush);
  }

  const center = toVector3(baselineTransform.position);
  const translationDelta = toVector3(currentTransform.position).sub(toVector3(baselineTransform.position));
  const baselineQuaternion = new Quaternion().setFromEuler(
    new Euler(
      baselineTransform.rotation.x,
      baselineTransform.rotation.y,
      baselineTransform.rotation.z,
      "XYZ"
    )
  );
  const currentQuaternion = new Quaternion().setFromEuler(
    new Euler(currentTransform.rotation.x, currentTransform.rotation.y, currentTransform.rotation.z, "XYZ")
  );
  const rotationDelta = currentQuaternion.multiply(baselineQuaternion.invert());
  const scaleFactor = new Vector3(
    safeDivide(currentTransform.scale.x, baselineTransform.scale.x),
    safeDivide(currentTransform.scale.y, baselineTransform.scale.y),
    safeDivide(currentTransform.scale.z, baselineTransform.scale.z)
  );
  const selectedVertexIds = new Set(selectedHandles.flatMap((handle) => handle.vertexIds));
  const transformedVertices = new Map<string, Vec3>();

  topology.vertices.forEach((vertex) => {
    if (!selectedVertexIds.has(vertex.id)) {
      transformedVertices.set(vertex.id, vec3(vertex.position.x, vertex.position.y, vertex.position.z));
      return;
    }

    const transformed = toVector3(vertex.position)
      .sub(center)
      .multiply(scaleFactor)
      .applyQuaternion(rotationDelta)
      .add(center)
      .add(translationDelta);

    transformedVertices.set(
      vertex.id,
      vec3(transformed.x, transformed.y, transformed.z)
    );
  });

  return rebuildBrushFromVertices(brush, rebuilt.faces, transformedVertices, epsilon);
}

function expandMeshEditSelection(mesh: EditableMesh, mode: MeshEditMode, selectedIds: string[]): string[] {
  if (mode === "vertex") {
    return selectedIds;
  }

  if (mode === "face") {
    const vertexIds = new Set<string>();

    selectedIds.forEach((faceId) => {
      getFaceVertices(mesh, faceId).forEach((vertex) => {
        vertexIds.add(vertex.id);
      });
    });

    return Array.from(vertexIds);
  }

  const handles = createMeshEditHandles(mesh, "edge");
  const vertexIds = new Set<string>();

  selectedIds.forEach((handleId) => {
    const handle = handles.find((candidate) => candidate.id === handleId);
    handle?.vertexIds.forEach((vertexId) => {
      vertexIds.add(vertexId);
    });
  });

  return Array.from(vertexIds);
}

function getDominantAxis(vector: Vec3): AxisKey | undefined {
  const axisEntries = [
    ["x", Math.abs(vector.x)],
    ["y", Math.abs(vector.y)],
    ["z", Math.abs(vector.z)]
  ] as const;
  const [axis, magnitude] = axisEntries.reduce((current, candidate) =>
    candidate[1] > current[1] ? candidate : current
  );

  return magnitude > 0 ? axis : undefined;
}

function getPlaneAxes(normal: Vec3): { first: BrushAxis; second: BrushAxis } | undefined {
  const normalAxis = getDominantAxis(normal);

  if (!normalAxis) {
    return undefined;
  }

  const axes = (["x", "y", "z"] as const).filter((axis) => axis !== normalAxis);
  return {
    first: axes[0],
    second: axes[1]
  };
}

function getFaceBounds(face: ReconstructedBrushFace) {
  const bounds = {
    x: { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
    y: { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
    z: { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY }
  };

  face.vertices.forEach((vertex) => {
    bounds.x.min = Math.min(bounds.x.min, vertex.position.x);
    bounds.x.max = Math.max(bounds.x.max, vertex.position.x);
    bounds.y.min = Math.min(bounds.y.min, vertex.position.y);
    bounds.y.max = Math.max(bounds.y.max, vertex.position.y);
    bounds.z.min = Math.min(bounds.z.min, vertex.position.z);
    bounds.z.max = Math.max(bounds.z.max, vertex.position.z);
  });

  return bounds;
}

function safeDivide(value: number, divisor: number): number {
  return Math.abs(divisor) <= 0.0001 ? 1 : value / divisor;
}

function toVector3(value: Vec3): Vector3 {
  return new Vector3(value.x, value.y, value.z);
}

function vec3ForAxis(
  seed: Vec3,
  coordinateAxis: AxisKey,
  coordinateValue: number,
  lineAxis: AxisKey,
  lineValue: number
): Vec3 {
  return vec3(
    coordinateAxis === "x" ? coordinateValue : lineAxis === "x" ? lineValue : seed.x,
    coordinateAxis === "y" ? coordinateValue : lineAxis === "y" ? lineValue : seed.y,
    coordinateAxis === "z" ? coordinateValue : lineAxis === "z" ? lineValue : seed.z
  );
}

function buildBrushTopology(rebuilt: ReturnType<typeof reconstructBrushFaces>) {
  const vertices = new Map<
    string,
    {
      faceIds: string[];
      id: string;
      position: Vec3;
    }
  >();
  const faces = new Map<
    string,
    {
      vertexIds: string[];
    }
  >();

  rebuilt.faces.forEach((face) => {
    const stableVertexIds = face.vertices.map((vertex) => {
      const incidentFaceIds = rebuilt.faces
        .filter((candidateFace) => candidateFace.vertexIds.includes(vertex.id))
        .map((candidateFace) => candidateFace.id)
        .sort();
      const stableVertexId = `vertex:${incidentFaceIds.join("|")}`;
      const existing = vertices.get(stableVertexId);

      if (existing) {
        existing.faceIds = Array.from(new Set([...existing.faceIds, ...incidentFaceIds]));
      } else {
        vertices.set(stableVertexId, {
          faceIds: incidentFaceIds,
          id: stableVertexId,
          position: vec3(vertex.position.x, vertex.position.y, vertex.position.z)
        });
      }

      return stableVertexId;
    });

    faces.set(face.id, {
      vertexIds: stableVertexIds
    });
  });

  return {
    faces,
    vertices
  };
}

function rebuildBrushFromVertices(
  brush: Brush,
  sourceFaces: ReconstructedBrushFace[],
  transformedVertices: Map<string, Vec3>,
  epsilon: number
): Brush | undefined {
  return rebuildBrushFromPoints(brush, sourceFaces, Array.from(transformedVertices.values()), epsilon);
}

function rebuildBrushFromPoints(
  brush: Brush,
  sourceFaces: ReconstructedBrushFace[],
  points: Vec3[],
  epsilon: number
): Brush | undefined {
  const hullPoints = dedupePoints(points, epsilon * 8);

  if (hullPoints.length < 4) {
    return undefined;
  }

  const hull = new ConvexHull().setFromPoints(hullPoints.map(toVector3));

  if (hull.faces.length < 4) {
    return undefined;
  }

  const planeGroups = collectHullPlaneGroups(hull, epsilon);

  if (planeGroups.length < 4) {
    return undefined;
  }

  const nextPlanes: Plane[] = [];
  const nextFaces: Face[] = [];
  const usedFaceIds = new Set<string>();

  planeGroups.forEach((group, index) => {
    const orderedPoints = sortVerticesOnPlane(dedupePoints(group.points, epsilon * 8), group.normal);

    if (orderedPoints.length < 3) {
      return;
    }

    let normal = normalizeVec3(computePolygonNormal(orderedPoints));

    if (dotVec3(normal, group.normal) < 0) {
      normal = scaleVec3(normal, -1);
    }

    const distance = dotVec3(normal, orderedPoints[0]);
    const plane = { distance, normal };
    const metadataFace = findBestMatchingBrushFace(sourceFaces, plane);
    const identityFace = findIdentityBrushFace(sourceFaces, plane, epsilon);
    const faceId = createBrushFaceId(usedFaceIds, identityFace?.id ?? `face:brush:${index}`);

    nextPlanes.push(plane);
    nextFaces.push({
      id: faceId,
      materialId: metadataFace?.materialId ?? brush.faces[0]?.materialId,
      plane,
      vertexIds: orderedPoints.map((_, vertexIndex) => `${faceId}:vertex:${vertexIndex}`)
    });
  });

  if (nextPlanes.length < 4 || nextFaces.length < 4) {
    return undefined;
  }

  const nextBrush: Brush = {
    ...structuredClone(brush),
    faces: nextFaces,
    planes: nextPlanes
  };

  const nextRebuilt = reconstructBrushFaces(nextBrush, epsilon);
  return nextRebuilt.valid ? nextBrush : undefined;
}

function computeBrushExtrusionNormal(faces: ReconstructedBrushFace[], faceIds: string[]): Vec3 | undefined {
  const normals = faces.filter((face) => faceIds.includes(face.id)).map((face) => face.normal);

  if (normals.length === 0) {
    return undefined;
  }

  return normalizeVec3(averageVec3(normals));
}

function makeMeshEdgeKey(left: string, right: string) {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function findLoopEdgeIndex(vertexIds: string[], edge: [string, string]) {
  return vertexIds.findIndex((vertexId, index) => {
    const nextVertexId = vertexIds[(index + 1) % vertexIds.length];
    return makeMeshEdgeKey(vertexId, nextVertexId) === makeMeshEdgeKey(edge[0], edge[1]);
  });
}

function collectHullPlaneGroups(hull: ConvexHull, epsilon: number) {
  const groups: Array<{
    distance: number;
    normal: Vec3;
    points: Vec3[];
  }> = [];

  hull.faces.forEach((face) => {
    const normal = normalizeVec3(vec3(face.normal.x, face.normal.y, face.normal.z));
    const distance = face.constant;
    const points = getHullFacePoints(face);

    if (points.length < 3) {
      return;
    }

    const existing = groups.find((group) => areCoplanarPlanes(group.normal, group.distance, normal, distance, epsilon));

    if (existing) {
      existing.points.push(...points);
      return;
    }

    groups.push({
      distance,
      normal,
      points
    });
  });

  return groups;
}

function getHullFacePoints(face: { edge: { next: unknown; tail(): { point: Vector3 } | null } | null }): Vec3[] {
  if (!face.edge) {
    return [];
  }

  const points: Vec3[] = [];
  const start = face.edge;
  let edge = face.edge;

  do {
    const tail = edge.tail();

    if (tail) {
      points.push(vec3(tail.point.x, tail.point.y, tail.point.z));
    }

    edge = edge.next as typeof start;
  } while (edge && edge !== start);

  return points;
}

function areCoplanarPlanes(
  leftNormal: Vec3,
  leftDistance: number,
  rightNormal: Vec3,
  rightDistance: number,
  epsilon: number
) {
  const normalDelta = 1 - dotVec3(leftNormal, rightNormal);
  const distanceDelta = Math.abs(leftDistance - rightDistance);

  return normalDelta <= 0.001 && distanceDelta <= Math.max(epsilon * 64, 0.01);
}

function dedupePoints(points: Vec3[], epsilon: number): Vec3[] {
  const registry = new Map<string, Vec3>();

  points.forEach((point) => {
    registry.set(
      [
        Math.round(point.x / epsilon),
        Math.round(point.y / epsilon),
        Math.round(point.z / epsilon)
      ].join(":"),
      vec3(point.x, point.y, point.z)
    );
  });

  return Array.from(registry.values());
}

function findBestMatchingBrushFace(faces: ReconstructedBrushFace[], plane: Plane) {
  let bestMatch: ReconstructedBrushFace | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  faces.forEach((face) => {
    const alignment = dotVec3(plane.normal, face.normal);

    if (alignment <= 0) {
      return;
    }

    const distanceDelta = Math.abs(plane.distance - face.plane.distance);
    const score = alignment * 100 - distanceDelta;

    if (score > bestScore) {
      bestMatch = face;
      bestScore = score;
    }
  });

  return bestMatch;
}

function findIdentityBrushFace(faces: ReconstructedBrushFace[], plane: Plane, epsilon: number) {
  return faces.find((face) =>
    dotVec3(plane.normal, face.normal) >= 0.999 &&
    Math.abs(plane.distance - face.plane.distance) <= Math.max(epsilon * 64, 0.01)
  );
}

function createBrushFaceId(usedFaceIds: Set<string>, preferredId: string) {
  if (!usedFaceIds.has(preferredId)) {
    usedFaceIds.add(preferredId);
    return preferredId;
  }

  let suffix = 1;
  let candidate = `${preferredId}:${suffix}`;

  while (usedFaceIds.has(candidate)) {
    suffix += 1;
    candidate = `${preferredId}:${suffix}`;
  }

  usedFaceIds.add(candidate);
  return candidate;
}
