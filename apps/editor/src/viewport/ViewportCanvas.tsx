import { useEffect, useMemo, useRef, useState } from "react";
import { OrbitControls, TransformControls } from "@react-three/drei";
import { Canvas, type RootState, useThree } from "@react-three/fiber";
import { WebGPURenderer } from "three/webgpu";
import {
  bevelEditableMeshEdge,
  convertBrushToEditableMesh,
  createAxisAlignedBrushFromBounds,
  cutEditableMeshBetweenEdges,
  deleteEditableMeshFaces,
  invertEditableMeshNormals,
  mergeEditableMeshFaces,
  reconstructBrushFaces,
  triangulateEditableMesh,
  type EdgeBevelProfile,
  type ReconstructedBrushFace
} from "@web-hammer/geometry-kernel";
import {
  disableBvhRaycast,
  enableBvhRaycast,
  type DerivedRenderMesh,
  type DerivedRenderScene,
  type ViewportState
} from "@web-hammer/render-pipeline";
import {
  averageVec3,
  crossVec3,
  dotVec3,
  isBrushNode,
  isMeshNode,
  makeTransform,
  normalizeVec3,
  snapValue,
  snapVec3,
  subVec3,
  toTuple,
  vec3,
  type Brush,
  type EditableMesh,
  type GeometryNode,
  type Transform,
  type Vec3
} from "@web-hammer/shared";
import type { ToolId } from "@web-hammer/tool-system";
import {
  applyBrushEditTransform,
  createBrushExtrudeHandles,
  computeBrushEditSelectionCenter,
  applyMeshEditTransform,
  buildClipPreview,
  createBrushEditHandles,
  computeMeshEditSelectionCenter,
  createMeshEditHandles,
  extrudeBrushHandle,
  type BrushEditHandle,
  type BrushExtrudeHandle,
  type MeshEditMode
} from "@/viewport/editing";
import {
  Box3,
  BufferGeometry,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  FrontSide,
  Matrix4,
  Mesh,
  Object3D,
  Plane,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  WireframeGeometry,
  type PerspectiveCamera
} from "three";

type ViewportCanvasProps = {
  activeToolId: ToolId;
  meshEditMode: MeshEditMode;
  onClearSelection: () => void;
  onCommitMeshTopology: (nodeId: string, mesh: EditableMesh) => void;
  onFocusNode: (nodeId: string) => void;
  onPlaceAsset: (position: { x: number; y: number; z: number }) => void;
  onPlaceBrush: (brush: Brush, transform: Transform) => void;
  onPreviewBrushData: (nodeId: string, brush: Brush) => void;
  onPreviewMeshData: (nodeId: string, mesh: EditableMesh) => void;
  onPreviewNodeTransform: (nodeId: string, transform: Transform) => void;
  onSelectNodes: (nodeIds: string[]) => void;
  onSplitBrushAtCoordinate: (nodeId: string, axis: "x" | "y" | "z", coordinate: number) => void;
  onUpdateBrushData: (nodeId: string, brush: Brush, beforeBrush?: Brush) => void;
  onUpdateMeshData: (nodeId: string, mesh: EditableMesh, beforeMesh?: EditableMesh) => void;
  onUpdateNodeTransform: (nodeId: string, transform: Transform, beforeTransform?: Transform) => void;
  renderScene: DerivedRenderScene;
  selectedNode?: GeometryNode;
  selectedNodeIds: string[];
  transformMode: "rotate" | "scale" | "translate";
  viewport: ViewportState;
};

type MarqueeState = {
  active: boolean;
  current: Vector2;
  origin: Vector2;
};

type BrushCreateBasis = {
  normal: Vec3;
  u: Vec3;
  v: Vec3;
};

type BrushCreateState =
  | {
      anchor: Vec3;
      basis: BrushCreateBasis;
      currentPoint: Vec3;
      stage: "base";
    }
  | {
      anchor: Vec3;
      basis: BrushCreateBasis;
      depth: number;
      dragPlane: Plane;
      height: number;
      stage: "height";
      startPoint: Vec3;
      width: number;
    };

type BevelState = {
  baseMesh: EditableMesh;
  dragDirection: Vec3;
  dragPlane: Plane;
  edge: [string, string];
  profile: EdgeBevelProfile;
  previewMesh: EditableMesh;
  startPoint: Vec3;
  steps: number;
  width: number;
};

const tempBox = new Box3();
const projectedPoint = new Vector3();

function EditorCameraRig({
  controlsEnabled,
  viewport
}: Pick<ViewportCanvasProps, "viewport"> & { controlsEnabled: boolean }) {
  const camera = useThree((state) => state.camera as PerspectiveCamera);
  const controlsRef = useRef<any>(null);

  useEffect(() => {
    const [x, y, z] = toTuple(viewport.camera.position);
    const [targetX, targetY, targetZ] = toTuple(viewport.camera.target);

    camera.position.set(x, y, z);
    camera.near = viewport.camera.near;
    camera.far = viewport.camera.far;
    camera.fov = viewport.camera.fov;
    camera.updateProjectionMatrix();

    controlsRef.current?.target.set(targetX, targetY, targetZ);
    controlsRef.current?.update();
  }, [camera, viewport]);

  return (
    <OrbitControls
      ref={controlsRef}
      dampingFactor={0.12}
      enableDamping
      enabled={controlsEnabled}
      makeDefault
      maxDistance={viewport.camera.maxDistance}
      maxPolarAngle={Math.PI - 0.01}
      minDistance={viewport.camera.minDistance}
      minPolarAngle={0.01}
      target={toTuple(viewport.camera.target)}
    />
  );
}

function ConstructionGrid({
  activeToolId,
  onPlaceAsset,
  viewport
}: Pick<ViewportCanvasProps, "activeToolId" | "onPlaceAsset" | "viewport">) {
  if (!viewport.grid.visible) {
    return null;
  }

  const minorStep = viewport.grid.snapSize;
  const majorStep = minorStep * viewport.grid.majorLineEvery;
  const extent = viewport.grid.size;

  return (
    <group position={[0, viewport.grid.elevation, 0]}>
      <mesh
        onClick={(event) => {
          if (activeToolId !== "asset-place") {
            return;
          }

          event.stopPropagation();
          const snapped = snapVec3(
            vec3(event.point.x, viewport.grid.elevation, event.point.z),
            viewport.grid.snapSize
          );
          onPlaceAsset(snapped);
        }}
        receiveShadow
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.05, 0]}
      >
        <planeGeometry args={[extent, extent]} />
        <meshBasicMaterial color="#0a0f13" transparent opacity={0.78} />
      </mesh>
      <GridLines color="#3c4652" opacity={0.72} size={extent} step={minorStep} y={0.002} />
      <GridLines color="#7f8b99" opacity={0.86} size={extent} step={majorStep} y={0.006} />
    </group>
  );
}

function GridLines({
  color,
  opacity,
  size,
  step,
  y
}: {
  color: string;
  opacity: number;
  size: number;
  step: number;
  y: number;
}) {
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const halfSize = size / 2;
    const safeStep = Math.max(step, 1);

    for (let offset = -halfSize; offset <= halfSize + 0.0001; offset += safeStep) {
      positions.push(-halfSize, y, offset, halfSize, y, offset);
      positions.push(offset, y, -halfSize, offset, y, halfSize);
    }

    return createIndexedGeometry(positions);
  }, [size, step, y]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments frustumCulled={false} geometry={geometry} renderOrder={1}>
      <lineBasicMaterial color={color} depthWrite={false} opacity={opacity} toneMapped={false} transparent />
    </lineSegments>
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
  const meshRef = useRef<Mesh | null>(null);
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
    const currentMesh = meshRef.current;

    if (geometry && currentMesh && mesh.bvhEnabled) {
      enableBvhRaycast(currentMesh, geometry);
    }

    return () => {
      if (geometry) {
        disableBvhRaycast(geometry);
      }

      geometry?.dispose();
    };
  }, [geometry, mesh.bvhEnabled]);

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

  return (
    <mesh
      castShadow
      name={`node:${mesh.nodeId}`}
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
        meshRef.current = object;
        onMeshObjectChange(mesh.nodeId, object);
      }}
      receiveShadow
      position={toTuple(mesh.position)}
      rotation={toTuple(mesh.rotation)}
      scale={toTuple(mesh.scale)}
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
  );
}

