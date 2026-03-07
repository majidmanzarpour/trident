import { triangulateEditableMesh } from "@web-hammer/geometry-kernel";
import { type EditableMesh, type GeometryNode } from "@web-hammer/shared";
import { useEffect, useMemo } from "react";
import { FrontSide, WireframeGeometry } from "three";
import { NodeTransformGroup } from "@/viewport/components/NodeTransformGroup";
import { createIndexedGeometry } from "@/viewport/utils/geometry";

export function EditableMeshPreviewOverlay({
  mesh,
  node
}: {
  mesh: EditableMesh;
  node: GeometryNode;
}) {
  const triangulated = useMemo(() => triangulateEditableMesh(mesh), [mesh]);
  const geometry = useMemo(() => {
    if (!triangulated.valid) {
      return undefined;
    }

    const nextGeometry = createIndexedGeometry(triangulated.positions, triangulated.indices);
    nextGeometry.computeVertexNormals();
    return nextGeometry;
  }, [triangulated]);
  const wireframeGeometry = useMemo(() => (geometry ? new WireframeGeometry(geometry) : undefined), [geometry]);

  useEffect(
    () => () => {
      // WebGPU can still reference transient preview geometry for a frame after
      // React has swapped it out. Avoid manual disposal on this hot path.
    },
    [geometry, wireframeGeometry]
  );

  if (!geometry) {
    return null;
  }

  return (
    <NodeTransformGroup transform={node.transform}>
      <mesh geometry={geometry} renderOrder={11}>
        <meshStandardMaterial
          color="#8b5cf6"
          depthWrite={false}
          emissive="#6d28d9"
          emissiveIntensity={0.24}
          opacity={0.48}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
          side={FrontSide}
          transparent
        />
      </mesh>
      {wireframeGeometry ? (
        <lineSegments geometry={wireframeGeometry} renderOrder={12}>
          <lineBasicMaterial color="#f8fafc" depthWrite={false} opacity={0.95} toneMapped={false} transparent />
        </lineSegments>
      ) : null}
    </NodeTransformGroup>
  );
}
