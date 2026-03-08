import type { Asset, Entity, GeometryNode, LightNodeData, Material, Vec3 } from "@web-hammer/shared";
import { isLightNode, vec3 } from "@web-hammer/shared";
import { createDerivedRenderMesh, type DerivedRenderMesh } from "../meshes/render-mesh";

export type DerivedEntityMarker = {
  entityId: Entity["id"];
  entityType: Entity["type"];
  label: string;
  position: Vec3;
  rotation: Vec3;
  color: string;
};

export type DerivedLight = {
  color: string;
  data: LightNodeData;
  nodeId: string;
  position: Vec3;
  rotation: Vec3;
};

export type DerivedRenderScene = {
  lights: DerivedLight[];
  meshes: DerivedRenderMesh[];
  entityMarkers: DerivedEntityMarker[];
  boundsCenter: Vec3;
};

export function deriveRenderScene(
  nodes: Iterable<GeometryNode>,
  entities: Iterable<Entity> = [],
  materials: Iterable<Material> = [],
  assets: Iterable<Asset> = []
): DerivedRenderScene {
  const materialsById = new Map(Array.from(materials, (material) => [material.id, material]));
  const assetsById = new Map(Array.from(assets, (asset) => [asset.id, asset]));
  const sourceNodes = Array.from(nodes);
  const meshes = sourceNodes
    .filter((node) => !isLightNode(node))
    .map((node) => createDerivedRenderMesh(node, materialsById, assetsById));
  const lights = sourceNodes
    .filter(isLightNode)
    .map((node) => ({
      color: node.data.color,
      data: node.data,
      nodeId: node.id,
      position: node.transform.position,
      rotation: node.transform.rotation
    }));
  const entityMarkers = Array.from(entities, (entity) => ({
    entityId: entity.id,
    entityType: entity.type,
    label: entity.name,
    position: entity.transform.position,
    rotation: entity.transform.rotation,
    color:
      entity.type === "player-spawn"
        ? "#7dd3fc"
        : entity.type === "npc-spawn"
          ? "#fbbf24"
          : "#c084fc"
  }));

  if (meshes.length === 0) {
    return {
      lights,
      meshes,
      entityMarkers,
      boundsCenter: vec3(0, 0, 0)
    };
  }

  const center = meshes.reduce(
    (accumulator, mesh) => ({
      x: accumulator.x + mesh.position.x,
      y: accumulator.y + mesh.position.y,
      z: accumulator.z + mesh.position.z
    }),
    vec3(0, 0, 0)
  );

  return {
    lights,
    meshes,
    entityMarkers,
    boundsCenter: vec3(center.x / meshes.length, center.y / meshes.length, center.z / meshes.length)
  };
}
