import { expect, it } from "vitest";
import { budgetCapture } from "./budget";

it("bounds aggregated UTF8 context while keeping recent prior messages and declaring omissions", () => {
  const old = {
    role: "customer" as const,
    author: null,
    content: "舊".repeat(40),
    at: "2026-01-01T00:00:00Z",
  };
  const recent = { ...old, content: "新".repeat(40), at: "2026-01-01T00:01:00Z" };
  const result = budgetCapture(
    {
      source: "front",
      externalId: "fr:C",
      agent: "reply",
      context: [old, recent],
      draft: { text: "D" },
      sent: { text: "S" },
    },
    { payloadBytes: 4096, contextBytes: 240 },
  );
  expect(result.body.context).toEqual([recent]);
  expect(result.omitted).toBe(1);
  expect(result.body.metadata?.contextIncomplete).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(result.body.context)).byteLength).toBeLessThanOrEqual(240);
});