function ScenePreview({
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

function ObjectTransformGizmo({
  activeToolId,
  onPreviewNodeTransform,
  onUpdateNodeTransform,
  selectedNodeIds,
  transformMode,
  viewport
}: Pick<
  ViewportCanvasProps,
  "activeToolId" | "onPreviewNodeTransform" | "onUpdateNodeTransform" | "selectedNodeIds" | "transformMode" | "viewport"
>) {
  const baselineTransformRef = useRef<Transform | undefined>(undefined);
  const scene = useThree((state) => state.scene);
  const selectedNodeId = selectedNodeIds[0];
  const selectedObject = selectedNodeId ? scene.getObjectByName(`node:${selectedNodeId}`) : undefined;

  if (activeToolId !== "transform" || !selectedNodeId || !selectedObject) {
    return null;
  }

  return (
    <TransformControls
      enabled
      mode={transformMode}
      object={selectedObject}
      onMouseDown={() => {
        baselineTransformRef.current = objectToTransform(selectedObject);
      }}
      onMouseUp={() => {
        if (!baselineTransformRef.current) {
          return;
        }

        onUpdateNodeTransform(selectedNodeId, objectToTransform(selectedObject), baselineTransformRef.current);
        baselineTransformRef.current = undefined;
      }}
      onObjectChange={() => {
        onPreviewNodeTransform(selectedNodeId, objectToTransform(selectedObject));
      }}
      rotationSnap={Math.PI / 12}
      scaleSnap={Math.max(viewport.grid.snapSize / 16, 0.125)}
      showX
      showY
      showZ
      translationSnap={viewport.grid.snapSize}
    />
  );
}

function BrushClipOverlay({
  node,
  onSplitBrushAtCoordinate,
  viewport
}: {
  node: Extract<GeometryNode, { kind: "brush" }>;
  onSplitBrushAtCoordinate: ViewportCanvasProps["onSplitBrushAtCoordinate"];
  viewport: ViewportState;
}) {
  const [preview, setPreview] = useState<{ faceId: string; line: ReturnType<typeof buildClipPreview> }>();
  const rebuilt = useMemo(() => reconstructBrushFaces(node.data), [node.data]);

  useEffect(() => {
    setPreview(undefined);
  }, [node.id, node.data, viewport.grid.snapSize]);

  if (!rebuilt.valid) {
    return null;
  }

  const handleFacePointer = (face: ReconstructedBrushFace, point: Vector3) => {
    const line = buildClipPreview(face, vec3(point.x, point.y, point.z), viewport.grid.snapSize);

    if (!line) {
      setPreview(undefined);
      return;
    }

    setPreview({
      faceId: face.id,
      line
    });
  };

  return (
    <group
      position={toTuple(node.transform.position)}
      rotation={toTuple(node.transform.rotation)}
      scale={toTuple(node.transform.scale)}
    >
      {rebuilt.faces.map((face) => (
        <FaceHitArea
          face={face}
          hovered={preview?.faceId === face.id}
          key={face.id}
          onClick={(localPoint) => {
            const line = buildClipPreview(face, localPoint, viewport.grid.snapSize);

            if (!line) {
              return;
            }

            onSplitBrushAtCoordinate(node.id, line.axis, line.coordinate);
          }}
          onHover={handleFacePointer}
          onHoverEnd={() => setPreview(undefined)}
        />
      ))}

      {preview?.line ? <PreviewLine color="#7dd3fc" end={preview.line.end} start={preview.line.start} /> : null}
    </group>
  );
}

function BrushExtrudeOverlay({
  node,
  onPreviewBrushData,
  onUpdateBrushData,
  setTransformDragging,
  viewport
}: {
  node: Extract<GeometryNode, { kind: "brush" }>;
  onPreviewBrushData: ViewportCanvasProps["onPreviewBrushData"];
  onUpdateBrushData: ViewportCanvasProps["onUpdateBrushData"];
  setTransformDragging: (dragging: boolean) => void;
  viewport: ViewportState;
}) {
  const handles = useMemo(() => createBrushExtrudeHandles(node.data), [node.data]);

  if (handles.length === 0) {
    return null;
  }

  return (
    <group
      position={toTuple(node.transform.position)}
      rotation={toTuple(node.transform.rotation)}
      scale={toTuple(node.transform.scale)}
    >
      {handles.map((handle) => (
        <BrushExtrudeHandle
          handle={handle}
          key={`${handle.kind}:${handle.id}`}
          node={node}
          onPreviewBrushData={onPreviewBrushData}
          onUpdateBrushData={onUpdateBrushData}
          setTransformDragging={setTransformDragging}
          viewport={viewport}
        />
      ))}
    </group>
  );
}

function BrushExtrudeHandle({
  handle,
  node,
  onPreviewBrushData,
  onUpdateBrushData,
  setTransformDragging,
  viewport
}: {
  handle: BrushExtrudeHandle;
  node: Extract<GeometryNode, { kind: "brush" }>;
  onPreviewBrushData: ViewportCanvasProps["onPreviewBrushData"];
  onUpdateBrushData: ViewportCanvasProps["onUpdateBrushData"];
  setTransformDragging: (dragging: boolean) => void;
  viewport: ViewportState;
}) {
  const dragStateRef = useRef<{
    baseBrush: Brush;
    baseHandle: BrushExtrudeHandle;
    plane: Plane;
    startPoint: Vector3;
  } | null>(null);
  const raycasterRef = useRef(new Raycaster());
  const { camera, gl } = useThree();
  const extrusionNormal = handle.normal ? new Vector3(handle.normal.x, handle.normal.y, handle.normal.z).normalize() : undefined;
  const tip = useMemo(
    () => (handle.normal ? addFaceOffset(handle.position, handle.normal, handle.kind === "face" ? 0.42 : 0.3) : handle.position),
    [handle]
  );
  const stemEnd = useMemo(
    () => (handle.normal ? addFaceOffset(handle.position, handle.normal, handle.kind === "face" ? 0.28 : 0.18) : handle.position),
    [handle]
  );

  useEffect(() => {
    return () => {
      dragStateRef.current = null;
      setTransformDragging(false);
    };
  }, [setTransformDragging]);

  if (!extrusionNormal) {
    return null;
  }

  return (
    <group>
      <PreviewLine color={handle.kind === "face" ? "#7dd3fc" : "#67e8f9"} end={stemEnd} start={handle.position} />
      <mesh
        onPointerDown={(event) => {
          event.stopPropagation();

          const cameraDirection = camera.getWorldDirection(new Vector3());
          let tangent = new Vector3().crossVectors(cameraDirection, extrusionNormal);

          if (tangent.lengthSq() <= 0.0001) {
            tangent = new Vector3().crossVectors(new Vector3(0, 1, 0), extrusionNormal);
          }

          if (tangent.lengthSq() <= 0.0001) {
            tangent = new Vector3().crossVectors(new Vector3(1, 0, 0), extrusionNormal);
          }

          const planeNormal = new Vector3().crossVectors(extrusionNormal, tangent).normalize();
          const plane = new Plane().setFromNormalAndCoplanarPoint(
            planeNormal,
            new Vector3(tip.x, tip.y, tip.z)
          );
          const startPoint = event.ray.intersectPlane(plane, new Vector3()) ?? new Vector3(tip.x, tip.y, tip.z);

          dragStateRef.current = {
            baseBrush: structuredClone(node.data),
            baseHandle: structuredClone(handle),
            plane,
            startPoint
          };
          setTransformDragging(true);

          const handlePointerMove = (pointerEvent: PointerEvent) => {
            if (!dragStateRef.current) {
              return;
            }

            const rect = gl.domElement.getBoundingClientRect();
            const ndc = new Vector2(
              ((pointerEvent.clientX - rect.left) / rect.width) * 2 - 1,
              -(((pointerEvent.clientY - rect.top) / rect.height) * 2 - 1)
            );
            raycasterRef.current.setFromCamera(ndc, camera);
            const point = raycasterRef.current.ray.intersectPlane(dragStateRef.current.plane, new Vector3());

            if (!point) {
              return;
            }

            const delta = point.clone().sub(dragStateRef.current.startPoint).dot(extrusionNormal);
            const snappedDelta = Math.max(0, Math.round(delta / viewport.grid.snapSize) * viewport.grid.snapSize);
            const nextBrush = extrudeBrushHandle(
              dragStateRef.current.baseBrush,
              dragStateRef.current.baseHandle,
              snappedDelta
            );

            if (nextBrush) {
              onPreviewBrushData(node.id, nextBrush);
            } else {
              onPreviewBrushData(node.id, dragStateRef.current.baseBrush);
            }
          };

          const handlePointerUp = (pointerEvent: PointerEvent) => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            setTransformDragging(false);

            if (!dragStateRef.current) {
              return;
            }

            const rect = gl.domElement.getBoundingClientRect();
            const ndc = new Vector2(
              ((pointerEvent.clientX - rect.left) / rect.width) * 2 - 1,
              -(((pointerEvent.clientY - rect.top) / rect.height) * 2 - 1)
            );
            raycasterRef.current.setFromCamera(ndc, camera);
            const point = raycasterRef.current.ray.intersectPlane(dragStateRef.current.plane, new Vector3());
            const delta = point ? point.clone().sub(dragStateRef.current.startPoint).dot(extrusionNormal) : 0;
            const snappedDelta = Math.max(0, Math.round(delta / viewport.grid.snapSize) * viewport.grid.snapSize);
            const nextBrush = extrudeBrushHandle(
              dragStateRef.current.baseBrush,
              dragStateRef.current.baseHandle,
              snappedDelta
            );

            if (nextBrush) {
              onUpdateBrushData(node.id, nextBrush, dragStateRef.current.baseBrush);
            } else {
              onPreviewBrushData(node.id, dragStateRef.current.baseBrush);
            }

            dragStateRef.current = null;
          };

          window.addEventListener("pointermove", handlePointerMove);
          window.addEventListener("pointerup", handlePointerUp, { once: true });
        }}
        position={toTuple(tip)}
      >
        <octahedronGeometry args={[handle.kind === "face" ? 0.12 : 0.09, 0]} />
        <meshStandardMaterial
          color={handle.kind === "face" ? "#dbeafe" : "#cffafe"}
          emissive={handle.kind === "face" ? "#38bdf8" : "#06b6d4"}
          emissiveIntensity={0.28}
        />
      </mesh>
    </group>
  );
}

function MeshEditOverlay({
  handles,
  meshEditMode,
  node,
  onPreviewMeshData,
  onUpdateMeshData,
  selectedHandleIds,
  setSelectedHandleIds,
  transformMode,
  viewport
}: {
  handles: ReturnType<typeof createMeshEditHandles>;
  meshEditMode: MeshEditMode;
  node: Extract<GeometryNode, { kind: "mesh" }>;
  onPreviewMeshData: ViewportCanvasProps["onPreviewMeshData"];
  onUpdateMeshData: ViewportCanvasProps["onUpdateMeshData"];
  selectedHandleIds: string[];
  setSelectedHandleIds: (ids: string[]) => void;
  transformMode: ViewportCanvasProps["transformMode"];
  viewport: ViewportState;
}) {
  const [controlObject, setControlObject] = useState<Object3D | null>(null);
  const controlRef = useRef<Object3D | null>(null);
  const baselineMeshRef = useRef<EditableMesh | undefined>(undefined);
  const baselineTransformRef = useRef<Transform | undefined>(undefined);
  const selectionCenter = useMemo(
    () => computeMeshEditSelectionCenter(handles, selectedHandleIds),
    [handles, selectedHandleIds]
  );

  useEffect(() => {
    if (baselineMeshRef.current) {
      return;
    }

    const validIds = new Set(handles.map((handle) => handle.id));
    const nextIds = selectedHandleIds.filter((id) => validIds.has(id));

    if (nextIds.length !== selectedHandleIds.length) {
      setSelectedHandleIds(nextIds);
    }
  }, [handles, selectedHandleIds, setSelectedHandleIds]);

  useEffect(() => {
    if (!controlRef.current || selectedHandleIds.length === 0) {
      return;
    }

    if (!baselineMeshRef.current) {
      controlRef.current.position.set(selectionCenter.x, selectionCenter.y, selectionCenter.z);
      controlRef.current.rotation.set(0, 0, 0);
      controlRef.current.scale.set(1, 1, 1);
    }
  }, [selectedHandleIds.length, selectionCenter]);

  return (
    <>
      <group
        position={toTuple(node.transform.position)}
        rotation={toTuple(node.transform.rotation)}
        scale={toTuple(node.transform.scale)}
      >
        {handles.map((handle) => {
          const selected = selectedHandleIds.includes(handle.id);

          return (
            <MeshEditHandleVisual
              handle={handle}
              key={handle.id}
              mode={meshEditMode}
              onSelect={(event) => {
                event.stopPropagation();
                if (event.shiftKey) {
                  setSelectedHandleIds(
                    selected ? selectedHandleIds.filter((id) => id !== handle.id) : [...selectedHandleIds, handle.id]
                  );
                  return;
                }

                setSelectedHandleIds([handle.id]);
              }}
              selected={selected}
            />
          );
        })}

        {selectedHandleIds.length > 0 ? (
          <group
            ref={(object) => {
              controlRef.current = object;
              setControlObject(object);

              if (object && !baselineMeshRef.current) {
                object.position.set(selectionCenter.x, selectionCenter.y, selectionCenter.z);
                object.rotation.set(0, 0, 0);
                object.scale.set(1, 1, 1);
              }
            }}
          >
            <mesh visible={false}>
              <boxGeometry args={[0.2, 0.2, 0.2]} />
              <meshBasicMaterial transparent opacity={0} />
            </mesh>
          </group>
        ) : null}
      </group>

      {selectedHandleIds.length > 0 && controlObject ? (
        <TransformControls
          key={`mesh-edit:${transformMode}:${selectedHandleIds.join(":")}`}
          enabled
          mode={transformMode}
          object={controlObject}
          onMouseDown={() => {
            baselineMeshRef.current = structuredClone(node.data);
            baselineTransformRef.current = objectToTransform(controlObject);
          }}
          onMouseUp={() => {
            if (!baselineMeshRef.current || !baselineTransformRef.current) {
              return;
            }

            const nextMesh = applyMeshEditTransform(
              baselineMeshRef.current,
              meshEditMode,
              selectedHandleIds,
              baselineTransformRef.current,
              objectToTransform(controlObject)
            );
            onUpdateMeshData(node.id, nextMesh, baselineMeshRef.current);
            baselineMeshRef.current = undefined;
            baselineTransformRef.current = undefined;
          }}
          onObjectChange={() => {
            if (!baselineMeshRef.current || !baselineTransformRef.current) {
              return;
            }

            const nextMesh = applyMeshEditTransform(
              baselineMeshRef.current,
              meshEditMode,
              selectedHandleIds,
              baselineTransformRef.current,
              objectToTransform(controlObject)
            );
            onPreviewMeshData(node.id, nextMesh);
          }}
          rotationSnap={Math.PI / 12}
          scaleSnap={Math.max(viewport.grid.snapSize / 16, 0.125)}
          showX
          showY
          showZ
          translationSnap={viewport.grid.snapSize}
        />
      ) : null}
    </>
  );
}

function BrushEditOverlay({
  handles,
  meshEditMode,
  node,
  onPreviewBrushData,
  onUpdateBrushData,
  selectedHandleIds,
  setSelectedHandleIds,
  transformMode,
  viewport
}: {
  handles: BrushEditHandle[];
  meshEditMode: MeshEditMode;
  node: Extract<GeometryNode, { kind: "brush" }>;
  onPreviewBrushData: ViewportCanvasProps["onPreviewBrushData"];
  onUpdateBrushData: ViewportCanvasProps["onUpdateBrushData"];
  selectedHandleIds: string[];
  setSelectedHandleIds: (ids: string[]) => void;
  transformMode: ViewportCanvasProps["transformMode"];
  viewport: ViewportState;
}) {
  const [controlObject, setControlObject] = useState<Object3D | null>(null);
  const controlRef = useRef<Object3D | null>(null);
  const baselineBrushRef = useRef<Brush | undefined>(undefined);
  const baselineHandlesRef = useRef<BrushEditHandle[] | undefined>(undefined);
  const baselineTransformRef = useRef<Transform | undefined>(undefined);
  const selectionCenter = useMemo(
    () => computeBrushEditSelectionCenter(handles, selectedHandleIds),
    [handles, selectedHandleIds]
  );

  useEffect(() => {
    if (baselineBrushRef.current) {
      return;
    }

    const validIds = new Set(handles.map((handle) => handle.id));
    const nextIds = selectedHandleIds.filter((id) => validIds.has(id));

    if (nextIds.length !== selectedHandleIds.length) {
      setSelectedHandleIds(nextIds);
    }
  }, [handles, selectedHandleIds, setSelectedHandleIds]);

  useEffect(() => {
    if (!controlRef.current || selectedHandleIds.length === 0) {
      return;
    }

    if (!baselineBrushRef.current) {
      controlRef.current.position.set(selectionCenter.x, selectionCenter.y, selectionCenter.z);
      controlRef.current.rotation.set(0, 0, 0);
      controlRef.current.scale.set(1, 1, 1);
    }
  }, [selectedHandleIds.length, selectionCenter]);

  return (
    <>
      <group
        position={toTuple(node.transform.position)}
        rotation={toTuple(node.transform.rotation)}
        scale={toTuple(node.transform.scale)}
      >
        {handles.map((handle) => {
          const selected = selectedHandleIds.includes(handle.id);

          return (
            <BrushEditHandleVisual
              handle={handle}
              key={handle.id}
              mode={meshEditMode}
              onSelect={(event) => {
                event.stopPropagation();

                if (event.shiftKey) {
                  setSelectedHandleIds(
                    selected ? selectedHandleIds.filter((id) => id !== handle.id) : [...selectedHandleIds, handle.id]
                  );
                  return;
                }

                setSelectedHandleIds([handle.id]);
              }}
              selected={selected}
            />
          );
        })}

        {selectedHandleIds.length > 0 ? (
          <group
            ref={(object) => {
              controlRef.current = object;
              setControlObject(object);

              if (object && !baselineBrushRef.current) {
                object.position.set(selectionCenter.x, selectionCenter.y, selectionCenter.z);
                object.rotation.set(0, 0, 0);
                object.scale.set(1, 1, 1);
              }
            }}
          >
            <mesh visible={false}>
              <boxGeometry args={[0.2, 0.2, 0.2]} />
              <meshBasicMaterial opacity={0} transparent />
            </mesh>
          </group>
        ) : null}
      </group>

      {selectedHandleIds.length > 0 && controlObject ? (
        <TransformControls
          key={`brush-edit:${transformMode}:${selectedHandleIds.join(":")}`}
          enabled
          mode={transformMode}
          object={controlObject}
          onMouseDown={() => {
            baselineBrushRef.current = structuredClone(node.data);
            baselineHandlesRef.current = structuredClone(handles);
            baselineTransformRef.current = objectToTransform(controlObject);
          }}
          onMouseUp={() => {
            if (!baselineBrushRef.current || !baselineTransformRef.current) {
              return;
            }

            const nextBrush = applyBrushEditTransform(
              baselineBrushRef.current,
              baselineHandlesRef.current ?? handles,
              selectedHandleIds,
              baselineTransformRef.current,
              objectToTransform(controlObject),
              viewport.grid.snapSize
            );

            if (nextBrush) {
              onUpdateBrushData(node.id, nextBrush, baselineBrushRef.current);
            } else {
              onPreviewBrushData(node.id, baselineBrushRef.current);
            }

            baselineBrushRef.current = undefined;
            baselineHandlesRef.current = undefined;
            baselineTransformRef.current = undefined;
          }}
          onObjectChange={() => {
            if (!baselineBrushRef.current || !baselineTransformRef.current) {
              return;
            }

            const nextBrush = applyBrushEditTransform(
              baselineBrushRef.current,
              baselineHandlesRef.current ?? handles,
              selectedHandleIds,
              baselineTransformRef.current,
              objectToTransform(controlObject),
              viewport.grid.snapSize
            );

            if (nextBrush) {
              onPreviewBrushData(node.id, nextBrush);
            }
          }}
          showX
          showY
          showZ
          rotationSnap={Math.PI / 12}
          scaleSnap={Math.max(viewport.grid.snapSize / 16, 0.125)}
          translationSnap={viewport.grid.snapSize}
        />
      ) : null}
    </>
  );
}

function FaceHitArea({
  face,
  hovered,
  onClick,
  onHover,
  onHoverEnd
}: {
  face: ReconstructedBrushFace;
  hovered: boolean;
  onClick: (localPoint: Vec3) => void;
  onHover: (face: ReconstructedBrushFace, localPoint: Vector3) => void;
  onHoverEnd: () => void;
}) {
  const geometry = useMemo(() => {
    const positions = face.vertices.flatMap((vertex) => [
      vertex.position.x + face.normal.x * 0.02,
      vertex.position.y + face.normal.y * 0.02,
      vertex.position.z + face.normal.z * 0.02
    ]);

    return createIndexedGeometry(positions, face.triangleIndices);
  }, [face]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh
      geometry={geometry}
      onClick={(event) => {
        event.stopPropagation();
        const localPoint = event.object.worldToLocal(event.point.clone());
        onClick(vec3(localPoint.x, localPoint.y, localPoint.z));
      }}
      onPointerMove={(event) => {
        event.stopPropagation();
        onHover(face, event.object.worldToLocal(event.point.clone()));
      }}
      onPointerOut={(event) => {
        event.stopPropagation();
        onHoverEnd();
      }}
      renderOrder={8}
    >
      <meshBasicMaterial
        color="#7dd3fc"
        depthWrite={false}
        opacity={hovered ? 0.12 : 0.015}
        side={DoubleSide}
        transparent
      />
    </mesh>
  );
}

function MeshEditHandleVisual({
  handle,
  mode,
  onSelect,
  selected
}: {
  handle: ReturnType<typeof createMeshEditHandles>[number];
  mode: MeshEditMode;
  onSelect: (event: any) => void;
  selected: boolean;
}) {
  return (
    <group>
      {mode === "edge" && handle.points?.length === 2 ? (
        <PreviewLine color={selected ? "#93c5fd" : "#64748b"} end={handle.points[1]} start={handle.points[0]} />
      ) : null}
      {mode === "face" && handle.points && handle.points.length >= 3 ? (
        <ClosedPolyline color={selected ? "#93c5fd" : "#38bdf8"} points={handle.points} />
      ) : null}
      <mesh onClick={onSelect} position={toTuple(handle.position)}>
        {mode === "vertex" ? <octahedronGeometry args={[selected ? 0.1 : 0.075, 0]} /> : null}
        {mode === "edge" ? <boxGeometry args={selected ? [0.16, 0.16, 0.16] : [0.12, 0.12, 0.12]} /> : null}
        {mode === "face" ? <boxGeometry args={selected ? [0.18, 0.18, 0.04] : [0.14, 0.14, 0.03]} /> : null}
        <meshStandardMaterial
          color={selected ? "#dbeafe" : mode === "face" ? "#67e8f9" : "#cbd5e1"}
          emissive={selected ? "#60a5fa" : "#0f172a"}
          emissiveIntensity={selected ? 0.35 : 0.08}
        />
      </mesh>
    </group>
  );
}

function BrushEditHandleVisual({
  handle,
  mode,
  onSelect,
  selected
}: {
  handle: BrushEditHandle;
  mode: MeshEditMode;
  onSelect: (event: any) => void;
  selected: boolean;
}) {
  const faceOutline = mode === "face" && handle.points && handle.points.length >= 3;
  const edgeLine = mode === "edge" && handle.points?.length === 2;

  return (
    <group>
      {edgeLine ? (
        <PreviewLine color={selected ? "#f8fafc" : "#94a3b8"} end={handle.points![1]} start={handle.points![0]} />
      ) : null}
      {faceOutline ? (
        <ClosedPolyline color={selected ? "#f8fafc" : "#94a3b8"} points={handle.points!} />
      ) : null}
      <mesh onClick={onSelect} position={toTuple(handle.position)}>
        {mode === "vertex" ? <octahedronGeometry args={[selected ? 0.11 : 0.085, 0]} /> : null}
        {mode === "edge" ? <boxGeometry args={selected ? [0.18, 0.18, 0.18] : [0.14, 0.14, 0.14]} /> : null}
        {mode === "face" ? <boxGeometry args={selected ? [0.2, 0.2, 0.04] : [0.16, 0.16, 0.03]} /> : null}
        <meshStandardMaterial
          color={selected ? "#f8fafc" : "#e2e8f0"}
          emissive={selected ? "#93c5fd" : "#0f172a"}
          emissiveIntensity={selected ? 0.24 : 0.06}
        />
      </mesh>
    </group>
  );
}

function ClosedPolyline({
  color,
  points
}: {
  color: string;
  points: Vec3[];
}) {
  const geometry = useMemo(() => {
    const positions: number[] = [];

    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      positions.push(current.x, current.y, current.z, next.x, next.y, next.z);
    }

    return createIndexedGeometry(positions);
  }, [points]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry} renderOrder={10}>
      <lineBasicMaterial color={color} depthWrite={false} opacity={0.9} toneMapped={false} transparent />
    </lineSegments>
  );
}

