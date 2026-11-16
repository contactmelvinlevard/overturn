import Front, { HttpVerbsEnum } from "@frontapp/plugin-sdk";
import { within } from "./async";
import type { Post, Receipt } from "./controller";
export function receiptFrom(value: unknown): Receipt {
  const v: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (
    typeof v !== "object" ||
    v === null ||
    !("runId" in v) ||
    typeof v.runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.runId) ||
    !("kind" in v) ||
    (v.kind !== "edit" && v.kind !== "approve") ||
    !("deduplicated" in v) ||
    typeof v.deduplicated !== "boolean"
  )
    throw new Error("Capture response was not confirmed.");
  return { runId: v.runId, kind: v.kind, deduplicated: v.deduplicated };
}
/** Calls the configured application server. Front holds authentication; no client-side key. */
export function capturePost(timeoutMs = 15000): Post {
  return async (body) => {
    const response = await within(
      Front.sendHttp({ verb: HttpVerbsEnum.POST, path: "/v1/capture", body }),
      timeoutMs,
    );
    if (response.status < 200 || response.status >= 300) throw new Error("Capture was not confirmed.");
    return receiptFrom(response.body);
  };
}
