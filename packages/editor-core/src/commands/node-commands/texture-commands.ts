import type { TextureRecord } from "@web-hammer/shared";
import type { Command } from "../command-stack";
import type { SceneDocument } from "../../document/scene-document";

export function createUpsertTextureCommand(
  scene: SceneDocument,
  texture: TextureRecord
): Command {
  const before = scene.textures.get(texture.id);
  const next = structuredClone(texture);

  return {
    label: before ? "update texture" : "create texture",
    execute(nextScene) {
      nextScene.setTexture(structuredClone(next));
    },
    undo(nextScene) {
      if (before) {
        nextScene.setTexture(structuredClone(before));
        return;
      }

      nextScene.removeTexture(texture.id);
    }
  };
}
