export type FileImportItem = { id: string; name: string } & (
  | { status: "queued" | "importing" }
  | { status: "saved" }
  | { status: "failed"; file: File; commandId: string; message: string; outcomeUnknown: boolean }
);