function PreviewLine({
  color,
  end,
  start
}: {
  color: string;
  end: Vec3;
  start: Vec3;
}) {
  const geometry = useMemo(() => createIndexedGeometry([start.x, start.y, start.z, end.x, end.y, end.z]), [end, start]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry} renderOrder={10}>
      <lineBasicMaterial color={color} depthWrite={false} linewidth={2} toneMapped={false} />
    </lineSegments>
  );
}

function EditableMeshPreviewOverlay({
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
      geometry?.dispose();
      wireframeGeometry?.dispose();
    },
    [geometry, wireframeGeometry]
  );

  if (!geometry) {
    return null;
  }

  return (
    <group
      position={toTuple(node.transform.position)}
      rotation={toTuple(node.transform.rotation)}
      scale={toTuple(node.transform.scale)}
    >
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
    </group>
  );
}

function BrushCreatePreview({ snapSize, state }: { snapSize: number; state: BrushCreateState }) {
  const geometry = useMemo(() => createIndexedGeometry(buildBrushCreatePreviewPositions(state, snapSize)), [snapSize, state]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry} renderOrder={12}>
      <lineBasicMaterial color="#7dd3fc" depthWrite={false} opacity={0.94} toneMapped={false} transparent />
    </lineSegments>
  );
}

