import { describe, expect, it } from "vitest";
import { chunkMaterial, ingestMaterial, stableHash } from "./materials";

describe("material ingestion", () => {
  it("normalizes input and creates stable source and chunk ids", () => {
    const first = ingestMaterial("project-1", {
      name: "notes.md",
      mediaType: "text/markdown",
      text: "Alpha\r\n\r\nBeta",
    });
    const second = ingestMaterial("project-1", {
      name: "renamed.md",
      mediaType: "text/markdown",
      text: "Alpha\n\nBeta",
    });
    expect(first.content).toBe("Alpha\n\nBeta");
    expect(first.sourceId).toBe(second.sourceId);
    expect(first.chunks).toEqual(second.chunks);
  });

  it("covers the complete text with deterministic overlap", () => {
    const text = "one two three four five six seven eight nine ten";
    const chunks = chunkMaterial("source", text, {
      maxSourceCharacters: 100,
      chunkCharacters: 18,
      overlapCharacters: 4,
    });
    expect(chunks[0]?.startOffset).toBe(0);
    expect(chunks.at(-1)?.endOffset).toBe(text.length);
    for (const chunk of chunks) {
      expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    }
  });

  it("rejects empty and oversized material", () => {
    expect(() =>
      ingestMaterial("p", { name: "x", mediaType: "text/plain", text: "  " }),
    ).toThrow("readable text");
    expect(() =>
      ingestMaterial(
        "p",
        { name: "x", mediaType: "text/plain", text: "1234" },
        { maxSourceCharacters: 3, chunkCharacters: 2, overlapCharacters: 0 },
      ),
    ).toThrow("size limit");
    expect(() => ingestMaterial("p", { name: "binary.txt", mediaType: "text/plain", text: "text\0binary" })).toThrow("not binary");
  });

  it("uses a stable non-empty hash", () => {
    expect(stableHash("pitchroom")).toMatch(/^[0-9a-f]{16}$/);
    expect(stableHash("pitchroom")).not.toBe(stableHash("Pitchroom"));
  });

  it.each([
    ["short", "One sentence."],
    ["paragraphs", "One.\n\nTwo.\n\nThree."],
    ["markdown", "# Heading\n\n- evidence\n- more evidence"],
    ["unicode", "客户需要证据。\n\nÉquipe prépare le dossier."],
    ["long", "Background. ".repeat(900)],
    ["badly-formatted", "a\n b\n\n\n c     d"],
  ])("produces byte-stable chunks for the %s fixture", (_name, text) => {
    expect(ingestMaterial("golden-project", { name: "fixture.md", mediaType: "text/markdown", text }).chunks).toEqual(ingestMaterial("golden-project", { name: "fixture.md", mediaType: "text/markdown", text }).chunks);
  });
});
