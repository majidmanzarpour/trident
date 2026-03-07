import { resolveTransformPivot, vec3, type Transform, type Vec3 } from "@web-hammer/shared";
import { BufferGeometry, Euler, Float32BufferAttribute, Object3D, Vector3 } from "three";

export function createIndexedGeometry(positions: number[], indices?: number[]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));

  if (indices) {
    geometry.setIndex(indices);
  }

  return geometry;
}

export function addFaceOffset(origin: Vec3, normal: Vec3, distance: number): Vec3 {
  return vec3(origin.x + normal.x * distance, origin.y + normal.y * distance, origin.z + normal.z * distance);
}

export function objectToTransform(object: Object3D, pivot?: Vec3): Transform {
  return {
    position: vec3(object.position.x, object.position.y, object.position.z),
    pivot: pivot ? vec3(pivot.x, pivot.y, pivot.z) : undefined,
    rotation: vec3(object.rotation.x, object.rotation.y, object.rotation.z),
    scale: vec3(object.scale.x, object.scale.y, object.scale.z)
  };
}

export function rebaseTransformPivot(transform: Transform, nextPivot?: Vec3): Transform {
  const currentPivot = resolveTransformPivot(transform);
  const targetPivot = nextPivot ?? vec3(0, 0, 0);
  const offset = new Vector3(
    targetPivot.x - currentPivot.x,
    targetPivot.y - currentPivot.y,
    targetPivot.z - currentPivot.z
  )
    .multiply(new Vector3(transform.scale.x, transform.scale.y, transform.scale.z))
    .applyEuler(new Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z, "XYZ"));

  return {
    ...structuredClone(transform),
    pivot:
      Math.abs(targetPivot.x) <= 0.0001 &&
      Math.abs(targetPivot.y) <= 0.0001 &&
      Math.abs(targetPivot.z) <= 0.0001
        ? undefined
        : vec3(targetPivot.x, targetPivot.y, targetPivot.z),
    position: vec3(
      transform.position.x + offset.x,
      transform.position.y + offset.y,
      transform.position.z + offset.z
    )
  };
}
