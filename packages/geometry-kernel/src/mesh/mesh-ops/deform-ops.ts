import type { EditableMesh, Vec3, VertexID } from "@web-hammer/shared";
import { addVec3, averageVec3, normalizeVec3, scaleVec3, vec3 } from "@web-hammer/shared";
import { getMeshPolygons } from "./shared";

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