export function ViewportCanvas({
  activeToolId,
  meshEditMode,
  onClearSelection,
  onCommitMeshTopology,
  onFocusNode,
  onPlaceAsset,
  onPlaceBrush,
  onPreviewBrushData,
  onPreviewMeshData,
  onPreviewNodeTransform,
  onSelectNodes,
  onSplitBrushAtCoordinate,
  onUpdateBrushData,
  onUpdateMeshData,
  onUpdateNodeTransform,
  renderScene,
  selectedNode,
  selectedNodeIds,
  transformMode,
  viewport
}: ViewportCanvasProps) {
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const brushClickOriginRef = useRef<Vector2 | null>(null);
  const marqueeOriginRef = useRef<Vector2 | null>(null);
  const pointerPositionRef = useRef<Vector2 | null>(null);
  const viewportRootRef = useRef<HTMLDivElement | null>(null);
  const meshObjectsRef = useRef(new Map<string, Mesh>());
  const raycasterRef = useRef(new Raycaster());
  const [brushEditHandleIds, setBrushEditHandleIds] = useState<string[]>([]);
  const [brushCreateState, setBrushCreateState] = useState<BrushCreateState | null>(null);
  const [bevelState, setBevelState] = useState<BevelState | null>(null);
  const [meshEditSelectionIds, setMeshEditSelectionIds] = useState<string[]>([]);
  const [transformDragging, setTransformDragging] = useState(false);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);

  useEffect(() => {
    setMeshEditSelectionIds([]);
    setBrushEditHandleIds([]);
    setBevelState(null);
    setTransformDragging(false);
  }, [activeToolId, meshEditMode, selectedNode?.id, selectedNode?.kind]);

  useEffect(() => {
    if (activeToolId !== "brush") {
      setBrushCreateState(null);
    }
  }, [activeToolId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !brushCreateState) {
        return;
      }

      event.preventDefault();
      setBrushCreateState(null);
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [brushCreateState]);

  const selectedBrushNode = selectedNode && isBrushNode(selectedNode) ? selectedNode : undefined;
  const selectedMeshNode = selectedNode && isMeshNode(selectedNode) ? selectedNode : undefined;
  const brushEditHandles =
    activeToolId === "mesh-edit" && selectedBrushNode
      ? createBrushEditHandles(selectedBrushNode.data, meshEditMode)
      : [];
  const meshEditHandles =
    activeToolId === "mesh-edit" && selectedMeshNode
      ? createMeshEditHandles(selectedMeshNode.data, meshEditMode)
      : [];
  const editableMeshSource =
    activeToolId === "mesh-edit" && selectedBrushNode
      ? convertBrushToEditableMesh(selectedBrushNode.data)
      : activeToolId === "mesh-edit" && selectedMeshNode
        ? selectedMeshNode.data
        : undefined;
  const editableMeshHandles =
    activeToolId === "mesh-edit" && editableMeshSource
      ? createMeshEditHandles(editableMeshSource, meshEditMode)
      : [];

  const resolveSelectedEditableMeshEdgePairs = () => {
    if (!editableMeshSource) {
      return [];
    }

    if (selectedMeshNode) {
      return editableMeshHandles
        .filter((handle) => meshEditSelectionIds.includes(handle.id))
        .map((handle) => handle.vertexIds as [string, string])
        .filter((vertexIds): vertexIds is [string, string] => vertexIds.length === 2);
    }

    return brushEditHandles
      .filter((handle) => brushEditHandleIds.includes(handle.id))
      .map((handle) => findMatchingMeshEdgePair(editableMeshHandles, handle))
      .filter((edge): edge is [string, string] => Boolean(edge));
  };

  const resolveSelectedEditableMeshFaceIds = () => {
    if (!editableMeshSource) {
      return [];
    }

    return selectedMeshNode ? meshEditSelectionIds : brushEditHandleIds;
  };

  const handleMeshObjectChange = (nodeId: string, object: Mesh | null) => {
    if (object) {
      meshObjectsRef.current.set(nodeId, object);
      return;
    }

    meshObjectsRef.current.delete(nodeId);
  };

  const clearSubobjectSelection = () => {
    setBrushEditHandleIds([]);
    setMeshEditSelectionIds([]);
  };

  const commitMeshTopology = (mesh: EditableMesh | undefined) => {
    if (!selectedNode || !mesh) {
      return;
    }

    onCommitMeshTopology(selectedNode.id, mesh);
    clearSubobjectSelection();
    setBevelState(null);
  };

  const startBevelOperation = () => {
    if (!editableMeshSource || !cameraRef.current || !selectedNode || !pointerPositionRef.current) {
      return;
    }

    const selectedEdges = resolveSelectedEditableMeshEdgePairs();

    if (selectedEdges.length !== 1) {
      return;
    }

    const bounds = viewportRootRef.current?.getBoundingClientRect();

    if (!bounds) {
      return;
    }

    const edgeHandle = editableMeshHandles.find(
      (handle) => handle.vertexIds.length === 2 && makeUndirectedPairKey(handle.vertexIds as [string, string]) === makeUndirectedPairKey(selectedEdges[0])
    );

    if (!edgeHandle || !edgeHandle.points || edgeHandle.points.length !== 2) {
      return;
    }

    const midpoint = averageVec3(edgeHandle.points);
    const axis = normalizeVec3(subVec3(edgeHandle.points[1], edgeHandle.points[0]));
    const faceHandles = createMeshEditHandles(editableMeshSource, "face");
    const faceDirections = faceHandles
      .filter((handle) => selectedEdges[0].every((vertexId) => handle.vertexIds.includes(vertexId)))
      .map((handle) => rejectVec3FromAxis(subVec3(handle.position, midpoint), axis))
      .filter((direction) => vec3LengthSquared(direction) > 0.000001);
    const dragPlane = createBrushCreateDragPlane(cameraRef.current, axis, midpoint);
    const startPoint =
      projectPointerToThreePlane(
        pointerPositionRef.current.x + bounds.left,
        pointerPositionRef.current.y + bounds.top,
        bounds,
        cameraRef.current,
        raycasterRef.current,
        dragPlane
      ) ?? new Vector3(midpoint.x, midpoint.y, midpoint.z);
    const averagedFaceDirection = normalizeVec3(averageVec3(faceDirections));
    const fallbackDirection = normalizeVec3(crossVec3(axis, vec3(dragPlane.normal.x, dragPlane.normal.y, dragPlane.normal.z)));

    setBevelState({
      baseMesh: structuredClone(editableMeshSource),
      dragDirection:
        vec3LengthSquared(averagedFaceDirection) > 0.000001 ? averagedFaceDirection : fallbackDirection,
      dragPlane,
      edge: selectedEdges[0],
      profile: "flat",
      previewMesh: structuredClone(editableMeshSource),
      startPoint: vec3(startPoint.x, startPoint.y, startPoint.z),
      steps: 1,
      width: 0
    });
  };

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!bevelState) {
        return;
      }

      event.preventDefault();
      setBevelState((current) =>
        current
          ? {
              ...current,
              previewMesh:
                bevelEditableMeshEdge(
                  current.baseMesh,
                  current.edge,
                  current.width,
                  Math.max(1, current.steps + (event.deltaY < 0 ? 1 : -1)),
                  current.profile
                ) ??
                current.previewMesh,
              steps: Math.max(1, current.steps + (event.deltaY < 0 ? 1 : -1))
            }
          : current
      );
    };

    window.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      window.removeEventListener("wheel", handleWheel);
    };
  }, [bevelState]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (activeToolId !== "mesh-edit" || !selectedNode) {
        return;
      }

      if (bevelState) {
        if (event.key === "Escape") {
          event.preventDefault();
          setBevelState(null);
          setTransformDragging(false);
        } else if (event.key.toLowerCase() === "f") {
          event.preventDefault();
          setBevelState((current) =>
            current
              ? {
                  ...current,
                  previewMesh:
                    bevelEditableMeshEdge(
                      current.baseMesh,
                      current.edge,
                      current.width,
                      current.steps,
                      current.profile === "flat" ? "round" : "flat"
                    ) ?? current.previewMesh,
                  profile: current.profile === "flat" ? "round" : "flat"
                }
              : current
          );
        }
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && meshEditMode === "face") {
        const selectedFaces = resolveSelectedEditableMeshFaceIds();

        if (selectedFaces.length > 0) {
          event.preventDefault();
          commitMeshTopology(deleteEditableMeshFaces(editableMeshSource ?? { faces: [], halfEdges: [], vertices: [] }, selectedFaces));
        }
        return;
      }

      if (event.key.toLowerCase() === "m" && meshEditMode === "face") {
        const selectedFaces = resolveSelectedEditableMeshFaceIds();

        if (selectedFaces.length > 1) {
          event.preventDefault();
          commitMeshTopology(mergeEditableMeshFaces(editableMeshSource ?? { faces: [], halfEdges: [], vertices: [] }, selectedFaces));
        }
        return;
      }

      if (event.key.toLowerCase() === "k" && meshEditMode === "edge") {
        const selectedEdges = resolveSelectedEditableMeshEdgePairs();

        if (selectedEdges.length === 2) {
          event.preventDefault();
          commitMeshTopology(cutEditableMeshBetweenEdges(editableMeshSource ?? { faces: [], halfEdges: [], vertices: [] }, selectedEdges));
        }
        return;
      }

      if (event.key.toLowerCase() === "b" && meshEditMode === "edge") {
        event.preventDefault();
        startBevelOperation();
        return;
      }

      if (event.key.toLowerCase() === "n") {
        event.preventDefault();

        if (meshEditMode === "face") {
          const selectedFaces = resolveSelectedEditableMeshFaceIds();

          if (selectedFaces.length > 0) {
            commitMeshTopology(invertEditableMeshNormals(editableMeshSource ?? { faces: [], halfEdges: [], vertices: [] }, selectedFaces));
            return;
          }
        }

        commitMeshTopology(invertEditableMeshNormals(editableMeshSource ?? { faces: [], halfEdges: [], vertices: [] }));
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeToolId, bevelState, editableMeshHandles, editableMeshSource, meshEditMode, selectedMeshNode, selectedNode, meshEditSelectionIds, brushEditHandleIds]);

  const updateBevelPreview = (clientX: number, clientY: number, bounds: DOMRect) => {
    if (!cameraRef.current || !bevelState) {
      return;
    }

    const point = projectPointerToThreePlane(
      clientX,
      clientY,
      bounds,
      cameraRef.current,
      raycasterRef.current,
      bevelState.dragPlane
    );

    if (!point) {
      return;
    }

    const width = dotVec3(
      subVec3(vec3(point.x, point.y, point.z), bevelState.startPoint),
      bevelState.dragDirection
    );

    setBevelState((currentState) => {
      if (!currentState) {
        return currentState;
      }

      const previewMesh =
        bevelEditableMeshEdge(
          currentState.baseMesh,
          currentState.edge,
          width,
          currentState.steps,
          currentState.profile
        ) ??
        currentState.previewMesh;

      return {
        ...currentState,
        previewMesh,
        width
      };
    });
  };

  const commitBevelPreview = () => {
    if (!bevelState) {
      return;
    }

    if (Math.abs(bevelState.width) <= 0.0001) {
      setBevelState(null);
      setTransformDragging(false);
      return;
    }

    setBevelState(null);
    setTransformDragging(false);
    commitMeshTopology(bevelState.previewMesh);
  };

  const updateBrushCreatePreview = (clientX: number, clientY: number, bounds: DOMRect) => {
    if (!cameraRef.current || !brushCreateState) {
      return;
    }

    if (brushCreateState.stage === "base") {
      const point = projectPointerToPlane(
        clientX,
        clientY,
        bounds,
        cameraRef.current,
        raycasterRef.current,
        brushCreateState.anchor,
        brushCreateState.basis.normal
      );

      if (!point) {
        return;
      }

      setBrushCreateState((currentState) =>
        currentState?.stage === "base"
          ? {
              ...currentState,
              currentPoint: point
            }
          : currentState
      );
      return;
    }

    const point = projectPointerToThreePlane(
      clientX,
      clientY,
      bounds,
      cameraRef.current,
      raycasterRef.current,
      brushCreateState.dragPlane
    );

    if (!point) {
      return;
    }

    const normal = new Vector3(
      brushCreateState.basis.normal.x,
      brushCreateState.basis.normal.y,
      brushCreateState.basis.normal.z
    );
    const startPoint = new Vector3(
      brushCreateState.startPoint.x,
      brushCreateState.startPoint.y,
      brushCreateState.startPoint.z
    );
    const nextHeight = snapValue(point.clone().sub(startPoint).dot(normal), viewport.grid.snapSize);

    setBrushCreateState((currentState) =>
      currentState?.stage === "height" && currentState.height !== nextHeight
        ? {
            ...currentState,
            height: nextHeight
          }
        : currentState
    );
  };

  const handleBrushCreateClick = (clientX: number, clientY: number, bounds: DOMRect) => {
    if (!cameraRef.current) {
      return;
    }

    if (!brushCreateState) {
      const hit = resolveBrushCreateSurfaceHit(
        clientX,
        clientY,
        bounds,
        cameraRef.current,
        raycasterRef.current,
        meshObjectsRef.current,
        viewport.grid.elevation
      );

      if (!hit) {
        return;
      }

      setBrushCreateState({
        anchor: hit.point,
        basis: createBrushCreateBasis(hit.normal),
        currentPoint: hit.point,
        stage: "base"
      });
      return;
    }

    if (brushCreateState.stage === "base") {
      const point =
        projectPointerToPlane(
          clientX,
          clientY,
          bounds,
          cameraRef.current,
          raycasterRef.current,
          brushCreateState.anchor,
          brushCreateState.basis.normal
        ) ?? brushCreateState.currentPoint;
      const { depth, width } = measureBrushCreateBase(
        brushCreateState.anchor,
        brushCreateState.basis,
        point,
        viewport.grid.snapSize
      );

      if (Math.abs(width) <= viewport.grid.snapSize * 0.5 || Math.abs(depth) <= viewport.grid.snapSize * 0.5) {
        return;
      }

      const center = computeBrushCreateCenter(brushCreateState.anchor, brushCreateState.basis, width, depth, 0);
      const dragPlane = createBrushCreateDragPlane(cameraRef.current, brushCreateState.basis.normal, center);
      const startPoint =
        projectPointerToThreePlane(clientX, clientY, bounds, cameraRef.current, raycasterRef.current, dragPlane) ??
        new Vector3(center.x, center.y, center.z);

      setBrushCreateState({
        ...brushCreateState,
        depth,
        dragPlane,
        height: 0,
        stage: "height",
        startPoint: vec3(startPoint.x, startPoint.y, startPoint.z),
        width
      });
      return;
    }

    const point =
      projectPointerToThreePlane(clientX, clientY, bounds, cameraRef.current, raycasterRef.current, brushCreateState.dragPlane) ??
      new Vector3(brushCreateState.startPoint.x, brushCreateState.startPoint.y, brushCreateState.startPoint.z);
    const height = snapValue(
      point
        .clone()
        .sub(new Vector3(brushCreateState.startPoint.x, brushCreateState.startPoint.y, brushCreateState.startPoint.z))
        .dot(new Vector3(brushCreateState.basis.normal.x, brushCreateState.basis.normal.y, brushCreateState.basis.normal.z)),
      viewport.grid.snapSize
    );
    const placement = buildBrushCreatePlacement({
      ...brushCreateState,
      height
    });

    if (!placement) {
      return;
    }

    onPlaceBrush(placement.brush, placement.transform);
    setBrushCreateState(null);
  };

  const handlePointerDown: React.PointerEventHandler<HTMLDivElement> = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerPositionRef.current = new Vector2(event.clientX - bounds.left, event.clientY - bounds.top);

    if (bevelState) {
      return;
    }

    if (activeToolId === "brush" && event.button === 0 && !event.shiftKey) {
      brushClickOriginRef.current = new Vector2(event.clientX - bounds.left, event.clientY - bounds.top);
      return;
    }

    if (event.button !== 0 || !event.shiftKey) {
      return;
    }

    const point = new Vector2(event.clientX - bounds.left, event.clientY - bounds.top);
    marqueeOriginRef.current = point;
  };

  const handlePointerMove: React.PointerEventHandler<HTMLDivElement> = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerPositionRef.current = new Vector2(event.clientX - bounds.left, event.clientY - bounds.top);

    if (bevelState) {
      updateBevelPreview(event.clientX, event.clientY, bounds);
      return;
    }

    if (activeToolId === "brush") {
      if (brushCreateState) {
        updateBrushCreatePreview(event.clientX, event.clientY, bounds);
      }
      return;
    }

    if (!marqueeOriginRef.current) {
      return;
    }

    const point = new Vector2(event.clientX - bounds.left, event.clientY - bounds.top);
    const origin = marqueeOriginRef.current;
    const distance = point.distanceTo(origin);

    if (!marquee && distance < 4) {
      return;
    }

    setMarquee({
      active: true,
      current: point,
      origin
    });
  };

  const handlePointerUp: React.PointerEventHandler<HTMLDivElement> = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerPositionRef.current = new Vector2(event.clientX - bounds.left, event.clientY - bounds.top);

    if (bevelState) {
      if (event.button === 0) {
        commitBevelPreview();
      }
      return;
    }

    if (activeToolId === "brush") {
      const origin = brushClickOriginRef.current;
      brushClickOriginRef.current = null;

      if (!origin) {
        return;
      }

      const point = new Vector2(event.clientX - bounds.left, event.clientY - bounds.top);

      if (point.distanceTo(origin) > 4) {
        return;
      }

      handleBrushCreateClick(event.clientX, event.clientY, bounds);
      return;
    }

    if (!marqueeOriginRef.current) {
      return;
    }

    const origin = marqueeOriginRef.current;
    marqueeOriginRef.current = null;

    if (!marquee) {
      return;
    }

    const point = new Vector2(event.clientX - bounds.left, event.clientY - bounds.top);
    const finalMarquee = {
      ...marquee,
      current: point,
      origin
    };

    setMarquee(null);

    if (!cameraRef.current) {
      return;
    }

    const selectionRect = createScreenRect(finalMarquee.origin, finalMarquee.current);

    if (selectionRect.width < 4 && selectionRect.height < 4) {
      return;
    }

    if (activeToolId === "mesh-edit" && selectedNode) {
      const handleSelections = (selectedBrushNode ? brushEditHandles : meshEditHandles)
        .filter((handle) =>
          rectContainsPoint(
            selectionRect,
            projectLocalPointToScreen(handle.position, selectedNode, cameraRef.current!, bounds)
          )
        )
        .map((handle) => handle.id);

      if (handleSelections.length > 0) {
        if (selectedBrushNode) {
          setBrushEditHandleIds(handleSelections);
        } else {
          setMeshEditSelectionIds(handleSelections);
        }
        return;
      }
    }

    const selectedIds = Array.from(meshObjectsRef.current.entries())
      .filter(([, object]) => intersectsSelectionRect(object, cameraRef.current!, bounds, selectionRect))
      .map(([nodeId]) => nodeId);

    if (selectedIds.length > 0) {
      onSelectNodes(selectedIds);
      return;
    }

    onClearSelection();
  };

  const marqueeRect = marquee ? createScreenRect(marquee.origin, marquee.current) : undefined;

  return (
    <div
      className="relative size-full overflow-hidden"
      ref={viewportRootRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <Canvas
        camera={{
          far: viewport.camera.far,
          fov: viewport.camera.fov,
          near: viewport.camera.near,
          position: toTuple(viewport.camera.position)
        }}
        gl={async (props) => {
          const renderer = new WebGPURenderer(props as ConstructorParameters<typeof WebGPURenderer>[0]);
          await renderer.init();
          return renderer;
        }}
        onCreated={(state: RootState) => {
          cameraRef.current = state.camera as PerspectiveCamera;
        }}
        onPointerMissed={() => {
          if (activeToolId === "brush") {
            return;
          }

          if (bevelState) {
            return;
          }

          if (marqueeOriginRef.current || marquee) {
            return;
          }

          if (activeToolId === "mesh-edit" && (meshEditSelectionIds.length > 0 || brushEditHandleIds.length > 0)) {
            setMeshEditSelectionIds([]);
            setBrushEditHandleIds([]);
            return;
          }

          onClearSelection();
        }}
        shadows
      >
        <color attach="background" args={["#0b1118"]} />
        <fog attach="fog" args={["#0b1118", 45, 180]} />
        <ambientLight intensity={0.45} />
        <hemisphereLight args={["#9ec5f8", "#0f1721", 0.7]} />
        <directionalLight
          castShadow
          intensity={1.4}
          position={[18, 26, 12]}
          shadow-bias={-0.0002}
          shadow-mapSize-height={2048}
          shadow-mapSize-width={2048}
          shadow-normalBias={0.045}
        />
        <EditorCameraRig controlsEnabled={!marquee && !transformDragging && !brushCreateState && !bevelState} viewport={viewport} />
        <ConstructionGrid activeToolId={activeToolId} onPlaceAsset={onPlaceAsset} viewport={viewport} />
        <axesHelper args={[3]} />
        <ScenePreview
          hiddenNodeIds={bevelState && selectedNode ? [selectedNode.id] : []}
          interactive={activeToolId !== "brush"}
          onFocusNode={onFocusNode}
          onMeshObjectChange={handleMeshObjectChange}
          onSelectNode={onSelectNodes}
          renderScene={renderScene}
          selectedNodeIds={selectedNodeIds}
        />
        {bevelState && selectedNode ? <EditableMeshPreviewOverlay mesh={bevelState.previewMesh} node={selectedNode} /> : null}
        {activeToolId === "brush" && brushCreateState ? (
          <BrushCreatePreview snapSize={viewport.grid.snapSize} state={brushCreateState} />
        ) : null}
        {activeToolId === "clip" && selectedBrushNode ? (
          <BrushClipOverlay
            node={selectedBrushNode}
            onSplitBrushAtCoordinate={onSplitBrushAtCoordinate}
            viewport={viewport}
          />
        ) : null}
        {activeToolId === "extrude" && selectedBrushNode ? (
          <BrushExtrudeOverlay
            node={selectedBrushNode}
            onPreviewBrushData={onPreviewBrushData}
            onUpdateBrushData={onUpdateBrushData}
            setTransformDragging={setTransformDragging}
            viewport={viewport}
          />
        ) : null}
        {activeToolId === "mesh-edit" && selectedBrushNode && !bevelState ? (
          <BrushEditOverlay
            handles={brushEditHandles}
            meshEditMode={meshEditMode}
            node={selectedBrushNode}
            onPreviewBrushData={onPreviewBrushData}
            onUpdateBrushData={onUpdateBrushData}
            selectedHandleIds={brushEditHandleIds}
            setSelectedHandleIds={setBrushEditHandleIds}
            transformMode={transformMode}
            viewport={viewport}
          />
        ) : null}
        {activeToolId === "mesh-edit" && selectedMeshNode && !bevelState ? (
          <MeshEditOverlay
            handles={meshEditHandles}
            meshEditMode={meshEditMode}
            node={selectedMeshNode}
            onPreviewMeshData={onPreviewMeshData}
            onUpdateMeshData={onUpdateMeshData}
            selectedHandleIds={meshEditSelectionIds}
            setSelectedHandleIds={setMeshEditSelectionIds}
            transformMode={transformMode}
            viewport={viewport}
          />
        ) : null}
        <ObjectTransformGizmo
          activeToolId={activeToolId}
          onPreviewNodeTransform={onPreviewNodeTransform}
          onUpdateNodeTransform={onUpdateNodeTransform}
          selectedNodeIds={selectedNodeIds}
          transformMode={transformMode}
          viewport={viewport}
        />
      </Canvas>

      {bevelState ? <div className="pointer-events-none absolute inset-0 z-20 cursor-crosshair" /> : null}

      {marqueeRect ? (
        <div
          className="pointer-events-none absolute rounded-sm bg-emerald-400/12 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.75)]"
          style={{
            height: marqueeRect.height,
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width
          }}
        />
      ) : null}
    </div>
  );
}

