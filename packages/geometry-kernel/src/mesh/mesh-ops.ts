import type { Brush, EditableMesh, FaceID, Vec3, VertexID } from "@web-hammer/shared";
import {
  addVec3,
  averageVec3,
  crossVec3,
  dotVec3,
  normalizeVec3,
  snapValue,
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

type OrientedEditablePolygon = {
  id: FaceID;
  positions: Vec3[];
  expectedNormal?: Vec3;
  vertexIds?: VertexID[];
};

type FacePlanePoint = {
  u: number;
  v: number;
};

type ResolvedFaceCut = {
  end: Vec3;
  firstEdge: [VertexID, VertexID];
  firstEdgeIndex: number;
  firstPoint: Vec3;
  secondEdge: [VertexID, VertexID];
  secondEdgeIndex: number;
  secondPoint: Vec3;
  start: Vec3;
  target: MeshPolygonData;
};

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

export function buildEditableMeshFaceCutPreview(
  mesh: EditableMesh,
  faceId: FaceID,
  point: Vec3,
  snapSize: number,
  epsilon = 0.0001
): { end: Vec3; start: Vec3 } | undefined {
  const resolvedCut = resolveEditableMeshFaceCut(mesh, faceId, point, snapSize, epsilon);

  if (!resolvedCut) {
    return undefined;
  }

  return {
    end: resolvedCut.end,
    start: resolvedCut.start
  };
}

export function cutEditableMeshFace(
  mesh: EditableMesh,
  faceId: FaceID,
  point: Vec3,
  snapSize: number,
  epsilon = 0.0001
): EditableMesh | undefined {
  const resolvedCut = resolveEditableMeshFaceCut(mesh, faceId, point, snapSize, epsilon);

  if (!resolvedCut) {
    return undefined;
  }

  const expanded = expandPolygonWithInsertedMidpoints(resolvedCut.target, [
    {
      edgeIndex: resolvedCut.firstEdgeIndex,
      id: "__cut_a__",
      position: resolvedCut.firstPoint
    },
    {
      edgeIndex: resolvedCut.secondEdgeIndex,
      id: "__cut_b__",
      position: resolvedCut.secondPoint
    }
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

  const nextPolygons: OrientedEditablePolygon[] = getMeshPolygons(mesh)
    .filter((polygon) => polygon.id !== resolvedCut.target.id)
    .map((polygon) => {
      const containsFirstEdge = findEdgeIndex(polygon.vertexIds, resolvedCut.firstEdge) >= 0;
      const containsSecondEdge = findEdgeIndex(polygon.vertexIds, resolvedCut.secondEdge) >= 0;
      const firstPassPolygon = containsFirstEdge
        ? getMeshPolygonWithInsertedPoint(polygon, resolvedCut.firstEdge, resolvedCut.firstPoint)
        : polygon;
      const secondPassPolygon = containsSecondEdge
        ? getMeshPolygonWithInsertedPoint(firstPassPolygon, resolvedCut.secondEdge, resolvedCut.secondPoint)
        : firstPassPolygon;

      return {
        expectedNormal: polygon.normal,
        id: secondPassPolygon.id,
        positions: secondPassPolygon.positions.map((position) => vec3(position.x, position.y, position.z))
      };
    });

  nextPolygons.push(
    {
      expectedNormal: resolvedCut.target.normal,
      id: `${resolvedCut.target.id}:cut:1`,
      positions: firstPolygon
    },
    {
      expectedNormal: resolvedCut.target.normal,
      id: `${resolvedCut.target.id}:cut:2`,
      positions: secondPolygon
    }
  );

  return createEditableMeshFromPolygons(orientPolygonLoops(nextPolygons));
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

  const orientedEdgeStartId = firstFace.vertexIds[firstEdgeIndex];
  const orientedEdgeEndId = firstFace.vertexIds[(firstEdgeIndex + 1) % firstFace.vertexIds.length];
  const firstFaceOrientedEdge: [VertexID, VertexID] = [
    orientedEdgeStartId,
    orientedEdgeEndId
  ];
  const secondFaceOrientedEdge: [VertexID, VertexID] = [
    secondFace.vertexIds[secondEdgeIndex],
    secondFace.vertexIds[(secondEdgeIndex + 1) % secondFace.vertexIds.length]
  ];
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
  const railCount = stepCount + 1;
  const rails =
    profile === "round" && Math.abs(angle) > epsilon
      ? Array.from({ length: railCount }, (_, index) => {
          const t = railCount === 1 ? 0 : index / (railCount - 1);
          const direction = rotateAroundAxis(firstInsetDirection, axis, angle * t);
          const offset = scaleVec3(direction, signedWidth);

          return [
            addVec3(firstVertex, offset),
            addVec3(secondVertex, offset)
          ] as const;
        })
      : Array.from({ length: railCount }, (_, index) => {
          const t = railCount === 1 ? 0 : index / (railCount - 1);
          const offset = lerpVec3(firstOffset, secondOffset, t);

          return [
            addVec3(firstVertex, offset),
            addVec3(secondVertex, offset)
          ] as const;
        });

  const nextPolygons = polygons
    .filter((polygon) => polygon.id !== firstFace.id && polygon.id !== secondFace.id)
    .map((polygon) => ({
      expectedNormal: polygon.normal,
      id: polygon.id,
      positions: polygon.positions.map((position) => vec3(position.x, position.y, position.z)),
      vertexIds: [...polygon.vertexIds]
    }));

  const firstReplacement = replacePolygonEdge(firstFace, firstFaceOrientedEdge, rails[0][0], rails[0][1]);
  const secondFaceMatchesFirstOrientation =
    secondFaceOrientedEdge[0] === firstFaceOrientedEdge[0] &&
    secondFaceOrientedEdge[1] === firstFaceOrientedEdge[1];
  const secondReplacement = replacePolygonEdge(
    secondFace,
    secondFaceOrientedEdge,
    secondFaceMatchesFirstOrientation ? rails[rails.length - 1][0] : rails[rails.length - 1][1],
    secondFaceMatchesFirstOrientation ? rails[rails.length - 1][1] : rails[rails.length - 1][0]
  );

  if (!firstReplacement || !secondReplacement) {
    return undefined;
  }

  const firstEndpointFaces = nextPolygons.map((polygon) =>
    polygon.vertexIds.includes(orientedEdgeStartId)
      ? replacePolygonVertexWithBevelPoints(
          polygon,
          orientedEdgeStartId,
          firstFace,
          secondFace,
          rails[0][0],
          rails[rails.length - 1][0]
        )
      : polygon
  );
  const nextEndpointFaces = firstEndpointFaces.map((polygon) =>
    polygon.vertexIds.includes(orientedEdgeEndId)
      ? replacePolygonVertexWithBevelPoints(
          polygon,
          orientedEdgeEndId,
          firstFace,
          secondFace,
          rails[0][1],
          rails[rails.length - 1][1]
        )
      : polygon
  );

  const beveledPolygons: OrientedEditablePolygon[] = [
    ...nextEndpointFaces.map((polygon) => ({
      expectedNormal: polygon.expectedNormal,
      id: polygon.id,
      positions: polygon.positions
    })),
    {
      expectedNormal: firstFace.normal,
      id: firstReplacement.id,
      positions: firstReplacement.positions
    },
    {
      expectedNormal: secondFace.normal,
      id: secondReplacement.id,
      positions: secondReplacement.positions
    }
  ];

  for (let index = 0; index < rails.length - 1; index += 1) {
    beveledPolygons.push({
      id: `${firstFace.id}:bevel:${index}`,
      positions: [rails[index][0], rails[index][1], rails[index + 1][1], rails[index + 1][0]]
    });
  }

  return createEditableMeshFromPolygons(orientPolygonLoops(beveledPolygons));
}

export function extrudeEditableMeshFace(
  mesh: EditableMesh,
  faceId: FaceID,
  amount: number,
  epsilon = 0.0001
): EditableMesh | undefined {
  if (amount <= epsilon) {
    return structuredClone(mesh);
  }

  const polygons = getMeshPolygons(mesh);
  const target = polygons.find((polygon) => polygon.id === faceId);

  if (!target) {
    return undefined;
  }

  const offset = scaleVec3(normalizeVec3(target.normal), amount);
  const capPositions = target.positions.map((position) => addVec3(position, offset));
  const extrudedPolygons: OrientedEditablePolygon[] = polygons
    .filter((polygon) => polygon.id !== target.id)
    .map((polygon) => ({
      expectedNormal: polygon.normal,
      id: polygon.id,
      positions: polygon.positions.map((position) => vec3(position.x, position.y, position.z))
    }));

  extrudedPolygons.push({
    expectedNormal: target.normal,
    id: `${target.id}:extrude:cap`,
    positions: capPositions
  });

  target.positions.forEach((position, index) => {
    const nextIndex = (index + 1) % target.positions.length;

    extrudedPolygons.push({
      id: `${target.id}:extrude:side:${index}`,
      positions: [position, target.positions[nextIndex], capPositions[nextIndex], capPositions[index]]
    });
  });

  return createEditableMeshFromPolygons(orientPolygonLoops(extrudedPolygons));
}

export function extrudeEditableMeshEdge(
  mesh: EditableMesh,
  edge: [VertexID, VertexID],
  amount: number,
  overrideNormal?: Vec3,
  epsilon = 0.0001
): EditableMesh | undefined {
  if (amount <= epsilon) {
    return structuredClone(mesh);
  }

  const polygons = getMeshPolygons(mesh);
  const adjacent = polygons.filter((polygon) => findEdgeIndex(polygon.vertexIds, edge) >= 0);

  if (adjacent.length === 0 || adjacent.length > 2) {
    return undefined;
  }

  const [target] = adjacent;
  const edgeIndex = findEdgeIndex(target.vertexIds, edge);

  if (edgeIndex < 0) {
    return undefined;
  }

  const nextIndex = (edgeIndex + 1) % target.vertexIds.length;
  const orientedEdge: [VertexID, VertexID] = [
    target.vertexIds[edgeIndex],
    target.vertexIds[nextIndex]
  ];
  const startPosition = target.positions[edgeIndex];
  const endPosition = target.positions[nextIndex];
  const extrusionNormal = normalizeVec3(overrideNormal ?? averageVec3(adjacent.map((polygon) => polygon.normal)));

  if (Math.abs(extrusionNormal.x) <= epsilon && Math.abs(extrusionNormal.y) <= epsilon && Math.abs(extrusionNormal.z) <= epsilon) {
    return undefined;
  }

  const offset = scaleVec3(extrusionNormal, amount);
  const extrudedStart = addVec3(startPosition, offset);
  const extrudedEnd = addVec3(endPosition, offset);
  const edgeKey = makeUndirectedEdgeKey(edge[0], edge[1]);
  const extrudedStartId = `extrude:${edgeKey}:start`;
  const extrudedEndId = `extrude:${edgeKey}:end`;
  const nextPolygons: OrientedEditablePolygon[] = polygons
    .map((polygon) => ({
      expectedNormal: polygon.normal,
      id: polygon.id,
      positions: polygon.positions.map((position) => vec3(position.x, position.y, position.z)),
      vertexIds: [...polygon.vertexIds]
    }));

  if (adjacent.length === 2) {
    adjacent.forEach((polygon, polygonIndex) => {
      const polygonEdgeIndex = findEdgeIndex(polygon.vertexIds, orientedEdge);

      if (polygonEdgeIndex < 0) {
        return;
      }

      const polygonNextIndex = (polygonEdgeIndex + 1) % polygon.vertexIds.length;
      const localStartId = polygon.vertexIds[polygonEdgeIndex];
      const localEndId = polygon.vertexIds[polygonNextIndex];
      const localStartExtruded = localStartId === orientedEdge[0] ? extrudedStart : extrudedEnd;
      const localEndExtruded = localEndId === orientedEdge[1] ? extrudedEnd : extrudedStart;
      const localStartExtrudedId = localStartId === orientedEdge[0] ? extrudedStartId : extrudedEndId;
      const localEndExtrudedId = localEndId === orientedEdge[1] ? extrudedEndId : extrudedStartId;

      nextPolygons.push(
        {
          id: `${polygon.id}:extrude:side:${polygonIndex}`,
          positions: [
            polygon.positions[polygonEdgeIndex],
            polygon.positions[polygonNextIndex],
            localEndExtruded,
            localStartExtruded
          ],
          vertexIds: [
            `${polygon.id}:extrude:${edgeKey}:start`,
            `${polygon.id}:extrude:${edgeKey}:end`,
            localEndExtrudedId,
            localStartExtrudedId
          ]
        }
      );
    });

    return createEditableMeshFromPolygons(orientPolygonLoops(nextPolygons));
  }

  nextPolygons.push({
    id: `${target.id}:extrude:${edgeKey}`,
    positions: [
      vec3(startPosition.x, startPosition.y, startPosition.z),
      vec3(endPosition.x, endPosition.y, endPosition.z),
      vec3(extrudedEnd.x, extrudedEnd.y, extrudedEnd.z),
      vec3(extrudedStart.x, extrudedStart.y, extrudedStart.z)
    ],
    vertexIds: [
      orientedEdge[0],
      orientedEdge[1],
      extrudedEndId,
      extrudedStartId
    ]
  });

  return createEditableMeshFromPolygons(orientPolygonLoops(nextPolygons));
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

function resolveEditableMeshFaceCut(
  mesh: EditableMesh,
  faceId: FaceID,
  point: Vec3,
  snapSize: number,
  epsilon: number
): ResolvedFaceCut | undefined {
  const target = getMeshPolygons(mesh).find((polygon) => polygon.id === faceId);

  if (!target || target.positions.length < 3) {
    return undefined;
  }

  const basis = createFacePlaneBasis(target.normal);
  const projectedPoint = projectFacePoint(point, target.center, basis);
  const axis = Math.abs(projectedPoint.u) >= Math.abs(projectedPoint.v) ? "u" : "v";
  const otherAxis = axis === "u" ? "v" : "u";
  const coordinate = snapValue(projectedPoint[axis], snapSize);
  const projectedPositions = target.positions.map((position) => projectFacePoint(position, target.center, basis));
  const bounds = projectedPositions.reduce(
    (current, candidate) => ({
      max: Math.max(current.max, candidate[axis]),
      min: Math.min(current.min, candidate[axis])
    }),
    {
      max: Number.NEGATIVE_INFINITY,
      min: Number.POSITIVE_INFINITY
    }
  );

  if (coordinate <= bounds.min + epsilon || coordinate >= bounds.max - epsilon) {
    return undefined;
  }

  const intersections = projectedPositions
    .map((position, edgeIndex) => {
      const nextIndex = (edgeIndex + 1) % projectedPositions.length;
      const next = projectedPositions[nextIndex];
      const delta = next[axis] - position[axis];

      if (Math.abs(delta) <= epsilon) {
        return undefined;
      }

      const t = (coordinate - position[axis]) / delta;

      if (t <= epsilon || t >= 1 - epsilon) {
        return undefined;
      }

      if (coordinate < Math.min(position[axis], next[axis]) - epsilon || coordinate > Math.max(position[axis], next[axis]) + epsilon) {
        return undefined;
      }

      return {
        edge: [target.vertexIds[edgeIndex], target.vertexIds[nextIndex]] as [VertexID, VertexID],
        edgeIndex,
        point: lerpVec3(target.positions[edgeIndex], target.positions[nextIndex], t),
        projected: {
          [axis]: coordinate,
          [otherAxis]: position[otherAxis] + (next[otherAxis] - position[otherAxis]) * t
        } as FacePlanePoint
      };
    })
    .filter(
      (
        intersection
      ): intersection is {
        edge: [VertexID, VertexID];
        edgeIndex: number;
        point: Vec3;
        projected: FacePlanePoint;
      } => Boolean(intersection)
    )
    .filter(
      (intersection, index, collection) =>
        collection.findIndex(
          (candidate) =>
            candidate.edgeIndex === intersection.edgeIndex ||
            (
              Math.abs(candidate.point.x - intersection.point.x) <= epsilon &&
              Math.abs(candidate.point.y - intersection.point.y) <= epsilon &&
              Math.abs(candidate.point.z - intersection.point.z) <= epsilon
            )
        ) === index
    )
    .sort((left, right) => left.projected[otherAxis] - right.projected[otherAxis]);

  if (intersections.length !== 2) {
    return undefined;
  }

  const [firstIntersection, secondIntersection] = intersections;

  return {
    end: secondIntersection.point,
    firstEdge: firstIntersection.edge,
    firstEdgeIndex: firstIntersection.edgeIndex,
    firstPoint: firstIntersection.point,
    secondEdge: secondIntersection.edge,
    secondEdgeIndex: secondIntersection.edgeIndex,
    secondPoint: secondIntersection.point,
    start: firstIntersection.point,
    target
  };
}

function createFacePlaneBasis(normal: Vec3) {
  const normalizedNormal = normalizeVec3(normal);
  const reference = Math.abs(normalizedNormal.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0);
  const u = normalizeVec3(crossVec3(reference, normalizedNormal));
  const v = normalizeVec3(crossVec3(normalizedNormal, u));

  return { u, v };
}

function projectFacePoint(point: Vec3, origin: Vec3, basis: { u: Vec3; v: Vec3 }): FacePlanePoint {
  const offset = subVec3(point, origin);

  return {
    u: dotVec3(offset, basis.u),
    v: dotVec3(offset, basis.v)
  };
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
  polygon: MeshPolygonData | OrientedEditablePolygon,
  targetVertexId: VertexID,
  firstFace: MeshPolygonData,
  secondFace: MeshPolygonData,
  firstPoint: Vec3,
  secondPoint: Vec3
): OrientedEditablePolygon & { vertexIds: VertexID[] } {
  const vertexIds = "vertexIds" in polygon && polygon.vertexIds ? [...polygon.vertexIds] : [];
  const expectedNormal =
    ("expectedNormal" in polygon ? polygon.expectedNormal : undefined) ??
    ("normal" in polygon ? polygon.normal : undefined);
  const targetIndex = vertexIds.indexOf(targetVertexId);

  if (targetIndex < 0) {
    return {
      expectedNormal,
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
    expectedNormal,
    id: polygon.id,
    positions,
    vertexIds: nextVertexIds
  };
}

function orientPolygonLoops(polygons: OrientedEditablePolygon[]) {
  const allPoints = polygons.flatMap((polygon) => polygon.positions);

  if (allPoints.length === 0) {
    return polygons;
  }

  const center = averageVec3(allPoints);

  return polygons.map((polygon) => {
    const normal = computePolygonNormal(polygon.positions);
    const alignedWithExpected =
      polygon.expectedNormal && dotVec3(normal, polygon.expectedNormal) >= 0;

    if (alignedWithExpected) {
      return polygon;
    }

    if (polygon.expectedNormal && dotVec3(normal, polygon.expectedNormal) < 0) {
      return {
        ...polygon,
        positions: polygon.positions.slice().reverse(),
        vertexIds: polygon.vertexIds?.slice().reverse()
      };
    }

    const polygonCenter = averageVec3(polygon.positions);

    return dotVec3(normal, subVec3(polygonCenter, center)) >= 0
      ? polygon
      : {
          ...polygon,
          positions: polygon.positions.slice().reverse(),
          vertexIds: polygon.vertexIds?.slice().reverse()
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
