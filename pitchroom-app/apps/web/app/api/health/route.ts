import { healthResponse } from "../../../lib/runtime-responses";

export const dynamic = "force-dynamic";

export async function GET() {
  return healthResponse();
}
