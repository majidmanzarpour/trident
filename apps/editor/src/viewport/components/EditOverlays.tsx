import { convertBrushToEditableMesh } from "@web-hammer/geometry-kernel";
import { TransformControls } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Brush, type EditableMesh, type GeometryNode, type Transform } from "@web-hammer/shared";
import {
  applyBrushEditTransform,
  collectMeshEdgeLoop,
  applyMeshEditTransform,
  computeBrushEditSelectionCenter,
  computeMeshEditSelectionCenter,
  createMeshEditHandles,
  type BrushEditHandle,
  type MeshEditHandle,
  type MeshEditMode
} from "@/viewport/editing";
import type { ViewportCanvasProps } from "@/viewport/types";
import type { ViewportState } from "@web-hammer/render-pipeline";
import { NodeTransformGroup } from "@/viewport/components/NodeTransformGroup";
import { objectToTransform } from "@/viewport/utils/geometry";
import { findMatchingBrushEdgeHandleId, findMatchingMeshEdgePair, resolveSubobjectSelection } from "@/viewport/utils/interaction";
import {
  BrushEditHandleVisual,
  EditableEdgeSelectionHitArea,
  EditableFaceSelectionHitArea,
  MeshEditHandleVisual
} from "@/viewport/components/SelectionVisuals";
import { Object3D } from "three";
import type { LastMeshEditAction } from "@/viewport/types";

