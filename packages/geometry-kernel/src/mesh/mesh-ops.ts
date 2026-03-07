import type { Brush, EditableMesh, FaceID, Vec3, VertexID } from "@web-hammer/shared";
import {
  addVec3,
  averageVec3,
  crossVec3,
  dotVec3,
  normalizeVec3,
  scaleVec3,
  subVec3,
  vec3
} from "@web-hammer/shared";
import { reconstructBrushFaces } from "../brush/brush-kernel";
import { computePolygonNormal } from "../polygon/polygon-utils";
import {
  createEditableMeshFromPolygons,
  getFaceVertexIds,
  getFaceVertices,
  type EditableMeshPolygon
} from "./editable-mesh";

type MeshPolygonData = {
  center: Vec3;
  id: FaceID;
  normal: Vec3;
  positions: Vec3[];
  vertexIds: VertexID[];
};

export type EdgeBevelProfile = "flat" | "round";

export function convertBrushToEditableMesh(brush: Brush): EditableMesh | undefined {
  const rebuilt = reconstructBrushFaces(brush);

  if (!rebuilt.valid) {
    return undefined;
  }

  return createEditableMeshFromPolygons(
    rebuilt.faces.map((face) => ({
      id: face.id,
      positions: face.vertices.map((vertex) => vec3(vertex.position.x, vertex.position.y, vertex.position.z))
    }))
  );
}

export function invertEditableMeshNormals(mesh: EditableMesh, faceIds?: string[]): EditableMesh {
  const selectedFaceIds = faceIds ? new Set(faceIds) : undefined;
  const polygons = getMeshPolygons(mesh).map((polygon) => ({
    id: polygon.id,
    positions:
      !selectedFaceIds || selectedFaceIds.has(polygon.id)
        ? polygon.positions.slice().reverse()
        : polygon.positions.map((position) => vec3(position.x, position.y, position.z))
  }));

  return createEditableMeshFromPolygons(polygons);
}

export function deleteEditableMeshFaces(mesh: EditableMesh, faceIds: string[]): EditableMesh | undefined {
  const selectedFaceIds = new Set(faceIds);
  const polygons = getMeshPolygons(mesh)
    .filter((polygon) => !selectedFaceIds.has(polygon.id))
    .map((polygon) => ({
      id: polygon.id,
      positions: polygon.positions.map((position) => vec3(position.x, position.y, position.z))
    }));

  if (polygons.length === 0) {
    return undefined;
  }

  return createEditableMeshFromPolygons(polygons);
}

export function mergeEditableMeshFaces(mesh: EditableMesh, faceIds: string[], epsilon = 0.0001): EditableMesh | undefined {
  if (faceIds.length < 2) {
    return undefined;
  }

  const polygons = getMeshPolygons(mesh);
  const selectedFaceIds = new Set(faceIds);
  const selected = polygons.filter((polygon) => selectedFaceIds.has(polygon.id));

  if (selected.length < 2) {
    return undefined;
  }

  const baseNormal = normalizeVec3(selected[0].normal);

  if (
    selected.some(
      (polygon) =>
        Math.abs(Math.abs(dotVec3(baseNormal, normalizeVec3(polygon.normal))) - 1) > epsilon * 10
    )
  ) {
    return undefined;
  }

  const boundaryEdges = new Map<
    string,
    {
      count: number;
      endId: VertexID;
      endPosition: Vec3;
      startId: VertexID;
      startPosition: Vec3;
    }
  >();

  selected.forEach((polygon) => {
    polygon.vertexIds.forEach((vertexId, index) => {
      const nextIndex = (index + 1) % polygon.vertexIds.length;
      const nextId = polygon.vertexIds[nextIndex];
      const key = makeUndirectedEdgeKey(vertexId, nextId);
      const existing = boundaryEdges.get(key);

      if (existing) {
        existing.count += 1;
      } else {
        boundaryEdges.set(key, {
          count: 1,
          endId: nextId,
          endPosition: polygon.positions[nextIndex],
          startId: vertexId,
          startPosition: polygon.positions[index]
        });
      }
    });
  });

  const orderedBoundary = orderBoundaryEdges(
    Array.from(boundaryEdges.values()).filter((edge) => edge.count === 1)
  );

  if (!orderedBoundary || orderedBoundary.length < 3) {
    return undefined;
  }

  const mergedPolygon: EditableMeshPolygon & { id: FaceID } = {
    id: selected[0].id,
    positions: orderedBoundary.map((edge) => edge.startPosition)
  };
  const nextPolygons = polygons
    .filter((polygon) => !selectedFaceIds.has(polygon.id))
    .map((polygon) => ({
      id: polygon.id,
      positions: polygon.positions.map((position) => vec3(position.x, position.y, position.z))
    }));

  nextPolygons.push(mergedPolygon);
  return createEditableMeshFromPolygons(nextPolygons);
}

