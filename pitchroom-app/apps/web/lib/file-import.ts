import type { TopicRef } from "@pitchroom/domain";
import type { MaterialImportReceipt } from "./api-contract";

export type FileImportItem = { id: string; name: string } & (
  | { status: "queued" | "importing" }
  | { status: "saved"; receipt: MaterialImportReceipt }
  | { status: "failed"; file: File; commandId: string; topic?: TopicRef; message: string; outcomeUnknown: boolean }
);

export function fileImportStatusLabel(item: FileImportItem): string {
  switch (item.status) {
    case "queued": return "Waiting";
    case "importing": return "Importing";
    case "failed": return item.outcomeUnknown ? "Save not confirmed" : "Not imported";
    case "saved": {
      const { outcome, sourceName } = item.receipt;
      switch (outcome) {
        case "created": return "Saved as " + sourceName;
        case "reused": return "Reused existing source " + sourceName;
        case "restored": return "Restored source " + sourceName;
        case "replayed": return "Previous import confirmed: " + sourceName;
      }
    }
  }
}