function objectToTransform(object: Object3D): Transform {
  return {
    position: vec3(object.position.x, object.position.y, object.position.z),
    rotation: vec3(object.rotation.x, object.rotation.y, object.rotation.z),
    scale: vec3(object.scale.x, object.scale.y, object.scale.z)
  };
}

function createScreenRect(origin: Vector2, current: Vector2) {
  return {
    height: Math.abs(current.y - origin.y),
    left: Math.min(origin.x, current.x),
    top: Math.min(origin.y, current.y),
    width: Math.abs(current.x - origin.x)
  };
}

function intersectsSelectionRect(
  object: Mesh,
  camera: PerspectiveCamera,
  viewportBounds: DOMRect,
  selectionRect: ReturnType<typeof createScreenRect>
): boolean {
  tempBox.setFromObject(object);

  if (tempBox.isEmpty()) {
    return false;
  }

  const screenRect = projectBoxToScreenRect(tempBox, camera, viewportBounds);
  return rectsIntersect(screenRect, selectionRect);
}

function projectBoxToScreenRect(box: Box3, camera: PerspectiveCamera, viewportBounds: DOMRect) {
  const min = box.min;
  const max = box.max;
  const corners = [
    [min.x, min.y, min.z],
    [min.x, min.y, max.z],
    [min.x, max.y, min.z],
    [min.x, max.y, max.z],
    [max.x, min.y, min.z],
    [max.x, min.y, max.z],
    [max.x, max.y, min.z],
    [max.x, max.y, max.z]
  ];

  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  corners.forEach(([x, y, z]) => {
    projectedPoint.set(x, y, z).project(camera);
    const screenX = ((projectedPoint.x + 1) * 0.5) * viewportBounds.width;
    const screenY = ((1 - projectedPoint.y) * 0.5) * viewportBounds.height;

    left = Math.min(left, screenX);
    right = Math.max(right, screenX);
    top = Math.min(top, screenY);
    bottom = Math.max(bottom, screenY);
  });

  return {
    height: Math.max(0, bottom - top),
    left,
    top,
    width: Math.max(0, right - left)
  };
}