export function cutEditableMeshBetweenEdges(
  mesh: EditableMesh,
  edges: Array<[VertexID, VertexID]>
): EditableMesh | undefined {
  if (edges.length !== 2) {
    return undefined;
  }

  const polygons = getMeshPolygons(mesh);
  const target = polygons.find((polygon) => edges.every((edge) => findEdgeIndex(polygon.vertexIds, edge) >= 0));

  if (!target) {
    return undefined;
  }

  const firstIndex = findEdgeIndex(target.vertexIds, edges[0]);
  const secondIndex = findEdgeIndex(target.vertexIds, edges[1]);

  if (firstIndex < 0 || secondIndex < 0 || areAdjacentEdgeIndices(target.vertexIds.length, firstIndex, secondIndex)) {
    return undefined;
  }

  const firstMidpoint = midpoint(target.positions[firstIndex], target.positions[(firstIndex + 1) % target.positions.length]);
  const secondMidpoint = midpoint(target.positions[secondIndex], target.positions[(secondIndex + 1) % target.positions.length]);

  const expanded = expandPolygonWithInsertedMidpoints(target, [
    { edgeIndex: firstIndex, id: "__cut_a__", position: firstMidpoint },
    { edgeIndex: secondIndex, id: "__cut_b__", position: secondMidpoint }
  ]);
  const cutAIndex = expanded.vertexIds.indexOf("__cut_a__");
  const cutBIndex = expanded.vertexIds.indexOf("__cut_b__");

  if (cutAIndex < 0 || cutBIndex < 0) {
    return undefined;
  }

  const firstPolygon = ringSlice(expanded.positions, cutAIndex, cutBIndex);
  const secondPolygon = ringSlice(expanded.positions, cutBIndex, cutAIndex);

  if (firstPolygon.length < 3 || secondPolygon.length < 3) {
    return undefined;
  }

  const nextPolygons = polygons
    .filter((polygon) => polygon.id !== target.id)
    .map((polygon) => {
      const containsFirstEdge = findEdgeIndex(polygon.vertexIds, edges[0]) >= 0;
      const containsSecondEdge = findEdgeIndex(polygon.vertexIds, edges[1]) >= 0;
      const firstPassPolygon = containsFirstEdge ? getMeshPolygonWithInsertedPoint(polygon, edges[0], firstMidpoint) : polygon;
      const secondPassPolygon = containsSecondEdge
        ? getMeshPolygonWithInsertedPoint(firstPassPolygon, edges[1], secondMidpoint)
        : firstPassPolygon;

      return {
        id: secondPassPolygon.id,
        positions: secondPassPolygon.positions.map((position) => vec3(position.x, position.y, position.z))
      };
    });

  nextPolygons.push(
    { id: `${target.id}:cut:1`, positions: firstPolygon },
    { id: `${target.id}:cut:2`, positions: secondPolygon }
  );

  return createEditableMeshFromPolygons(nextPolygons);
}

