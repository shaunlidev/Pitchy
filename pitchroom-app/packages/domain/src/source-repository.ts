import type { SourceChunk } from "./understanding";

export type SourceRecord = {
  id: string;
  projectId: string;
  name: string;
  mediaType: string;
  contentHash: string;
  chunks: SourceChunk[];
};

export type ToolRepository = {
  listSources(projectId: string): Promise<SourceRecord[]>;
  getSource(projectId: string, sourceId: string): Promise<SourceRecord | undefined>;
  getChunk(projectId: string, chunkId: string): Promise<SourceChunk | undefined>;
};
