import { triangulatePolygon3D, type ReconstructedBrushFace } from "@web-hammer/geometry-kernel";
import { averageVec3, normalizeVec3, toTuple, vec3, type Vec3 } from "@web-hammer/shared";
import { useEffect, useMemo } from "react";
import { DoubleSide, Quaternion, Vector3 } from "three";
import type { BrushEditHandle, MeshEditHandle, MeshEditMode } from "@/viewport/editing";
import { createIndexedGeometry } from "@/viewport/utils/geometry";

export function FaceHitArea({
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

export function EditableFaceSelectionHitArea({
  normal,
  onSelect,
  onHover,
  onHoverEnd,
  onSelectPoint,
  points,
  selected
}: {
  normal?: Vec3;
  onSelect: (event: any) => void;
  onHover?: (point: Vec3) => void;
  onHoverEnd?: () => void;
  onSelectPoint?: (point: Vec3, event: any) => void;
  points: Vec3[];
  selected: boolean;
}) {
  const geometry = useMemo(() => {
    const faceNormal = normalizeVec3(normal ?? vec3(0, 0, 1));
    const positions = points.flatMap((point) => [
      point.x + faceNormal.x * 0.01,
      point.y + faceNormal.y * 0.01,
      point.z + faceNormal.z * 0.01
    ]);
    const indices = triangulatePolygon3D(points, normal ?? faceNormal);

    return indices.length >= 3 ? createIndexedGeometry(positions, indices) : undefined;
  }, [normal, points]);

  if (!geometry) {
    return null;
  }

  return (
    <mesh
      geometry={geometry}
      onClick={(event) => {
        if (!onSelectPoint) {
          onSelect(event);
          return;
        }

        event.stopPropagation();
        const localPoint = event.object.worldToLocal(event.point.clone());
        onSelectPoint(vec3(localPoint.x, localPoint.y, localPoint.z), event);
      }}
      onPointerMove={(event) => {
        if (!onHover) {
          return;
        }

        event.stopPropagation();
        const localPoint = event.object.worldToLocal(event.point.clone());
        onHover(vec3(localPoint.x, localPoint.y, localPoint.z));
      }}
      onPointerOut={(event) => {
        if (!onHoverEnd) {
          return;
        }

        event.stopPropagation();
        onHoverEnd();
      }}
      renderOrder={7}
    >
      <meshBasicMaterial
        color="#93c5fd"
        depthWrite={false}
        opacity={selected ? 0.08 : 0.018}
        side={DoubleSide}
        transparent
      />
    </mesh>
  );
}

export function EditableEdgeSelectionHitArea({
  onSelect,
  points,
  selected
}: {
  onSelect: (event: any) => void;
  points: Vec3[];
  selected: boolean;
}) {
  const midpoint = useMemo(() => averageVec3(points), [points]);
  const quaternion = useMemo(() => {
    if (points.length !== 2) {
      return new Quaternion();
    }

    const direction = new Vector3(
      points[1].x - points[0].x,
      points[1].y - points[0].y,
      points[1].z - points[0].z
    );

    if (direction.lengthSq() <= 0.000001) {
      return new Quaternion();
    }

    return new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize());
  }, [points]);
  const length = useMemo(() => {
    if (points.length !== 2) {
      return 0;
    }

    return new Vector3(
      points[1].x - points[0].x,
      points[1].y - points[0].y,
      points[1].z - points[0].z
    ).length();
  }, [points]);

  if (length <= 0.0001) {
    return null;
  }

  return (
    <mesh onClick={onSelect} position={toTuple(midpoint)} quaternion={quaternion} renderOrder={7}>
      <cylinderGeometry args={[selected ? 0.1 : 0.085, selected ? 0.1 : 0.085, length, 6]} />
      <meshBasicMaterial color="#93c5fd" depthWrite={false} opacity={selected ? 0.12 : 0.025} transparent />
    </mesh>
  );
}

export function MeshEditHandleVisual({
  handle,
  mode,
  onSelect,
  selected
}: {
  handle: MeshEditHandle;
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

export function BrushEditHandleVisual({
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

export function ClosedPolyline({
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

  return (
    <lineSegments geometry={geometry} renderOrder={10}>
      <lineBasicMaterial color={color} depthWrite={false} opacity={0.9} toneMapped={false} transparent />
    </lineSegments>
  );
}

export function PreviewLine({
  color,
  end,
  start
}: {
  color: string;
  end: Vec3;
  start: Vec3;
}) {
  const geometry = useMemo(() => createIndexedGeometry([start.x, start.y, start.z, end.x, end.y, end.z]), [end, start]);

  return (
    <lineSegments geometry={geometry} renderOrder={10}>
      <lineBasicMaterial color={color} depthWrite={false} linewidth={2} toneMapped={false} />
    </lineSegments>
  );
}
