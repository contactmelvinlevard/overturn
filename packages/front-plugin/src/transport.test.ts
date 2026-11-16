import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@frontapp/plugin-sdk", () => ({ default: { sendHttp: send }, HttpVerbsEnum: { POST: "POST" } }));

import { contentText, settingsFrom } from "./capture";
import { capturePost, receiptFrom } from "./transport";

describe("transport and text boundaries", () => {
  beforeEach(() => {
    send.mockReset();
  });
  it("ends a hung POST with an unknown result rather than a success or another request", async () => {
    vi.useFakeTimers();
    try {
      send.mockImplementation(() => new Promise(() => {}));
      const operation = capturePost(10)({
        source: "front",
        externalId: "fr:C",
        agent: "reply",
        draft: { text: "D" },
        sent: { text: "D" },
        context: [],
      });
      const rejected = expect(operation).rejects.toThrow("unknown");
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      expect(send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("uses the fixed configured app-server path, never a runtime URL or client credential", async () => {
    const receipt = { runId: "00000000-0000-4000-8000-000000000001", kind: "approve", deduplicated: false };
    send.mockResolvedValueOnce({ status: 201, body: receipt });
    const body = {
      source: "front" as const,
      externalId: "fr:C",
      agent: "reply",
      draft: { text: "D" },
      sent: { text: "D" },
      context: [],
    };
    expect(await capturePost()(body)).toEqual(receipt);
    expect(send).toHaveBeenLastCalledWith({ verb: "POST", path: "/v1/capture", body });
    const settings = settingsFrom(
      new URLSearchParams("overturn_api_key=do-not-use&overturn_base_url=https://other.example"),
    );
    expect(JSON.stringify(settings)).not.toContain("do-not-use");
    expect(JSON.stringify(settings)).not.toContain("other.example");
  });
  it("requires a meaningful receipt; a 2xx malformed body is not success", async () => {
    expect(() => receiptFrom({ ok: true })).toThrow();
    send.mockResolvedValueOnce({ status: 201, body: { ok: true } });
    await expect(
      capturePost()({
        source: "front",
        externalId: "fr:C",
        agent: "reply",
        draft: { text: "D" },
        sent: { text: "D" },
        context: [],
      }),
    ).rejects.toThrow();
  });
  it("preserves plain text, removes script/style bodies, and decodes text entities safely", () => {
    expect(contentText({ type: "text", body: "2 < 3 & x" })).toBe("2 < 3 & x");
    expect(
      contentText({
        type: "html",
        body: "<p>A &amp; B &#x20ac;</p><script>bad()</script><style>bad</style><p>&lt;img onerror=x&gt;</p>",
      }),
    ).toBe("A & B €\n<img onerror=x>");
  });
});
