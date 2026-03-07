import { useEffect, useMemo, useState } from "react";
import { FrontSide, Mesh } from "three";
import { disableBvhRaycast, enableBvhRaycast, type DerivedRenderMesh, type DerivedRenderScene } from "@web-hammer/render-pipeline";
import { resolveTransformPivot, toTuple } from "@web-hammer/shared";
import { createIndexedGeometry } from "@/viewport/utils/geometry";

export function ScenePreview({
  hiddenNodeIds = [],
  interactive,
  onFocusNode,
  onMeshObjectChange,
  onSelectNode,
  renderScene,
  selectedNodeIds
}: {
  hiddenNodeIds?: string[];
  interactive: boolean;
  onFocusNode: (nodeId: string) => void;
  onMeshObjectChange: (nodeId: string, object: Mesh | null) => void;
  onSelectNode: (nodeIds: string[]) => void;
  renderScene: DerivedRenderScene;
  selectedNodeIds: string[];
}) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string>();
  const hiddenIds = useMemo(() => new Set(hiddenNodeIds), [hiddenNodeIds]);

  return (
    <>
      {renderScene.meshes.map((mesh) =>
        hiddenIds.has(mesh.nodeId) ? null : (
          <RenderPrimitive
            hovered={hoveredNodeId === mesh.nodeId}
            interactive={interactive}
            key={mesh.nodeId}
            mesh={mesh}
            onFocusNode={onFocusNode}
            onHoverEnd={() => setHoveredNodeId(undefined)}
            onHoverStart={setHoveredNodeId}
            onMeshObjectChange={onMeshObjectChange}
            onSelectNodes={onSelectNode}
            selected={selectedNodeIds.includes(mesh.nodeId)}
          />
        )
      )}

      {renderScene.entityMarkers.map((entity) => (
        <group key={entity.entityId} position={toTuple(entity.position)}>
          <mesh position={[0, 0.8, 0]}>
            <octahedronGeometry args={[0.35, 0]} />
            <meshStandardMaterial color={entity.color} emissive={entity.color} emissiveIntensity={0.25} />
          </mesh>
          <mesh position={[0, 0.35, 0]}>
            <cylinderGeometry args={[0.08, 0.08, 0.7, 8]} />
            <meshStandardMaterial color="#d8e0ea" metalness={0.1} roughness={0.55} />
          </mesh>
        </group>
      ))}
    </>
  );
}

function RenderPrimitive({
  hovered,
  interactive,
  mesh,
  onFocusNode,
  onHoverEnd,
  onHoverStart,
  onMeshObjectChange,
  onSelectNodes,
  selected
}: {
  hovered: boolean;
  interactive: boolean;
  mesh: DerivedRenderMesh;
  onFocusNode: (nodeId: string) => void;
  onHoverEnd: () => void;
  onHoverStart: (nodeId: string) => void;
  onMeshObjectChange: (nodeId: string, object: Mesh | null) => void;
  onSelectNodes: (nodeIds: string[]) => void;
  selected: boolean;
}) {
  const [meshObject, setMeshObject] = useState<Mesh | null>(null);
  const hasRenderableGeometry = Boolean(mesh.surface || mesh.primitive);
  const geometry = useMemo(() => {
    if (!mesh.surface) {
      return undefined;
    }

    const bufferGeometry = createIndexedGeometry(mesh.surface.positions, mesh.surface.indices);
    bufferGeometry.computeVertexNormals();
    bufferGeometry.computeBoundingBox();
    bufferGeometry.computeBoundingSphere();

    return bufferGeometry;
  }, [mesh.surface]);

  useEffect(() => {
    if (geometry && meshObject && mesh.bvhEnabled) {
      enableBvhRaycast(meshObject, geometry);
    }

    return () => {
      if (geometry) {
        disableBvhRaycast(geometry);
      }
    };
  }, [geometry, mesh.bvhEnabled, meshObject]);

  if (!hasRenderableGeometry) {
    return null;
  }

  const materialProps = {
    color: selected ? "#ffb35a" : hovered ? "#d8f4f0" : mesh.material.color,
    flatShading: mesh.material.flatShaded,
    wireframe: mesh.material.wireframe,
    metalness: mesh.material.wireframe ? 0.05 : 0.15,
    roughness: mesh.material.wireframe ? 0.45 : 0.72,
    side: FrontSide,
    emissive: selected ? "#f69036" : hovered ? "#2a7f74" : "#000000",
    emissiveIntensity: selected ? 0.42 : hovered ? 0.16 : 0
  };
  const pivot = resolveTransformPivot({
    pivot: mesh.pivot,
    position: mesh.position,
    rotation: mesh.rotation,
    scale: mesh.scale
  });

  return (
    <group
      name={`node:${mesh.nodeId}`}
      position={toTuple(mesh.position)}
      rotation={toTuple(mesh.rotation)}
      scale={toTuple(mesh.scale)}
    >
      <group position={[-pivot.x, -pivot.y, -pivot.z]}>
        <mesh
          castShadow
          onClick={(event) => {
            if (!interactive) {
              return;
            }

            event.stopPropagation();
            onSelectNodes([mesh.nodeId]);
          }}
          onDoubleClick={(event) => {
            if (!interactive) {
              return;
            }

            event.stopPropagation();
            onFocusNode(mesh.nodeId);
          }}
          onPointerOut={(event) => {
            if (!interactive) {
              return;
            }

            event.stopPropagation();
            onHoverEnd();
          }}
          onPointerOver={(event) => {
            if (!interactive) {
              return;
            }

            event.stopPropagation();
            onHoverStart(mesh.nodeId);
          }}
          ref={(object) => {
            setMeshObject(object);
            onMeshObjectChange(mesh.nodeId, object);
          }}
          receiveShadow
        >
          {geometry ? <primitive attach="geometry" object={geometry} /> : null}
          {mesh.primitive?.kind === "box" ? <boxGeometry args={toTuple(mesh.primitive.size)} /> : null}
          {mesh.primitive?.kind === "icosahedron" ? (
            <icosahedronGeometry args={[mesh.primitive.radius, mesh.primitive.detail]} />
          ) : null}
          {mesh.primitive?.kind === "cylinder" ? (
            <cylinderGeometry
              args={[
                mesh.primitive.radiusTop,
                mesh.primitive.radiusBottom,
                mesh.primitive.height,
                mesh.primitive.radialSegments
              ]}
            />
          ) : null}
          <meshStandardMaterial {...materialProps} />
        </mesh>
      </group>
    </group>
  );
}