function rectsIntersect(
  left: ReturnType<typeof createScreenRect>,
  right: ReturnType<typeof createScreenRect>
) {
  return !(
    left.left + left.width < right.left ||
    right.left + right.width < left.left ||
    left.top + left.height < right.top ||
    right.top + right.height < left.top
  );
}

function createIndexedGeometry(positions: number[], indices?: number[]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));

  if (indices) {
    geometry.setIndex(indices);
  }

  return geometry;
}

function addFaceOffset(origin: Vec3, normal: Vec3, distance: number): Vec3 {
  return vec3(origin.x + normal.x * distance, origin.y + normal.y * distance, origin.z + normal.z * distance);
}

function projectLocalPointToScreen(
  point: Vec3,
  node: GeometryNode,
  camera: PerspectiveCamera,
  viewportBounds: DOMRect
) {
  const worldPoint = new Vector3(point.x, point.y, point.z)
    .multiply(new Vector3(node.transform.scale.x, node.transform.scale.y, node.transform.scale.z))
    .applyEuler(new Euler(node.transform.rotation.x, node.transform.rotation.y, node.transform.rotation.z, "XYZ"))
    .add(new Vector3(node.transform.position.x, node.transform.position.y, node.transform.position.z))
    .project(camera);

  return {
    x: ((worldPoint.x + 1) * 0.5) * viewportBounds.width,
    y: ((1 - worldPoint.y) * 0.5) * viewportBounds.height
  };
}

