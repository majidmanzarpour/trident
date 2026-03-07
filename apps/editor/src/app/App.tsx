import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useSnapshot } from "valtio";
import {
  axisDelta,
  createAssignMaterialToBrushesCommand,
  createDeleteSelectionCommand,
  createExtrudeBrushNodesCommand,
  createDuplicateNodesCommand,
  createEditorCore,
  createReplaceNodesCommand,
  createSetBrushDataCommand,
  createSetMeshDataCommand,
  type SceneDocumentSnapshot,
  createSetNodeTransformCommand,
  createPlaceEntityCommand,
  createMeshInflateCommand,
  createMeshRaiseTopCommand,
  createMirrorNodesCommand,
  createPlaceBrushNodeCommand,
  createPlaceModelNodeCommand,
  createSeedSceneDocument,
  createSplitBrushNodeAtCoordinateCommand,
  createSplitBrushNodesCommand,
  createTranslateNodesCommand,
  type TransformAxis
} from "@web-hammer/editor-core";
import { convertBrushToEditableMesh, invertEditableMeshNormals } from "@web-hammer/geometry-kernel";
import { deriveRenderScene, gridSnapValues } from "@web-hammer/render-pipeline";
import {
  addVec3,
  type GeometryNode,
  isBrushNode,
  isMeshNode,
  makeTransform,
  type MeshNode,
  snapVec3,
  subVec3,
  vec3,
  type Brush,
  type EditableMesh,
  type Vec3
} from "@web-hammer/shared";
import { createToolSession, defaultToolId, defaultTools, type ToolId } from "@web-hammer/tool-system";
import {
  createWorkerTaskManager,
  type WorkerJob,
  type WorkerRequest,
  type WorkerResponse
} from "@web-hammer/workers";
import { EditorShell } from "@/components/EditorShell";
import { uiStore } from "@/state/ui-store";
import type { Transform } from "@web-hammer/shared";
import type { MeshEditMode } from "@/viewport/editing";

type ExportWorkerRequest = WorkerRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, "id">
    : never
  : never;

