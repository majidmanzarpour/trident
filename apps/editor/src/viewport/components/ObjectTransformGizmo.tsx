import { TransformControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useRef } from "react";
import type { GeometryNode, Transform } from "@web-hammer/shared";
import { resolveTransformPivot } from "@web-hammer/shared";
import { objectToTransform } from "@/viewport/utils/geometry";
import type { ViewportCanvasProps } from "@/viewport/types";

export function ObjectTransformGizmo({
  activeToolId,
  onPreviewNodeTransform,
  onUpdateNodeTransform,
  selectedNode,
  selectedNodeIds,
  transformMode,
  viewport
}: Pick<
  ViewportCanvasProps,
  "activeToolId" | "onPreviewNodeTransform" | "onUpdateNodeTransform" | "selectedNodeIds" | "transformMode" | "viewport"
> & {
  selectedNode?: GeometryNode;
}) {
  const baselineTransformRef = useRef<Transform | undefined>(undefined);
  const scene = useThree((state) => state.scene);
  const selectedNodeId = selectedNode?.id ?? selectedNodeIds[0];
  const selectedObject = selectedNodeId ? scene.getObjectByName(`node:${selectedNodeId}`) : undefined;

  if (activeToolId !== "transform" || !selectedNodeId || !selectedObject || !selectedNode) {
    return null;
  }

  const pivot = resolveTransformPivot(selectedNode.transform);

  return (
    <TransformControls
      enabled
      mode={transformMode}
      object={selectedObject}
      onMouseDown={() => {
        baselineTransformRef.current = objectToTransform(selectedObject, pivot);
      }}
      onMouseUp={() => {
        if (!baselineTransformRef.current) {
          return;
        }

        onUpdateNodeTransform(selectedNodeId, objectToTransform(selectedObject, pivot), baselineTransformRef.current);
        baselineTransformRef.current = undefined;
      }}
      onObjectChange={() => {
        onPreviewNodeTransform(selectedNodeId, objectToTransform(selectedObject, pivot));
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