export function bevelEditableMeshEdge(
  mesh: EditableMesh,
  edge: [VertexID, VertexID],
  width: number,
  steps: number,
  profile: EdgeBevelProfile = "flat",
  epsilon = 0.0001
): EditableMesh | undefined {
  if (Math.abs(width) <= epsilon) {
    return structuredClone(mesh);
  }

  const polygons = getMeshPolygons(mesh);
  const adjacent = polygons.filter((polygon) => findEdgeIndex(polygon.vertexIds, edge) >= 0);

  if (adjacent.length !== 2) {
    return undefined;
  }

  const [firstFace, secondFace] = adjacent;
  const firstEdgeIndex = findEdgeIndex(firstFace.vertexIds, edge);
  const secondEdgeIndex = findEdgeIndex(secondFace.vertexIds, edge);

  if (firstEdgeIndex < 0 || secondEdgeIndex < 0) {
    return undefined;
  }

  const firstVertex = firstFace.positions[firstEdgeIndex];
  const secondVertex = firstFace.positions[(firstEdgeIndex + 1) % firstFace.positions.length];
  const axis = normalizeVec3(subVec3(secondVertex, firstVertex));
  const edgeCenter = averageVec3([firstVertex, secondVertex]);
  const firstInsetDirection = computeInsetDirection(firstFace, edgeCenter, axis);
  const secondInsetDirection = computeInsetDirection(secondFace, edgeCenter, axis);

  if (!firstInsetDirection || !secondInsetDirection) {
    return undefined;
  }

  const stepCount = Math.max(1, Math.round(steps));
  const signedWidth = width;
  const angle = Math.atan2(
    dotVec3(axis, crossVec3(firstInsetDirection, secondInsetDirection)),
    dotVec3(firstInsetDirection, secondInsetDirection)
  );
  const firstOffset = scaleVec3(firstInsetDirection, signedWidth);
  const secondOffset = scaleVec3(secondInsetDirection, signedWidth);
  const rails =
    profile === "round" && Math.abs(angle) > epsilon
      ? Array.from({ length: stepCount + 2 }, (_, index) => {
          const t = index / (stepCount + 1);
          const direction = rotateAroundAxis(firstInsetDirection, axis, angle * t);
          const offset = scaleVec3(direction, signedWidth);

          return [
            addVec3(firstVertex, offset),
            addVec3(secondVertex, offset)
          ] as const;
        })
      : Array.from({ length: stepCount + 2 }, (_, index) => {
          const t = index / (stepCount + 1);
          const offset = lerpVec3(firstOffset, secondOffset, t);

          return [
            addVec3(firstVertex, offset),
            addVec3(secondVertex, offset)
          ] as const;
        });

  const nextPolygons = polygons
    .filter((polygon) => polygon.id !== firstFace.id && polygon.id !== secondFace.id)
    .map((polygon) => ({
      id: polygon.id,
      positions: polygon.positions.map((position) => vec3(position.x, position.y, position.z)),
      vertexIds: [...polygon.vertexIds]
    }));

  const firstReplacement = replacePolygonEdge(firstFace, edge, rails[0][0], rails[0][1]);
  const secondReplacement = replacePolygonEdge(secondFace, edge, rails[rails.length - 1][0], rails[rails.length - 1][1]);

  if (!firstReplacement || !secondReplacement) {
    return undefined;
  }

  const firstEndpointFaces = nextPolygons.map((polygon) =>
    polygon.vertexIds.includes(edge[0])
      ? replacePolygonVertexWithBevelPoints(
          polygon,
          edge[0],
          firstFace,
          secondFace,
          rails[0][0],
          rails[rails.length - 1][0]
        )
      : polygon
  );
  const nextEndpointFaces = firstEndpointFaces.map((polygon) =>
    polygon.vertexIds.includes(edge[1])
      ? replacePolygonVertexWithBevelPoints(
          polygon,
          edge[1],
          firstFace,
          secondFace,
          rails[0][1],
          rails[rails.length - 1][1]
        )
      : polygon
  );

  const beveledPolygons: Array<{ id: FaceID; positions: Vec3[] }> = [
    ...nextEndpointFaces.map((polygon) => ({
      id: polygon.id,
      positions: polygon.positions
    })),
    firstReplacement,
    secondReplacement
  ];

  for (let index = 0; index < rails.length - 1; index += 1) {
    beveledPolygons.push({
      id: `${firstFace.id}:bevel:${index}`,
      positions: [rails[index][0], rails[index][1], rails[index + 1][1], rails[index + 1][0]]
    });
  }

  return createEditableMeshFromPolygons(orientPolygonLoops(beveledPolygons));
}

