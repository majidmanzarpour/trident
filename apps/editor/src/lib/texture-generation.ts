import {
  createAiTextureDraft,
  TEXTURE_GENERATION_MODELS,
  type GeneratedTextureDraft,
  type TextureGenerationRequest,
  type TextureGenerationResponse
} from "@/lib/texture-generation-contract";

export type TextureGenerator = {
  generateTextures: (
    request: TextureGenerationRequest
  ) => Promise<GeneratedTextureDraft[]>;
};

export { TEXTURE_GENERATION_MODELS };
export type {
  TextureGenerationModelId,
  TextureGenerationRequest
} from "@/lib/texture-generation-contract";

export function createTextureGenerator(): TextureGenerator {
  return new TextureGenerationApiClient();
}

class TextureGenerationApiClient implements TextureGenerator {
  async generateTextures(
    request: TextureGenerationRequest
  ): Promise<GeneratedTextureDraft[]> {
    const response = await fetch("/api/ai/textures", {
      body: JSON.stringify(request),
      headers: {
        "Content-Type": "application/json"
      },
      method: "POST"
    });

    const payload = (await response.json()) as
      | TextureGenerationResponse
      | { error?: string };

    if (!response.ok) {
      throw new Error(
        "error" in payload ? payload.error ?? "Failed to generate textures." : "Failed to generate textures."
      );
    }

    const textures =
      "textures" in payload ? payload.textures : [];

    return Promise.all(
      textures.map(async (texture) =>
        createAiTextureDraft({
          ...texture,
          dataUrl: await normalizeTextureDataUrl(
            texture.dataUrl,
            request.size,
            texture.mimeType ?? "image/png"
          )
        })
      )
    );
  }
}

async function normalizeTextureDataUrl(
  source: string,
  size: number,
  mimeType: string
) {
  const image = await loadImage(source);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Failed to create texture canvas.");
  }

  context.imageSmoothingEnabled = true;
  context.drawImage(image, 0, 0, size, size);

  return canvas.toDataURL(mimeType);
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("Failed to load generated texture."));
    image.onload = () => resolve(image);
    image.src = source;
  });
}
