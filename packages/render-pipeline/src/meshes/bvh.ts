import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";

type BvhBufferGeometry = {
  computeBoundsTree?: typeof computeBoundsTree;
  disposeBoundsTree?: typeof disposeBoundsTree;
};

export function enableBvhRaycast(mesh: { raycast: unknown }, geometry: BvhBufferGeometry) {
  const bvhGeometry = geometry as BvhBufferGeometry;
  bvhGeometry.computeBoundsTree = computeBoundsTree;
  bvhGeometry.disposeBoundsTree = disposeBoundsTree;
  bvhGeometry.computeBoundsTree();
  mesh.raycast = acceleratedRaycast;
}

export function disableBvhRaycast(geometry: BvhBufferGeometry) {
  const bvhGeometry = geometry as BvhBufferGeometry;
  bvhGeometry.disposeBoundsTree?.();
}