export function inflateEditableMesh(mesh: EditableMesh, factor: number): EditableMesh {
  if (Math.abs(factor) <= 0.000001) {
    return structuredClone(mesh);
  }

  const polygons = getMeshPolygons(mesh);
  const normalsByVertexId = new Map<VertexID, Vec3[]>();

  polygons.forEach((polygon) => {
    polygon.vertexIds.forEach((vertexId) => {
      const normals = normalsByVertexId.get(vertexId) ?? [];
      normals.push(polygon.normal);
      normalsByVertexId.set(vertexId, normals);
    });
  });

  return {
    ...structuredClone(mesh),
    vertices: mesh.vertices.map((vertex) => {
      const averagedNormal = normalizeVec3(averageVec3(normalsByVertexId.get(vertex.id) ?? []));

      return {
        ...structuredClone(vertex),
        position: addVec3(vertex.position, scaleVec3(averagedNormal, factor))
      };
    })
  };
}

export function offsetEditableMeshTop(mesh: EditableMesh, amount: number, epsilon = 0.0001): EditableMesh {
  if (Math.abs(amount) <= epsilon) {
    return structuredClone(mesh);
  }

  const maxY = mesh.vertices.reduce((currentMax, vertex) => Math.max(currentMax, vertex.position.y), Number.NEGATIVE_INFINITY);

  return {
    ...structuredClone(mesh),
    vertices: mesh.vertices.map((vertex) => ({
      ...structuredClone(vertex),
      position:
        Math.abs(vertex.position.y - maxY) <= epsilon
          ? vec3(vertex.position.x, vertex.position.y + amount, vertex.position.z)
          : vec3(vertex.position.x, vertex.position.y, vertex.position.z)
    }))
  };
}

function getMeshPolygons(mesh: EditableMesh): MeshPolygonData[] {
  return mesh.faces
    .map((face) => {
      const positions = getFaceVertices(mesh, face.id).map((vertex) => vec3(vertex.position.x, vertex.position.y, vertex.position.z));
      const vertexIds = getFaceVertexIds(mesh, face.id);

      if (positions.length < 3 || vertexIds.length < 3) {
        return undefined;
      }

      return {
        center: averageVec3(positions),
        id: face.id,
        normal: computePolygonNormal(positions),
        positions,
        vertexIds
      };
    })
    .filter((polygon): polygon is MeshPolygonData => Boolean(polygon));
}

function orderBoundaryEdges(
  edges: Array<{
    endId: VertexID;
    endPosition: Vec3;
    startId: VertexID;
    startPosition: Vec3;
  }>
) {
  if (edges.length === 0) {
    return undefined;
  }

  const edgesByStart = new Map(edges.map((edge) => [edge.startId, edge]));
  const ordered = [edges[0]];

  while (ordered.length < edges.length) {
    const current = ordered[ordered.length - 1];
    const next = edgesByStart.get(current.endId);

    if (!next || ordered.includes(next)) {
      return undefined;
    }

    ordered.push(next);
  }

  return ordered[ordered.length - 1].endId === ordered[0].startId ? ordered : undefined;
}

