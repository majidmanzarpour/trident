import type { EditableMesh } from "@web-hammer/shared";
import { addVec3, averageVec3, scaleVec3, subVec3, vec3 } from "@web-hammer/shared";

export function inflateEditableMesh(mesh: EditableMesh, factor: number): EditableMesh {
  const center = averageVec3(mesh.vertices.map((vertex) => vertex.position));

  return {
    ...mesh,
    vertices: mesh.vertices.map((vertex) => ({
      ...vertex,
      position: addVec3(center, scaleVec3(subVec3(vertex.position, center), factor))
    }))
  };
}

export function offsetEditableMeshTop(mesh: EditableMesh, amount: number, epsilon = 0.0001): EditableMesh {
  const maxY = Math.max(...mesh.vertices.map((vertex) => vertex.position.y));

  return {
    ...mesh,
    vertices: mesh.vertices.map((vertex) => ({
      ...vertex,
      position:
        Math.abs(vertex.position.y - maxY) <= epsilon
          ? addVec3(vertex.position, vec3(0, amount, 0))
          : vertex.position
    }))
  };
}
