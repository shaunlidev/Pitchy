import type { TopicRef } from "@pitchroom/domain";
export type FileImportItem = { id: string; name: string } & (
  | { status: "queued" | "importing" }
  | { status: "saved" }
  | { status: "failed"; file: File; commandId: string; topic?: TopicRef; message: string; outcomeUnknown: boolean }
);
