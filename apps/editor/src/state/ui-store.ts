import { proxy } from "valtio";
import type { ViewportState } from "@web-hammer/render-pipeline";
import { createEditorViewports, type ViewModeId, type ViewportPaneId } from "@/viewport/viewports";

type UiStore = {
  activeViewportId: ViewportPaneId;
  rightPanel: "inspector" | "materials" | "scene";
  selectedAssetId: string;
  selectedMaterialId: string;
  viewMode: ViewModeId;
  viewports: Record<ViewportPaneId, ViewportState>;
};

export const uiStore = proxy<UiStore>({
  activeViewportId: "perspective",
  rightPanel: "scene",
  selectedAssetId: "asset:model:crate",
  selectedMaterialId: "material:blockout:orange",
  viewMode: "3d-only",
  viewports: createEditorViewports()
});
