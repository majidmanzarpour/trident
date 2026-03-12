import type { Object3D } from "three";
import type { GameplayRuntimeHost } from "@web-hammer/gameplay-runtime";
import type { Transform } from "@web-hammer/shared";

export type PlaybackGameplayHost = {
  bindNodeObject: (nodeId: string, object: Object3D | null) => void;
  host: GameplayRuntimeHost;
  reset: () => void;
};

export function createPlaybackGameplayHost(): PlaybackGameplayHost {
  const objectsByNodeId = new Map<string, Object3D | null>();
  const pendingTransforms = new Map<string, Transform>();

  return {
    bindNodeObject(nodeId, object) {
      if (object) {
        objectsByNodeId.set(nodeId, object);
        const pendingTransform = pendingTransforms.get(nodeId);

        if (pendingTransform) {
          applyTransform(object, pendingTransform);
        }

        return;
      }

      objectsByNodeId.delete(nodeId);
    },
    host: {
      applyNodeWorldTransform(nodeId, transform) {
        const object = objectsByNodeId.get(nodeId);

        if (!object) {
          pendingTransforms.set(nodeId, structuredClone(transform));
          return;
        }

        applyTransform(object, transform);
      }
    },
    reset() {
      pendingTransforms.clear();
      objectsByNodeId.clear();
    }
  };
}

function applyTransform(object: Object3D, transform: Transform) {
  object.position.set(transform.position.x, transform.position.y, transform.position.z);
  object.rotation.set(transform.rotation.x, transform.rotation.y, transform.rotation.z);
  object.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
  object.updateMatrixWorld();
}