function resolveBrushCreateSurfaceHit(
  clientX: number,
  clientY: number,
  viewportBounds: DOMRect,
  camera: PerspectiveCamera,
  raycaster: Raycaster,
  meshObjects: Map<string, Mesh>,
  gridElevation: number
): { normal: Vec3; point: Vec3 } | undefined {
  const ndc = new Vector2(
    ((clientX - viewportBounds.left) / viewportBounds.width) * 2 - 1,
    -(((clientY - viewportBounds.top) / viewportBounds.height) * 2 - 1)
  );
  raycaster.setFromCamera(ndc, camera);

  const hit = raycaster.intersectObjects(Array.from(meshObjects.values()), false)[0];

  if (hit) {
    const worldNormal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      : new Vector3(0, 1, 0);

    return {
      normal: vec3(worldNormal.x, worldNormal.y, worldNormal.z),
      point: vec3(hit.point.x, hit.point.y, hit.point.z)
    };
  }

  const point = raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -gridElevation), new Vector3());

  if (!point) {
    return undefined;
  }

  return {
    normal: vec3(0, 1, 0),
    point: vec3(point.x, point.y, point.z)
  };
}

function createBrushCreateBasis(normal: Vec3): BrushCreateBasis {
  const normalVector = new Vector3(normal.x, normal.y, normal.z).normalize();
  const reference = Math.abs(normalVector.y) < 0.99 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  const u = new Vector3().crossVectors(reference, normalVector).normalize();
  const v = new Vector3().crossVectors(u, normalVector).normalize();

  return {
    normal: vec3(normalVector.x, normalVector.y, normalVector.z),
    u: vec3(u.x, u.y, u.z),
    v: vec3(v.x, v.y, v.z)
  };
}