function makeUndirectedEdgeKey(left: VertexID, right: VertexID) {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function findEdgeIndex(vertexIds: VertexID[], edge: [VertexID, VertexID]) {
  return vertexIds.findIndex((vertexId, index) => {
    const nextId = vertexIds[(index + 1) % vertexIds.length];
    return makeUndirectedEdgeKey(vertexId, nextId) === makeUndirectedEdgeKey(edge[0], edge[1]);
  });
}

function areAdjacentEdgeIndices(length: number, left: number, right: number) {
  return Math.abs(left - right) === 1 || Math.abs(left - right) === length - 1;
}

function midpoint(left: Vec3, right: Vec3) {
  return vec3((left.x + right.x) * 0.5, (left.y + right.y) * 0.5, (left.z + right.z) * 0.5);
}

function expandPolygonWithInsertedMidpoints(
  polygon: MeshPolygonData,
  inserted: Array<{ edgeIndex: number; id: string; position: Vec3 }>
) {
  const orderedInserted = inserted.slice().sort((left, right) => left.edgeIndex - right.edgeIndex);
  const vertexIds: VertexID[] = [];
  const positions: Vec3[] = [];

  polygon.vertexIds.forEach((vertexId, index) => {
    vertexIds.push(vertexId);
    positions.push(polygon.positions[index]);

    orderedInserted
      .filter((item) => item.edgeIndex === index)
      .forEach((item) => {
        vertexIds.push(item.id);
        positions.push(item.position);
      });
  });

  return { positions, vertexIds };
}

function ringSlice(points: Vec3[], startIndex: number, endIndex: number) {
  const loop: Vec3[] = [];
  let index = startIndex;

  while (true) {
    loop.push(points[index]);

    if (index === endIndex) {
      break;
    }

    index = (index + 1) % points.length;
  }

  return loop;
}

function computeInsetDirection(face: MeshPolygonData, edgeCenter: Vec3, axis: Vec3) {
  const projected = projectOntoPlane(subVec3(face.center, edgeCenter), axis);
  return normalizeVec3(projected);
}

function projectOntoPlane(vector: Vec3, normal: Vec3) {
  return subVec3(vector, scaleVec3(normal, dotVec3(vector, normal)));
}

function replacePolygonEdge(
  polygon: MeshPolygonData,
  edge: [VertexID, VertexID],
  firstReplacement: Vec3,
  secondReplacement: Vec3
): (EditableMeshPolygon & { id: FaceID }) | undefined {
  const edgeIndex = findEdgeIndex(polygon.vertexIds, edge);

  if (edgeIndex < 0) {
    return undefined;
  }

  const nextIndex = (edgeIndex + 1) % polygon.vertexIds.length;
  const sameOrientation =
    polygon.vertexIds[edgeIndex] === edge[0] && polygon.vertexIds[nextIndex] === edge[1];
  const positions = polygon.positions.map((position) => vec3(position.x, position.y, position.z));

  positions[edgeIndex] = sameOrientation ? firstReplacement : secondReplacement;
  positions[nextIndex] = sameOrientation ? secondReplacement : firstReplacement;

  return {
    id: polygon.id,
    positions
  };
}

function insertPointOnPolygonEdge(
  polygon: MeshPolygonData,
  edge: [VertexID, VertexID],
  insertedPoint: Vec3
): EditableMeshPolygon & { id: FaceID } {
  const edgeIndex = findEdgeIndex(polygon.vertexIds, edge);

  if (edgeIndex < 0) {
    return {
      id: polygon.id,
      positions: polygon.positions.map((position) => vec3(position.x, position.y, position.z))
    };
  }

  const positions = polygon.positions.flatMap((position, index) =>
    index === edgeIndex
      ? [
          vec3(position.x, position.y, position.z),
          vec3(insertedPoint.x, insertedPoint.y, insertedPoint.z)
        ]
      : [vec3(position.x, position.y, position.z)]
  );

  return {
    id: polygon.id,
    positions
  };
}

function replacePolygonVertexWithBevelPoints(
  polygon: MeshPolygonData | (EditableMeshPolygon & { id: FaceID; vertexIds?: VertexID[] }),
  targetVertexId: VertexID,
  firstFace: MeshPolygonData,
  secondFace: MeshPolygonData,
  firstPoint: Vec3,
  secondPoint: Vec3
): EditableMeshPolygon & { id: FaceID; vertexIds: VertexID[] } {
  const vertexIds = "vertexIds" in polygon && polygon.vertexIds ? [...polygon.vertexIds] : [];
  const targetIndex = vertexIds.indexOf(targetVertexId);

  if (targetIndex < 0) {
    return {
      id: polygon.id,
      positions: polygon.positions.map((position) => vec3(position.x, position.y, position.z)),
      vertexIds
    };
  }

  const previousVertexId = vertexIds[(targetIndex - 1 + vertexIds.length) % vertexIds.length];
  const nextVertexId = vertexIds[(targetIndex + 1) % vertexIds.length];
  const previousUsesFirstFace = findEdgeIndex(firstFace.vertexIds, [previousVertexId, targetVertexId]) >= 0;
  const previousUsesSecondFace = findEdgeIndex(secondFace.vertexIds, [previousVertexId, targetVertexId]) >= 0;
  const nextUsesFirstFace = findEdgeIndex(firstFace.vertexIds, [targetVertexId, nextVertexId]) >= 0;
  const nextUsesSecondFace = findEdgeIndex(secondFace.vertexIds, [targetVertexId, nextVertexId]) >= 0;
  const previousReplacement = previousUsesFirstFace ? firstPoint : previousUsesSecondFace ? secondPoint : firstPoint;
  const nextReplacement = nextUsesFirstFace ? firstPoint : nextUsesSecondFace ? secondPoint : secondPoint;
  const positions: Vec3[] = [];
  const nextVertexIds: VertexID[] = [];

  vertexIds.forEach((vertexId, index) => {
    if (index !== targetIndex) {
      positions.push(vec3(polygon.positions[index].x, polygon.positions[index].y, polygon.positions[index].z));
      nextVertexIds.push(vertexId);
      return;
    }

    positions.push(vec3(previousReplacement.x, previousReplacement.y, previousReplacement.z));
    positions.push(vec3(nextReplacement.x, nextReplacement.y, nextReplacement.z));
    nextVertexIds.push(`${targetVertexId}:bevel:start`, `${targetVertexId}:bevel:end`);
  });

  return {
    id: polygon.id,
    positions,
    vertexIds: nextVertexIds
  };
}

function orientPolygonLoops(polygons: Array<{ id: FaceID; positions: Vec3[] }>) {
  const allPoints = polygons.flatMap((polygon) => polygon.positions);

  if (allPoints.length === 0) {
    return polygons;
  }

  const center = averageVec3(allPoints);

  return polygons.map((polygon) => {
    const normal = computePolygonNormal(polygon.positions);
    const polygonCenter = averageVec3(polygon.positions);

    return dotVec3(normal, subVec3(polygonCenter, center)) >= 0
      ? polygon
      : {
          ...polygon,
          positions: polygon.positions.slice().reverse()
        };
  });
}

function getMeshPolygonWithInsertedPoint(
  polygon: MeshPolygonData,
  edge: [VertexID, VertexID],
  insertedPoint: Vec3
): MeshPolygonData {
  const edgeIndex = findEdgeIndex(polygon.vertexIds, edge);

  if (edgeIndex < 0) {
    return polygon;
  }

  const positions: Vec3[] = [];
  const vertexIds: VertexID[] = [];

  polygon.vertexIds.forEach((vertexId, index) => {
    vertexIds.push(vertexId);
    positions.push(polygon.positions[index]);

    if (index === edgeIndex) {
      vertexIds.push(`inserted:${polygon.id}:${index}`);
      positions.push(insertedPoint);
    }
  });

  return {
    ...polygon,
    positions,
    vertexIds
  };
}

function rotateAroundAxis(vector: Vec3, axis: Vec3, angle: number): Vec3 {
  const normalizedAxis = normalizeVec3(axis);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);

  return addVec3(
    addVec3(scaleVec3(vector, cosine), scaleVec3(crossVec3(normalizedAxis, vector), sine)),
    scaleVec3(normalizedAxis, dotVec3(normalizedAxis, vector) * (1 - cosine))
  );
}

function lerpVec3(left: Vec3, right: Vec3, t: number): Vec3 {
  return vec3(
    left.x + (right.x - left.x) * t,
    left.y + (right.y - left.y) * t,
    left.z + (right.z - left.z) * t
  );
}
