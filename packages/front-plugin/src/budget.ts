import type { CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
export interface CaptureLimits {
  readonly payloadBytes: number;
  readonly contextBytes: number;
}
/** A conservative local cap, below the API's 32 MiB body limit. */
export const CAPTURE_LIMITS: CaptureLimits = Object.freeze({
  payloadBytes: 2 * 1024 * 1024,
  contextBytes: 512 * 1024,
});
const utf8 = new TextEncoder();
function bytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).byteLength;
}
export function budgetCapture(
  input: CaptureCreate,
  limits: CaptureLimits = CAPTURE_LIMITS,
): { body: CaptureCreate; omitted: number } {
  const context: CaptureMessage[] = [];
  let size = 2,
    omitted = 0;
  // Keep recent eligible context first, then restore chronological order.
  for (let i = input.context.length - 1; i >= 0; i--) {
    const m = input.context[i]!,
      cost = bytes(m) + (context.length ? 1 : 0);
    if (size + cost <= limits.contextBytes) {
      context.push(m);
      size += cost;
    } else omitted++;
  }
  const body: CaptureCreate = {
    ...input,
    context: context.reverse(),
    metadata: {
      ...input.metadata,
      contextOmittedBySize: omitted,
      captureByteLimit: limits.payloadBytes,
      ...(omitted ? { contextIncomplete: true } : {}),
    },
  };
  if (bytes(body) > limits.payloadBytes)
    throw new Error("This capture is too large. Reduce the note or configured fields, then review it again.");
  return { body, omitted };
}
