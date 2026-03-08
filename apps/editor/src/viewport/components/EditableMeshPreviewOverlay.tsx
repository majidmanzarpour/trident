import { triangulateEditableMesh } from "@web-hammer/geometry-kernel";
import { type EditableMesh, type GeometryNode } from "@web-hammer/shared";
import { useEffect, useMemo } from "react";
import { BufferGeometry, Float32BufferAttribute, FrontSide } from "three";
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
  const wireframeGeometry = useMemo(() => {
    const verticesById = new Map(mesh.vertices.map((vertex) => [vertex.id, vertex.position] as const));
    const segments: number[] = [];
    const seenEdges = new Set<string>();

    mesh.halfEdges.forEach((halfEdge) => {
      if (!halfEdge.next) {
        return;
      }

      const nextHalfEdge = mesh.halfEdges.find((candidate) => candidate.id === halfEdge.next);

      if (!nextHalfEdge) {
        return;
      }

      const start = verticesById.get(halfEdge.vertex);
      const end = verticesById.get(nextHalfEdge.vertex);

      if (!start || !end) {
        return;
      }

      const edgeKey = halfEdge.vertex < nextHalfEdge.vertex
        ? `${halfEdge.vertex}|${nextHalfEdge.vertex}`
        : `${nextHalfEdge.vertex}|${halfEdge.vertex}`;

      if (seenEdges.has(edgeKey)) {
        return;
      }

      seenEdges.add(edgeKey);
      segments.push(start.x, start.y, start.z, end.x, end.y, end.z);
    });

    if (segments.length === 0) {
      return undefined;
    }

    const nextGeometry = new BufferGeometry();
    nextGeometry.setAttribute("position", new Float32BufferAttribute(segments, 3));
    return nextGeometry;
  }, [mesh]);

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