function projectPointerToPlane(
  clientX: number,
  clientY: number,
  viewportBounds: DOMRect,
  camera: PerspectiveCamera,
  raycaster: Raycaster,
  anchor: Vec3,
  normal: Vec3
): Vec3 | undefined {
  const plane = new Plane().setFromNormalAndCoplanarPoint(
    new Vector3(normal.x, normal.y, normal.z),
    new Vector3(anchor.x, anchor.y, anchor.z)
  );
  const point = projectPointerToThreePlane(clientX, clientY, viewportBounds, camera, raycaster, plane);

  return point ? vec3(point.x, point.y, point.z) : undefined;
}

function projectPointerToThreePlane(
  clientX: number,
  clientY: number,
  viewportBounds: DOMRect,
  camera: PerspectiveCamera,
  raycaster: Raycaster,
  plane: Plane
) {
  const ndc = new Vector2(
    ((clientX - viewportBounds.left) / viewportBounds.width) * 2 - 1,
    -(((clientY - viewportBounds.top) / viewportBounds.height) * 2 - 1)
  );
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(plane, new Vector3()) ?? undefined;
}

function measureBrushCreateBase(anchor: Vec3, basis: BrushCreateBasis, point: Vec3, snapSize: number) {
  const delta = subVec3(point, anchor);

  return {
    depth: snapValue(dotVec3(delta, basis.v), snapSize),
    width: snapValue(dotVec3(delta, basis.u), snapSize)
  };
}

function computeBrushCreateCenter(anchor: Vec3, basis: BrushCreateBasis, width: number, depth: number, height: number): Vec3 {
  return vec3(
    anchor.x + basis.u.x * (width * 0.5) + basis.v.x * (depth * 0.5) + basis.normal.x * (height * 0.5),
    anchor.y + basis.u.y * (width * 0.5) + basis.v.y * (depth * 0.5) + basis.normal.y * (height * 0.5),
    anchor.z + basis.u.z * (width * 0.5) + basis.v.z * (depth * 0.5) + basis.normal.z * (height * 0.5)
  );
}

function createBrushCreateDragPlane(camera: PerspectiveCamera, normal: Vec3, coplanarPoint: Vec3) {
  const axis = new Vector3(normal.x, normal.y, normal.z).normalize();
  const cameraDirection = camera.getWorldDirection(new Vector3());
  let tangent = new Vector3().crossVectors(cameraDirection, axis);

  if (tangent.lengthSq() <= 0.0001) {
    tangent = new Vector3().crossVectors(new Vector3(0, 1, 0), axis);
  }

  if (tangent.lengthSq() <= 0.0001) {
    tangent = new Vector3().crossVectors(new Vector3(1, 0, 0), axis);
  }

  const planeNormal = new Vector3().crossVectors(axis, tangent).normalize();

  return new Plane().setFromNormalAndCoplanarPoint(
    planeNormal,
    new Vector3(coplanarPoint.x, coplanarPoint.y, coplanarPoint.z)
  );
}

function buildBrushCreatePlacement(
  state: Extract<BrushCreateState, { stage: "height" }>
): { brush: Brush; transform: Transform } | undefined {
  if (Math.abs(state.width) <= 0.0001 || Math.abs(state.depth) <= 0.0001 || Math.abs(state.height) <= 0.0001) {
    return undefined;
  }

  const center = computeBrushCreateCenter(state.anchor, state.basis, state.width, state.depth, state.height);
  const rotation = basisToEuler(state.basis);

  return {
    brush: createAxisAlignedBrushFromBounds({
      x: { min: -Math.abs(state.width) * 0.5, max: Math.abs(state.width) * 0.5 },
      y: { min: -Math.abs(state.height) * 0.5, max: Math.abs(state.height) * 0.5 },
      z: { min: -Math.abs(state.depth) * 0.5, max: Math.abs(state.depth) * 0.5 }
    }),
    transform: {
      ...makeTransform(center),
      rotation
    }
  };
}

function basisToEuler(basis: BrushCreateBasis): Vec3 {
  const matrix = new Matrix4().makeBasis(
    new Vector3(basis.u.x, basis.u.y, basis.u.z),
    new Vector3(basis.normal.x, basis.normal.y, basis.normal.z),
    new Vector3(basis.v.x, basis.v.y, basis.v.z)
  );
  const quaternion = new Quaternion().setFromRotationMatrix(matrix);
  const euler = new Euler().setFromQuaternion(quaternion, "XYZ");

  return vec3(euler.x, euler.y, euler.z);
}

function buildBrushCreatePreviewPositions(state: BrushCreateState, snapSize: number): number[] {
  const positions: number[] = [];
  const base =
    state.stage === "base"
      ? measureBrushCreateBase(state.anchor, state.basis, state.currentPoint, snapSize)
      : { depth: state.depth, width: state.width };
  const baseCorners = buildBrushCreateCorners(state.anchor, state.basis, base.width, base.depth, 0);

  pushLoopSegments(positions, baseCorners);

  if (state.stage === "height" && Math.abs(state.height) > 0.0001) {
    const topCorners = buildBrushCreateCorners(state.anchor, state.basis, state.width, state.depth, state.height);
    pushLoopSegments(positions, topCorners);

    for (let index = 0; index < baseCorners.length; index += 1) {
      const bottom = baseCorners[index];
      const top = topCorners[index];
      positions.push(bottom.x, bottom.y, bottom.z, top.x, top.y, top.z);
    }
  }

  return positions;
}

function buildBrushCreateCorners(anchor: Vec3, basis: BrushCreateBasis, width: number, depth: number, height: number): Vec3[] {
  const widthOffset = vec3(basis.u.x * width, basis.u.y * width, basis.u.z * width);
  const depthOffset = vec3(basis.v.x * depth, basis.v.y * depth, basis.v.z * depth);
  const heightOffset = vec3(basis.normal.x * height, basis.normal.y * height, basis.normal.z * height);

  return [
    vec3(anchor.x + heightOffset.x, anchor.y + heightOffset.y, anchor.z + heightOffset.z),
    vec3(
      anchor.x + widthOffset.x + heightOffset.x,
      anchor.y + widthOffset.y + heightOffset.y,
      anchor.z + widthOffset.z + heightOffset.z
    ),
    vec3(
      anchor.x + widthOffset.x + depthOffset.x + heightOffset.x,
      anchor.y + widthOffset.y + depthOffset.y + heightOffset.y,
      anchor.z + widthOffset.z + depthOffset.z + heightOffset.z
    ),
    vec3(
      anchor.x + depthOffset.x + heightOffset.x,
      anchor.y + depthOffset.y + heightOffset.y,
      anchor.z + depthOffset.z + heightOffset.z
    )
  ];
}

function pushLoopSegments(positions: number[], points: Vec3[]) {
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    positions.push(current.x, current.y, current.z, next.x, next.y, next.z);
  }
}

function rectContainsPoint(rect: ReturnType<typeof createScreenRect>, point: { x: number; y: number }) {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

function makeUndirectedPairKey(pair: [string, string]) {
  return pair[0] < pair[1] ? `${pair[0]}:${pair[1]}` : `${pair[1]}:${pair[0]}`;
}

function findMatchingMeshEdgePair(
  meshHandles: ReturnType<typeof createMeshEditHandles>,
  brushHandle: BrushEditHandle,
  epsilon = 0.001
) {
  if (!brushHandle.points || brushHandle.points.length !== 2) {
    return undefined;
  }

  return meshHandles
    .filter((handle) => handle.vertexIds.length === 2 && handle.points?.length === 2)
    .find((handle) => segmentsMatch(brushHandle.points!, handle.points!, epsilon))
    ?.vertexIds as [string, string] | undefined;
}

function segmentsMatch(left: Vec3[], right: Vec3[], epsilon: number) {
  return (
    (pointsMatch(left[0], right[0], epsilon) && pointsMatch(left[1], right[1], epsilon)) ||
    (pointsMatch(left[0], right[1], epsilon) && pointsMatch(left[1], right[0], epsilon))
  );
}

function pointsMatch(left: Vec3, right: Vec3, epsilon: number) {
  return (
    Math.abs(left.x - right.x) <= epsilon &&
    Math.abs(left.y - right.y) <= epsilon &&
    Math.abs(left.z - right.z) <= epsilon
  );
}

function rejectVec3FromAxis(vector: Vec3, axis: Vec3) {
  return subVec3(vector, {
    x: axis.x * dotVec3(vector, axis),
    y: axis.y * dotVec3(vector, axis),
    z: axis.z * dotVec3(vector, axis)
  });
}

function vec3LengthSquared(vector: Vec3) {
  return vector.x * vector.x + vector.y * vector.y + vector.z * vector.z;
}