export function App() {
  const [editor] = useState(() => createEditorCore(createSeedSceneDocument()));
  const [activeToolId, setActiveToolId] = useState<ToolId>(defaultToolId);
  const [meshEditMode, setMeshEditMode] = useState<MeshEditMode>("vertex");
  const [transformMode, setTransformMode] = useState<"rotate" | "scale" | "translate">("translate");
  const [workerManager] = useState(() => createWorkerTaskManager());
  const [workerJobs, setWorkerJobs] = useState<WorkerJob[]>([]);
  const [exportJobs, setExportJobs] = useState<WorkerJob[]>([]);
  const [, setRevision] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const requestCounterRef = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  const pendingRequestsRef = useRef(
    new Map<
      string,
      {
        reject: (reason?: unknown) => void;
        resolve: (payload: string | SceneDocumentSnapshot) => void;
      }
    >()
  );
  const ui = useSnapshot(uiStore);
  const toolSession = useMemo(() => createToolSession(activeToolId), [activeToolId]);
  const renderScene = deriveRenderScene(
    editor.scene.nodes.values(),
    editor.scene.entities.values(),
    editor.scene.materials.values(),
    editor.scene.assets.values()
  );

  useEffect(() => {
    const unsubscribeScene = editor.events.on("scene:changed", () => {
      setRevision((revision) => revision + 1);
    });
    const unsubscribeSelection = editor.events.on("selection:changed", () => {
      setRevision((revision) => revision + 1);
    });

    if (editor.selection.ids.length === 0) {
      const firstNode = editor.scene.nodes.values().next().value;

      if (firstNode) {
        editor.select([firstNode.id], "object");
      }
    }

    return () => {
      unsubscribeScene();
      unsubscribeSelection();
    };
  }, [editor]);

  useEffect(() => workerManager.subscribe(setWorkerJobs), [workerManager]);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/editor.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = pendingRequestsRef.current.get(response.id);

      if (!pending) {
        return;
      }

      pendingRequestsRef.current.delete(response.id);
      setExportJobs((jobs) =>
        jobs.map((job) => (job.id === response.id ? { ...job, status: response.ok ? "completed" : "completed" } : job))
      );

      window.setTimeout(() => {
        setExportJobs((jobs) => jobs.filter((job) => job.id !== response.id));
      }, 1200);

      if (response.ok) {
        pending.resolve(response.payload);
      } else {
        pending.reject(new Error(response.error));
      }
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const handleSelectNodes = (nodeIds: string[]) => {
    editor.select(nodeIds, "object");
  };

  const handleSetToolId = (toolId: ToolId) => {
    setActiveToolId(toolId);
  };

  const handleSetRightPanel = (panel: "inspector" | "materials") => {
    uiStore.rightPanel = panel;
  };

  const handleClearSelection = () => {
    editor.clearSelection();
  };

  const handleFocusNode = (nodeId: string) => {
    const node = editor.scene.getNode(nodeId);

    if (!node) {
      return;
    }

    const currentTarget = uiStore.viewport.camera.target;
    const currentPosition = uiStore.viewport.camera.position;
    const orbitOffset = subVec3(currentPosition, currentTarget);

    uiStore.viewport.camera.target = vec3(
      node.transform.position.x,
      node.transform.position.y,
      node.transform.position.z
    );
    uiStore.viewport.camera.position = addVec3(node.transform.position, orbitOffset);
  };

  const handleSetSnapSize = (snapSize: (typeof gridSnapValues)[number]) => {
    uiStore.viewport.grid.snapSize = snapSize;
  };

  const handleUpdateNodeTransform = (
    nodeId: string,
    transform: Parameters<typeof createSetNodeTransformCommand>[2],
    beforeTransform?: Parameters<typeof createSetNodeTransformCommand>[3]
  ) => {
    const node = editor.scene.getNode(nodeId);

    if (!node) {
      return;
    }

    editor.execute(createSetNodeTransformCommand(editor.scene, nodeId, transform, beforeTransform));
    enqueueWorkerJob("Transform update", { task: node.kind === "mesh" ? "triangulation" : "brush-rebuild", worker: "geometryWorker" }, 550);
  };

  const handlePreviewBrushData = (nodeId: string, brush: Brush) => {
    const node = editor.scene.getNode(nodeId);

    if (!node || !isBrushNode(node)) {
      return;
    }

    node.data = structuredClone(brush);
    editor.scene.touch();
    setRevision((revision) => revision + 1);
  };

  const handleUpdateBrushData = (nodeId: string, brush: Brush, beforeBrush?: Brush) => {
    const node = editor.scene.getNode(nodeId);

    if (!node || !isBrushNode(node)) {
      return;
    }

    editor.execute(createSetBrushDataCommand(editor.scene, nodeId, brush, beforeBrush));
    enqueueWorkerJob("Brush edit", { task: "brush-rebuild", worker: "geometryWorker" }, 700);
  };

  const handleSplitBrushAtCoordinate = (nodeId: string, axis: TransformAxis, coordinate: number) => {
    const { command, splitIds } = createSplitBrushNodeAtCoordinateCommand(editor.scene, nodeId, axis, coordinate);

    if (splitIds.length === 0) {
      return;
    }

    editor.execute(command);
    editor.select(splitIds, "object");
    enqueueWorkerJob("Clip brush", { task: "clip", worker: "geometryWorker" }, 950);
  };

  const handlePreviewMeshData = (nodeId: string, mesh: EditableMesh) => {
    const node = editor.scene.getNode(nodeId);

    if (!node || !isMeshNode(node)) {
      return;
    }

    node.data = structuredClone(mesh);
    editor.scene.touch();
    setRevision((revision) => revision + 1);
  };

  const handleUpdateMeshData = (nodeId: string, mesh: EditableMesh, beforeMesh?: EditableMesh) => {
    const node = editor.scene.getNode(nodeId);

    if (!node || !isMeshNode(node)) {
      return;
    }

    editor.execute(createSetMeshDataCommand(editor.scene, nodeId, mesh, beforeMesh));
    enqueueWorkerJob("Mesh edit", { task: "triangulation", worker: "meshWorker" }, 800);
  };

  const handlePreviewNodeTransform = (nodeId: string, transform: Transform) => {
    const node = editor.scene.getNode(nodeId);

    if (!node) {
      return;
    }

    node.transform = structuredClone(transform);
    editor.scene.touch();
    setRevision((revision) => revision + 1);
  };

  const enqueueWorkerJob = (label: string, task: Parameters<typeof workerManager.enqueue>[0], durationMs?: number) => {
    workerManager.enqueue(task, label, durationMs);
  };

  const handleTranslateSelection = (axis: TransformAxis, direction: -1 | 1) => {
    if (editor.selection.ids.length === 0) {
      return;
    }

    const delta = axisDelta(axis, uiStore.viewport.grid.snapSize * direction);
    editor.execute(createTranslateNodesCommand(editor.selection.ids, delta));
    enqueueWorkerJob("Geometry rebuild", { task: "brush-rebuild", worker: "geometryWorker" }, 700);
  };

  const handleDuplicateSelection = () => {
    if (editor.selection.ids.length === 0) {
      return;
    }

    const { command, duplicateIds } = createDuplicateNodesCommand(
      editor.scene,
      editor.selection.ids,
      axisDelta("x", uiStore.viewport.grid.snapSize)
    );

    editor.execute(command);
    editor.select(duplicateIds, "object");
    enqueueWorkerJob("Duplicate selection", { task: "triangulation", worker: "geometryWorker" }, 700);
  };

  const handleDeleteSelection = () => {
    if (editor.selection.ids.length === 0) {
      return;
    }

    editor.execute(createDeleteSelectionCommand(editor.scene, editor.selection.ids));
    editor.clearSelection();
    enqueueWorkerJob("Delete selection", { task: "brush-rebuild", worker: "geometryWorker" }, 550);
  };

  const handleMirrorSelection = (axis: TransformAxis) => {
    if (editor.selection.ids.length === 0) {
      return;
    }

    editor.execute(createMirrorNodesCommand(editor.selection.ids, axis));
    enqueueWorkerJob("Mirror selection", { task: "triangulation", worker: "geometryWorker" }, 700);
  };

  const handleClipSelection = (axis: TransformAxis) => {
    const { command, splitIds } = createSplitBrushNodesCommand(editor.scene, editor.selection.ids, axis);

    if (splitIds.length === 0) {
      return;
    }

    editor.execute(command);
    editor.select(splitIds, "object");
    enqueueWorkerJob("Clip brush", { task: "clip", worker: "geometryWorker" }, 950);
  };

  const handleExtrudeSelection = (axis: TransformAxis, direction: -1 | 1) => {
    if (editor.selection.ids.length === 0) {
      return;
    }

    const selectedNode = editor.scene.getNode(editor.selection.ids[0]);

    if (selectedNode && isBrushNode(selectedNode)) {
      editor.execute(
        createExtrudeBrushNodesCommand(
          editor.scene,
          editor.selection.ids,
          axis,
          uiStore.viewport.grid.snapSize,
          direction
        )
      );
      enqueueWorkerJob("Brush extrude", { task: "brush-rebuild", worker: "geometryWorker" }, 950);
      return;
    }

    if (selectedNode && isMeshNode(selectedNode) && axis === "y") {
      editor.execute(
        createMeshRaiseTopCommand(editor.scene, editor.selection.ids, uiStore.viewport.grid.snapSize * direction)
      );
      enqueueWorkerJob("Mesh triangulation", { task: "triangulation", worker: "meshWorker" }, 850);
    }
  };

  const handleMeshInflate = (factor: number) => {
    if (editor.selection.ids.length === 0) {
      return;
    }

    editor.execute(createMeshInflateCommand(editor.scene, editor.selection.ids, factor));
    enqueueWorkerJob("Mesh edit", { task: "bevel", worker: "meshWorker" }, 850);
  };

  const handlePlaceAsset = (position: Vec3) => {
    const snapped = snapVec3(position, uiStore.viewport.grid.snapSize);
    const asset = editor.scene.assets.get(uiStore.selectedAssetId);

    if (!asset || asset.type !== "model") {
      return;
    }

    const label = asset.id.endsWith("barrel") ? "Barrel Prop" : "Crate Prop";
    const { command, nodeId } = createPlaceModelNodeCommand(editor.scene, vec3(snapped.x, 1.1, snapped.z), {
      data: {
        assetId: asset.id,
        path: asset.path
      },
      name: label
    });

    editor.execute(command);
    editor.select([nodeId], "object");
    enqueueWorkerJob("Asset placement", { task: "triangulation", worker: "geometryWorker" }, 650);
  };

  const handleCreateBrush = () => {
    const snappedTarget = snapVec3(uiStore.viewport.camera.target, uiStore.viewport.grid.snapSize);
    const { command, nodeId } = createPlaceBrushNodeCommand(
      editor.scene,
      makeTransform(vec3(snappedTarget.x, 1.5, snappedTarget.z))
    );

    editor.execute(command);
    editor.select([nodeId], "object");
    enqueueWorkerJob("Brush placement", { task: "brush-rebuild", worker: "geometryWorker" }, 650);
  };

  const handlePlaceBrush = (brush: Brush, transform: Transform) => {
    const { command, nodeId } = createPlaceBrushNodeCommand(editor.scene, transform, {
      data: brush,
      name: "Blockout Brush"
    });

    editor.execute(command);
    editor.select([nodeId], "object");
    enqueueWorkerJob("Brush creation", { task: "brush-rebuild", worker: "geometryWorker" }, 700);
  };

  const handleCommitMeshTopology = (nodeId: string, mesh: EditableMesh) => {
    const node = editor.scene.getNode(nodeId);

    if (!node) {
      return;
    }

    if (isMeshNode(node)) {
      editor.execute(createSetMeshDataCommand(editor.scene, nodeId, mesh, node.data));
    } else if (isBrushNode(node)) {
      const replacement: MeshNode = {
        id: node.id,
        kind: "mesh",
        name: node.name,
        transform: structuredClone(node.transform),
        data: structuredClone(mesh)
      };

      editor.execute(createReplaceNodesCommand(editor.scene, [replacement], "promote brush to mesh"));
    }

    enqueueWorkerJob("Topology edit", { task: "triangulation", worker: "meshWorker" }, 850);
  };

  const handleInvertSelectionNormals = () => {
    const replacements: GeometryNode[] = editor.selection.ids
      .map((nodeId) => editor.scene.getNode(nodeId))
      .filter((node): node is GeometryNode => Boolean(node))
      .flatMap((node) => {
        if (isMeshNode(node)) {
          return [
            {
              ...structuredClone(node),
              data: invertEditableMeshNormals(node.data)
            } satisfies MeshNode
          ];
        }

        if (isBrushNode(node)) {
          const converted = convertBrushToEditableMesh(node.data);

          if (!converted) {
            return [];
          }

          return [
            {
              id: node.id,
              kind: "mesh" as const,
              name: node.name,
              transform: structuredClone(node.transform),
              data: invertEditableMeshNormals(converted)
            } satisfies MeshNode
          ];
        }

        return [];
      });

    if (replacements.length === 0) {
      return;
    }

    editor.execute(createReplaceNodesCommand(editor.scene, replacements, "invert normals"));
    enqueueWorkerJob("Invert normals", { task: "triangulation", worker: "meshWorker" }, 650);
  };

  const handleAssignMaterial = (materialId: string) => {
    if (editor.selection.ids.length === 0) {
      return;
    }

    uiStore.selectedMaterialId = materialId;
    editor.execute(createAssignMaterialToBrushesCommand(editor.scene, editor.selection.ids, materialId));
    enqueueWorkerJob("Material preview rebuild", { task: "triangulation", worker: "geometryWorker" }, 600);
  };

  const handleSelectAsset = (assetId: string) => {
    uiStore.selectedAssetId = assetId;
  };

  const handleSelectMaterial = (materialId: string) => {
    uiStore.selectedMaterialId = materialId;
  };

  const handlePlaceEntity = (type: "spawn" | "light") => {
    const position = vec3(
      uiStore.viewport.camera.target.x,
      type === "light" ? 3 : 1,
      uiStore.viewport.camera.target.z
    );
    const entityId = `entity:${type}:${editor.scene.entities.size + 1}`;
    editor.execute(
      createPlaceEntityCommand({
        id: entityId,
        properties:
          type === "light"
            ? { color: "#ffd089", enabled: true, intensity: 500 }
            : { enabled: true, team: "player" },
        transform: makeTransform(position),
        type
      })
    );
    enqueueWorkerJob("Entity authoring", { task: "navmesh", worker: "navWorker" }, 800);
  };

  const runWorkerRequest = (request: ExportWorkerRequest, label: string): Promise<string | SceneDocumentSnapshot> => {
    const id = `export:${requestCounterRef.current++}`;
    const workerTask =
      request.kind === "whmap-save"
        ? { task: "whmap-save" as const, worker: "exportWorker" as const }
        : request.kind === "whmap-load"
          ? { task: "whmap-load" as const, worker: "exportWorker" as const }
          : request.kind === "gltf-export"
            ? { task: "gltf" as const, worker: "exportWorker" as const }
            : { task: "engine-format" as const, worker: "exportWorker" as const };

    setExportJobs((jobs) => [
      ...jobs,
      {
        id,
        label,
        status: "running",
        task: workerTask
      }
    ]);

    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error("Export worker is unavailable."));
        return;
      }

      pendingRequestsRef.current.set(id, { reject, resolve });
      workerRef.current.postMessage({
        ...request,
        id
      } satisfies WorkerRequest);
    });
  };

  const downloadTextFile = (filename: string, content: string, type: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveWhmap = async () => {
    const payload = await runWorkerRequest(
      {
        kind: "whmap-save",
        snapshot: editor.exportSnapshot()
      },
      "Save .whmap"
    );

    if (typeof payload === "string") {
      downloadTextFile("scene.whmap", payload, "application/json");
    }
  };

  const handleLoadWhmap = () => {
    fileInputRef.current?.click();
  };

  const handleWhmapFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const text = await file.text();
    const payload = await runWorkerRequest(
      {
        kind: "whmap-load",
        text
      },
      "Load .whmap"
    );

    if (typeof payload !== "string") {
      editor.importSnapshot(payload, "scene:load-whmap");
    }

    event.target.value = "";
  };

  const handleExportGltf = async () => {
    const payload = await runWorkerRequest(
      {
        kind: "gltf-export",
        snapshot: editor.exportSnapshot()
      },
      "Export glTF"
    );

    if (typeof payload === "string") {
      downloadTextFile("scene.gltf", payload, "model/gltf+json");
    }
  };

  const handleExportEngine = async () => {
    const payload = await runWorkerRequest(
      {
        kind: "engine-export",
        snapshot: editor.exportSnapshot()
      },
      "Export engine scene"
    );

    if (typeof payload === "string") {
      downloadTextFile("scene.engine.json", payload, "application/json");
    }
  };

  const handleUndo = () => {
    editor.undo();
  };

  const handleRedo = () => {
    editor.redo();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;

      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      const modifier = event.metaKey || event.ctrlKey;

      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }

      if (modifier && event.key.toLowerCase() === "d") {
        event.preventDefault();
        handleDuplicateSelection();
        return;
      }

      if ((event.key === "Backspace" || event.key === "Delete") && activeToolId !== "mesh-edit") {
        event.preventDefault();
        handleDeleteSelection();
        return;
      }

      if (event.key.toLowerCase() === "n" && activeToolId !== "mesh-edit") {
        event.preventDefault();
        handleInvertSelectionNormals();
        return;
      }

      if (event.key === "1") {
        handleSetToolId("select");
        return;
      }

      if (event.key === "2") {
        handleSetToolId("transform");
        return;
      }

      if (event.key === "3") {
        handleSetToolId("brush");
        return;
      }

      if (event.key === "4") {
        handleSetToolId("clip");
        return;
      }

      if (event.key === "5") {
        handleSetToolId("extrude");
        return;
      }

      if (event.key === "6") {
        handleSetToolId("mesh-edit");
        return;
      }

      if (event.key === "7") {
        handleSetToolId("asset-place");
        return;
      }

      if (event.key.toLowerCase() === "b" && activeToolId !== "mesh-edit") {
        handleSetToolId("brush");
        return;
      }

      if (activeToolId !== "transform" && activeToolId !== "mesh-edit") {
        return;
      }

      if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        setTransformMode("translate");
        return;
      }

      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        setTransformMode("rotate");
        return;
      }

      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        setTransformMode("scale");
        return;
      }

      if (activeToolId === "mesh-edit" && event.key.toLowerCase() === "v") {
        event.preventDefault();
        setMeshEditMode("vertex");
        return;
      }

      if (activeToolId === "mesh-edit" && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setMeshEditMode("edge");
        return;
      }

      if (activeToolId === "mesh-edit" && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setMeshEditMode("face");
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        handleTranslateSelection("x", -1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        handleTranslateSelection("x", 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        handleTranslateSelection("z", -1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        handleTranslateSelection("z", 1);
      } else if (event.key === "PageUp") {
        event.preventDefault();
        handleTranslateSelection("y", 1);
      } else if (event.key === "PageDown") {
        event.preventDefault();
        handleTranslateSelection("y", -1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeToolId, editor]);

  return (
    <>
      <EditorShell
        activeRightPanel={ui.rightPanel}
        activeToolId={toolSession.toolId}
        canRedo={editor.commands.canRedo()}
        canUndo={editor.commands.canUndo()}
        editor={editor}
        gridSnapValues={gridSnapValues}
        jobs={[...workerJobs, ...exportJobs]}
        onAssignMaterial={handleAssignMaterial}
        onClipSelection={handleClipSelection}
        onCreateBrush={handleCreateBrush}
        onDeleteSelection={handleDeleteSelection}
        onDuplicateSelection={handleDuplicateSelection}
        onClearSelection={handleClearSelection}
        onCommitMeshTopology={handleCommitMeshTopology}
        onExportEngine={handleExportEngine}
        onExportGltf={handleExportGltf}
        onExtrudeSelection={handleExtrudeSelection}
        onFocusNode={handleFocusNode}
        onLoadWhmap={handleLoadWhmap}
        onMeshInflate={handleMeshInflate}
        onMirrorSelection={handleMirrorSelection}
        onPlaceAsset={handlePlaceAsset}
        onPlaceBrush={handlePlaceBrush}
        onPlaceEntity={handlePlaceEntity}
        onPreviewBrushData={handlePreviewBrushData}
        onPreviewMeshData={handlePreviewMeshData}
        onPreviewNodeTransform={handlePreviewNodeTransform}
        onRedo={handleRedo}
        onSaveWhmap={handleSaveWhmap}
        onSelectAsset={handleSelectAsset}
        onSelectMaterial={handleSelectMaterial}
        onSelectNodes={handleSelectNodes}
        onSetRightPanel={handleSetRightPanel}
        onSetSnapSize={handleSetSnapSize}
        onSetToolId={handleSetToolId}
        onSplitBrushAtCoordinate={handleSplitBrushAtCoordinate}
        onTranslateSelection={handleTranslateSelection}
        onUndo={handleUndo}
        onUpdateBrushData={handleUpdateBrushData}
        onUpdateMeshData={handleUpdateMeshData}
        onUpdateNodeTransform={handleUpdateNodeTransform}
        meshEditMode={meshEditMode}
        renderScene={renderScene}
        selectedAssetId={ui.selectedAssetId}
        selectedMaterialId={ui.selectedMaterialId}
        transformMode={transformMode}
        viewport={ui.viewport}
        tools={defaultTools}
      />
      <input
        accept=".whmap,.json"
        hidden
        onChange={handleWhmapFileChange}
        ref={fileInputRef}
        type="file"
      />
    </>
  );
}
