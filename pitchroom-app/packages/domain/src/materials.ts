import { z } from "zod";
import { PitchroomError } from "./errors";

export const acceptedMediaTypes = ["text/plain", "text/markdown"] as const;

export const materialInputSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mediaType: z.enum(acceptedMediaTypes),
  text: z.string(),
});

export type MaterialInput = z.infer<typeof materialInputSchema>;

export type MaterialLimits = {
  maxSourceCharacters: number;
  chunkCharacters: number;
  overlapCharacters: number;
};

export const defaultMaterialLimits: MaterialLimits = {
  maxSourceCharacters: 1_048_576,
  chunkCharacters: 6_000,
  overlapCharacters: 600,
};

export const defaultProjectCharacterLimit = 5_242_880;

export type IngestedMaterial = {
  sourceId: string;
  name: string;
  mediaType: (typeof acceptedMediaTypes)[number];
  content: string;
  contentHash: string;
  chunks: Array<{
    id: string;
    sourceId: string;
    ordinal: number;
    text: string;
    startOffset: number;
    endOffset: number;
  }>;
};

export function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function normalizeMaterialText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function chooseBoundary(text: string, start: number, desiredEnd: number): number {
  if (desiredEnd >= text.length) return text.length;
  const paragraph = text.lastIndexOf("\n\n", desiredEnd);
  if (paragraph > start + Math.floor((desiredEnd - start) * 0.55)) {
    return paragraph + 2;
  }
  const newline = text.lastIndexOf("\n", desiredEnd);
  if (newline > start + Math.floor((desiredEnd - start) * 0.7)) {
    return newline + 1;
  }
  return desiredEnd;
}

export function chunkMaterial(
  sourceId: string,
  text: string,
  limits: MaterialLimits = defaultMaterialLimits,
): IngestedMaterial["chunks"] {
  if (limits.chunkCharacters <= 0) {
    throw new PitchroomError("INVALID_INPUT", "Chunk size must be positive.");
  }
  if (limits.overlapCharacters < 0 || limits.overlapCharacters >= limits.chunkCharacters) {
    throw new PitchroomError("INVALID_INPUT", "Chunk overlap must be smaller than chunk size.");
  }

  const chunks: IngestedMaterial["chunks"] = [];
  let start = 0;
  while (start < text.length) {
    const end = chooseBoundary(text, start, start + limits.chunkCharacters);
    const chunkText = text.slice(start, end);
    chunks.push({
      id: `${sourceId}:chunk:${chunks.length}:${stableHash(chunkText)}`,
      sourceId,
      ordinal: chunks.length,
      text: chunkText,
      startOffset: start,
      endOffset: end,
    });
    if (end === text.length) break;
    start = Math.max(start + 1, end - limits.overlapCharacters);
  }
  return chunks;
}

export function ingestMaterial(
  projectId: string,
  input: MaterialInput,
  limits: MaterialLimits = defaultMaterialLimits,
): IngestedMaterial {
  const parsed = materialInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PitchroomError("INVALID_INPUT", "Material metadata is invalid.", {
      issues: parsed.error.issues,
    });
  }
  const content = normalizeMaterialText(parsed.data.text);
  if (content.trim().length === 0) {
    throw new PitchroomError("INVALID_INPUT", "Material must contain readable text.");
  }
  const disallowedControls = [...content].filter((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || (code < 32 && character !== "\n" && character !== "\t");
  }).length;
  if (disallowedControls > 0) {
    throw new PitchroomError("INVALID_INPUT", "Material must be UTF-8 text, not binary content.", { disallowedControls });
  }
  if (content.length > limits.maxSourceCharacters) {
    throw new PitchroomError("INVALID_INPUT", "Material exceeds the source size limit.", {
      actual: content.length,
      limit: limits.maxSourceCharacters,
    });
  }
  const contentHash = stableHash(content);
  const sourceId = `src_${stableHash(`${projectId}:${contentHash}`)}`;
  return {
    sourceId,
    name: parsed.data.name,
    mediaType: parsed.data.mediaType,
    content,
    contentHash,
    chunks: chunkMaterial(sourceId, content, limits),
  };
}
