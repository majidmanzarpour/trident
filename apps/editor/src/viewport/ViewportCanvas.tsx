import { useEffect, useMemo, useRef, useState } from "react";
import { OrbitControls, TransformControls } from "@react-three/drei";
import { Canvas, type RootState, useThree } from "@react-three/fiber";
import { WebGPURenderer } from "three/webgpu";
import { reconstructBrushFaces, type ReconstructedBrushFace } from "@web-hammer/geometry-kernel";
import {
  disableBvhRaycast,
  enableBvhRaycast,
  type DerivedRenderMesh,
  type DerivedRenderScene,
  type ViewportState
} from "@web-hammer/render-pipeline";
import {
  dotVec3,
  isBrushNode,
  isMeshNode,
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
  Mesh,
  Object3D,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  type PerspectiveCamera
} from "three";

type ViewportCanvasProps = {
  activeToolId: ToolId;
  meshEditMode: MeshEditMode;
  onClearSelection: () => void;
  onFocusNode: (nodeId: string) => void;
  onPlaceAsset: (position: { x: number; y: number; z: number }) => void;
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
  mesh,
  onFocusNode,
  onHoverEnd,
  onHoverStart,
  onMeshObjectChange,
  onSelectNodes,
  selected
}: {
  hovered: boolean;
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
    side: DoubleSide,
    emissive: selected ? "#f69036" : hovered ? "#2a7f74" : "#000000",
    emissiveIntensity: selected ? 0.42 : hovered ? 0.16 : 0
  };

  return (
    <mesh
      castShadow
      name={`node:${mesh.nodeId}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelectNodes([mesh.nodeId]);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onFocusNode(mesh.nodeId);
      }}
      onPointerOut={(event) => {
        event.stopPropagation();
        onHoverEnd();
      }}
      onPointerOver={(event) => {
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
  onFocusNode,
  onMeshObjectChange,
  onSelectNode,
  renderScene,
  selectedNodeIds
}: {
  onFocusNode: (nodeId: string) => void;
  onMeshObjectChange: (nodeId: string, object: Mesh | null) => void;
  onSelectNode: (nodeIds: string[]) => void;
  renderScene: DerivedRenderScene;
  selectedNodeIds: string[];
}) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string>();

  return (
    <>
      {renderScene.meshes.map((mesh) => (
        <RenderPrimitive
          hovered={hoveredNodeId === mesh.nodeId}
          key={mesh.nodeId}
          mesh={mesh}
          onFocusNode={onFocusNode}
          onHoverEnd={() => setHoveredNodeId(undefined)}
          onHoverStart={setHoveredNodeId}
          onMeshObjectChange={onMeshObjectChange}
          onSelectNodes={onSelectNode}
          selected={selectedNodeIds.includes(mesh.nodeId)}
        />
      ))}

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

export function ViewportCanvas({
  activeToolId,
  meshEditMode,
  onClearSelection,
  onFocusNode,
  onPlaceAsset,
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
  const marqueeOriginRef = useRef<Vector2 | null>(null);
  const meshObjectsRef = useRef(new Map<string, Mesh>());
  const [brushEditHandleIds, setBrushEditHandleIds] = useState<string[]>([]);
  const [meshEditSelectionIds, setMeshEditSelectionIds] = useState<string[]>([]);
  const [transformDragging, setTransformDragging] = useState(false);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);

  useEffect(() => {
    setMeshEditSelectionIds([]);
    setBrushEditHandleIds([]);
  }, [activeToolId, meshEditMode, selectedNode?.id]);

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

  const handleMeshObjectChange = (nodeId: string, object: Mesh | null) => {
    if (object) {
      meshObjectsRef.current.set(nodeId, object);
      return;
    }

    meshObjectsRef.current.delete(nodeId);
  };

  const handlePointerDown: React.PointerEventHandler<HTMLDivElement> = (event) => {
    if (event.button !== 0 || !event.shiftKey) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const point = new Vector2(event.clientX - bounds.left, event.clientY - bounds.top);
    marqueeOriginRef.current = point;
  };

  const handlePointerMove: React.PointerEventHandler<HTMLDivElement> = (event) => {
    if (!marqueeOriginRef.current) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
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
    if (!marqueeOriginRef.current) {
      return;
    }

    const origin = marqueeOriginRef.current;
    marqueeOriginRef.current = null;

    if (!marquee) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
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
        <EditorCameraRig controlsEnabled={!marquee && !transformDragging} viewport={viewport} />
        <ConstructionGrid activeToolId={activeToolId} onPlaceAsset={onPlaceAsset} viewport={viewport} />
        <axesHelper args={[3]} />
        <ScenePreview
          onFocusNode={onFocusNode}
          onMeshObjectChange={handleMeshObjectChange}
          onSelectNode={onSelectNodes}
          renderScene={renderScene}
          selectedNodeIds={selectedNodeIds}
        />
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
        {activeToolId === "mesh-edit" && selectedBrushNode ? (
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
        {activeToolId === "mesh-edit" && selectedMeshNode ? (
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

function rectContainsPoint(rect: ReturnType<typeof createScreenRect>, point: { x: number; y: number }) {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}