export function MeshEditOverlay({
  handles,
  meshEditMode,
  node,
  onCommitTransformAction,
  onPreviewMeshData,
  onUpdateMeshData,
  selectedHandleIds,
  setSelectedHandleIds,
  transformMode,
  viewport
}: {
  handles: MeshEditHandle[];
  meshEditMode: MeshEditMode;
  node: Extract<GeometryNode, { kind: "mesh" }>;
  onCommitTransformAction?: (action: LastMeshEditAction) => void;
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

  const resolveHandleSelection = (handle: MeshEditHandle, event: { altKey: boolean; shiftKey: boolean }) => {
    if (meshEditMode !== "edge" || !event.altKey || handle.vertexIds.length !== 2) {
      setSelectedHandleIds(resolveSubobjectSelection(selectedHandleIds, handle.id, event.shiftKey));
      return;
    }

    const loopIds = collectMeshEdgeLoop(node.data, handle.vertexIds as [string, string])
      .map((edge) => handles.find((candidate) => candidate.vertexIds.length === 2 && candidate.vertexIds.every((vertexId) => edge.includes(vertexId)))?.id)
      .filter((id): id is string => Boolean(id));

    if (!event.shiftKey) {
      setSelectedHandleIds(loopIds);
      return;
    }

    const nextSelection = loopIds.every((id) => selectedHandleIds.includes(id))
      ? selectedHandleIds.filter((id) => !loopIds.includes(id))
      : Array.from(new Set([...selectedHandleIds, ...loopIds]));

    setSelectedHandleIds(nextSelection);
  };

  return (
    <>
      <NodeTransformGroup transform={node.transform}>
        {handles.map((handle) => {
          const selected = selectedHandleIds.includes(handle.id);

          return (
            <group key={handle.id}>
              {meshEditMode === "face" && handle.points && handle.points.length >= 3 ? (
                <EditableFaceSelectionHitArea
                  normal={handle.normal}
                  onSelect={(event) => {
                    event.stopPropagation();
                    resolveHandleSelection(handle, event);
                  }}
                  points={handle.points}
                  selected={selected}
                />
              ) : null}
              {meshEditMode === "edge" && handle.points?.length === 2 ? (
                <EditableEdgeSelectionHitArea
                  onSelect={(event) => {
                    event.stopPropagation();
                    resolveHandleSelection(handle, event);
                  }}
                  points={handle.points}
                  selected={selected}
                />
              ) : null}
              <MeshEditHandleVisual
                handle={handle}
                mode={meshEditMode}
                onSelect={(event) => {
                  event.stopPropagation();
                  resolveHandleSelection(handle, event);
                }}
                selected={selected}
              />
            </group>
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
      </NodeTransformGroup>

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
            onCommitTransformAction?.({
              kind: "subobject-transform",
              mode: meshEditMode,
              rotation: objectToTransform(controlObject).rotation,
              scale: objectToTransform(controlObject).scale,
              translation: {
                x: controlObject.position.x - baselineTransformRef.current.position.x,
                y: controlObject.position.y - baselineTransformRef.current.position.y,
                z: controlObject.position.z - baselineTransformRef.current.position.z
              }
            });
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

export function BrushEditOverlay({
  handles,
  meshEditMode,
  node,
  onCommitTransformAction,
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
  onCommitTransformAction?: (action: LastMeshEditAction) => void;
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
  const editableMesh = useMemo(() => convertBrushToEditableMesh(node.data), [node.data]);
  const editableMeshHandles = useMemo(
    () => (editableMesh ? createMeshEditHandles(editableMesh, "edge") : []),
    [editableMesh]
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

  const resolveHandleSelection = (handle: BrushEditHandle, event: { altKey: boolean; shiftKey: boolean }) => {
    if (
      meshEditMode !== "edge" ||
      !event.altKey ||
      !editableMesh ||
      !handle.points ||
      handle.points.length !== 2
    ) {
      setSelectedHandleIds(resolveSubobjectSelection(selectedHandleIds, handle.id, event.shiftKey));
      return;
    }

    const edgePair = findMatchingMeshEdgePair(editableMeshHandles, handle);

    if (!edgePair) {
      setSelectedHandleIds(resolveSubobjectSelection(selectedHandleIds, handle.id, event.shiftKey));
      return;
    }

    const loopIds = collectMeshEdgeLoop(editableMesh, edgePair)
      .map((edge) =>
        editableMeshHandles.find(
          (candidate) => candidate.vertexIds.length === 2 && candidate.vertexIds.every((vertexId) => edge.includes(vertexId))
        )
      )
      .map((meshHandle) => (meshHandle ? findMatchingBrushEdgeHandleId(handles, meshHandle) : undefined))
      .filter((id): id is string => Boolean(id));

    if (!event.shiftKey) {
      setSelectedHandleIds(loopIds);
      return;
    }

    const nextSelection = loopIds.every((id) => selectedHandleIds.includes(id))
      ? selectedHandleIds.filter((id) => !loopIds.includes(id))
      : Array.from(new Set([...selectedHandleIds, ...loopIds]));

    setSelectedHandleIds(nextSelection);
  };

  return (
    <>
      <NodeTransformGroup transform={node.transform}>
        {handles.map((handle) => {
          const selected = selectedHandleIds.includes(handle.id);

          return (
            <group key={handle.id}>
              {meshEditMode === "face" && handle.points && handle.points.length >= 3 ? (
                <EditableFaceSelectionHitArea
                  normal={handle.normal}
                  onSelect={(event) => {
                    event.stopPropagation();
                    resolveHandleSelection(handle, event);
                  }}
                  points={handle.points}
                  selected={selected}
                />
              ) : null}
              {meshEditMode === "edge" && handle.points?.length === 2 ? (
                <EditableEdgeSelectionHitArea
                  onSelect={(event) => {
                    event.stopPropagation();
                    resolveHandleSelection(handle, event);
                  }}
                  points={handle.points}
                  selected={selected}
                />
              ) : null}
              <BrushEditHandleVisual
                handle={handle}
                mode={meshEditMode}
                onSelect={(event) => {
                  event.stopPropagation();
                  resolveHandleSelection(handle, event);
                }}
                selected={selected}
              />
            </group>
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
      </NodeTransformGroup>

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
              onCommitTransformAction?.({
                kind: "subobject-transform",
                mode: meshEditMode,
                rotation: objectToTransform(controlObject).rotation,
                scale: objectToTransform(controlObject).scale,
                translation: {
                  x: controlObject.position.x - baselineTransformRef.current.position.x,
                  y: controlObject.position.y - baselineTransformRef.current.position.y,
                  z: controlObject.position.z - baselineTransformRef.current.position.z
                }
              });
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
