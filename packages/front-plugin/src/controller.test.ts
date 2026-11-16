import type {
  ApplicationConversationId,
  ApplicationCustomFieldId,
  ApplicationDraftId,
  ApplicationMessageId,
  ApplicationPaginationToken,
  ApplicationTeammateId,
} from "@frontapp/plugin-sdk";
import { type CaptureCreate, captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it, vi } from "vitest";
import { type DraftView, type FrontPort, type MessageView, type Page, settingsFrom } from "./capture";
import { ManualCapture, type Receipt } from "./controller";

const receipt: Receipt = { runId: "00000000-0000-4000-8000-000000000001", kind: "edit", deduplicated: false };
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const draft = (id = "D1", body = "Original draft"): DraftView => ({
  id: id as ApplicationDraftId,
  subject: undefined,
  content: { body, type: "text", attachments: [] },
});
const message = (id = "M1", body: string | null = "Revised reply"): MessageView => ({
  id: id as ApplicationMessageId,
  date: new Date("2026-01-01T12:00:00Z"),
  status: "outbound",
  from: { handle: "support@example.test", name: undefined, type: "email", contact: undefined },
  content: body === null ? undefined : { body, type: "text", attachments: [] },
});
function harness(id = "C1", d: DraftView = draft()) {
  let value: DraftView | undefined = d,
    messages: MessageView[] = [];
  const read = vi.fn(
    async (_token?: ApplicationPaginationToken): Promise<Page> => ({
      results: messages,
      nextPageToken: undefined,
    }),
  );
  const port: FrontPort = {
    conversation: {
      id: id as ApplicationConversationId,
      draftId: d.id,
      subject: "Synthetic test",
      tags: [],
      customFieldAttributes: [],
    },
    teammate: { id: "A" as ApplicationTeammateId, email: "alice@example.test" },
    fetchDraft: vi.fn(async () => value),
    listMessages: read,
  };
  return {
    port,
    read,
    setDraft: (v: DraftView | undefined) => {
      value = v;
    },
    setMessages: (v: MessageView[]) => {
      messages = v;
    },
  };
}
async function ready(c: ManualCapture, h: ReturnType<typeof harness>) {
  await c.connect(h.port);
  c.confirmDraft("unknown");
  h.setMessages([message()]);
  await c.refreshMessages();
  c.selectMessage("M1");
  c.confirmMessage();
  c.setReason("wrong_answer", "Corrected answer");
}
describe("operator-confirmed Front capture", () => {
  it.each([false, true])("ignores a stale rejected A read after B, returning to A=%s", async (returnToA) => {
    const a = harness("A"),
      b = harness("B", draft("D2", "B current")),
      freshA = harness("A", draft("D3", "A current"));
    const slow = deferred<DraftView | undefined>();
    a.port.fetchDraft = () => slow.promise;
    const c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt),
      pending = c.connect(a.port);
    await c.connect(b.port);
    if (returnToA) await c.connect(freshA.port);
    slow.reject(new Error("Stale A failed"));
    await pending;
    await c.pollDraft();
    expect(c.current()?.draft.text).toBe(returnToA ? "A current" : "B current");
    expect(c.notice).not.toContain("paused");
    expect(c.current()?.conversationId).toBe(returnToA ? "A" : "B");
  });
  it("rejects an oversized UTF8 note locally without reserving the pair or making a POST", async () => {
    const post = vi.fn(async () => receipt),
      h = harness();
    const c = new ManualCapture(
      settingsFrom(new URLSearchParams()),
      post,
      () => {},
      () => new Date(),
      { payloadBytes: 4096, contextBytes: 512 },
    );
    await ready(c, h);
    c.setReason("wrong_answer", "漢".repeat(1500));
    await c.save();
    expect(c.current()?.status).toBe("review");
    expect(c.current()?.intent).toBeNull();
    expect(c.current()?.notice).toContain("too large");
    expect(post).not.toHaveBeenCalled();
    c.setReason("wrong_answer", "short");
    await c.save();
    expect(post).toHaveBeenCalledOnce();
  });
  it("includes unbounded field values in the final serialized size guard", async () => {
    const h = harness(),
      post = vi.fn(async () => receipt);
    h.port.conversation.customFieldAttributes = [
      { id: "F" as ApplicationCustomFieldId, name: "decision", type: "string", value: "x".repeat(5000) },
    ];
    const c = new ManualCapture(
      { ...settingsFrom(new URLSearchParams()), decisionFields: ["decision"] },
      post,
      () => {},
      () => new Date(),
      { payloadBytes: 4096, contextBytes: 512 },
    );
    await ready(c, h);
    await c.save();
    expect(post).not.toHaveBeenCalled();
    expect(c.current()?.status).toBe("review");
    expect(c.current()?.notice).toContain("too large");
  });
  it("excludes messages after the chosen reply and marks equal-date ambiguity incomplete", async () => {
    const h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt);
    await ready(c, h);
    const before = message("BEFORE", "Known at reply time"),
      future = message("FUTURE", "A later answer"),
      tie = message("TIE", "Same timestamp");
    before.status = "inbound";
    before.date = new Date("2026-01-01T11:59:00Z");
    future.status = "inbound";
    future.date = new Date("2026-01-01T12:01:00Z");
    h.setMessages([before, message(), future, tie]);
    await c.refreshMessages();
    c.selectMessage("M1");
    c.confirmMessage();
    c.setReason("wrong_answer", "");
    await c.save();
    expect(c.current()?.intent?.context.map((m) => m.content)).toEqual(["Known at reply time"]);
    expect(c.current()?.intent?.metadata?.contextIncomplete).toBe(true);
    expect(c.current()?.intent?.metadata?.contextTimeBound).toBe("strictly_before_selected_message_date");
  });
  it("invalidates a confirmed field snapshot when the same conversation's values change", async () => {
    const h = harness();
    h.port.conversation.customFieldAttributes = [
      { id: "F" as ApplicationCustomFieldId, name: "decision", type: "string", value: "before" },
    ];
    const c = new ManualCapture(
      { ...settingsFrom(new URLSearchParams()), decisionFields: ["decision"] },
      async () => receipt,
    );
    await ready(c, h);
    h.port.conversation.customFieldAttributes = [
      { id: "F" as ApplicationCustomFieldId, name: "decision", type: "string", value: "after" },
    ];
    await c.connect(h.port);
    expect(c.current()?.sent).toBeNull();
    expect(c.current()?.reasonCode).toBeNull();
    expect(c.current()?.draft.fields.decision).toBe("before");
  });
  it("reads no thread and posts nothing before both explicit confirmations", async () => {
    const post = vi.fn(async (_body: CaptureCreate) => receipt),
      h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), post);
    await c.connect(h.port);
    expect(h.read).not.toHaveBeenCalled();
    await c.refreshMessages();
    expect(h.read).not.toHaveBeenCalled();
    c.confirmDraft("unknown");
    h.setMessages([message()]);
    await c.refreshMessages();
    await c.save();
    expect(post).not.toHaveBeenCalled();
    expect(c.current()?.selectedId).toBeNull();
    c.selectMessage("M1");
    await c.save();
    expect(post).not.toHaveBeenCalled();
    c.confirmMessage();
    await c.save();
    expect(post).not.toHaveBeenCalled();
    expect(c.current()?.notice).toContain("Choose why");
    c.setReason("wrong_answer", "");
    await c.save();
    expect(post).toHaveBeenCalledOnce();
    const body = post.mock.calls[0]?.[0];
    expect(captureCreateSchema.safeParse(body).success).toBe(true);
  });
  it("keeps the first observed draft immutable and never infers AI or a human author", async () => {
    const post = vi.fn(async () => receipt),
      h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), post);
    await c.connect(h.port);
    h.setDraft(draft("D1", "Later edits"));
    await c.pollDraft();
    expect(c.current()?.draft.text).toBe("Original draft");
    c.confirmDraft("unknown");
    h.setMessages([message()]);
    await c.refreshMessages();
    c.selectMessage("M1");
    c.confirmMessage();
    c.setReason("wrong_answer", "");
    await c.save();
    const body = c.current()?.intent;
    expect(body?.tags).toContain("draft:unknown");
    expect(body?.tags).not.toContain("draft:ai");
    expect(body?.actor).toBe("unknown");
    expect(body?.metadata?.confirmedByReviewerId).toBe("A");
    expect(body?.secondsToSend).toBeNull();
  });
  it("retains lazy bodies for a later explicit refresh rather than discarding the draft", async () => {
    const post = vi.fn(async () => receipt),
      h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), post);
    await c.connect(h.port);
    c.confirmDraft("attested-ai");
    h.setDraft(undefined);
    h.setMessages([message("M1", null)]);
    await c.refreshMessages();
    c.selectMessage("M1");
    c.confirmMessage();
    await c.save();
    expect(post).not.toHaveBeenCalled();
    expect(c.current()?.sent).toBeNull();
    expect(c.current()?.draft.text).toBe("Original draft");
    h.setMessages([message()]);
    await c.refreshMessages();
    c.confirmMessage();
    c.setReason("wrong_answer", "");
    await c.save();
    expect(post).toHaveBeenCalledOnce();
    expect(c.current()?.intent?.tags).toContain("draft:ai");
  });
  it("does not select even a unique matching outbound; changing selection clears its confirmation and reason", async () => {
    const h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt);
    await c.connect(h.port);
    c.confirmDraft("unknown");
    h.setMessages([message("M1", "Original draft"), message("M2", "Original draft")]);
    await c.refreshMessages();
    expect(c.current()?.selectedId).toBeNull();
    c.selectMessage("M1");
    c.confirmMessage();
    c.setReason("wrong_answer", "M1 reason");
    c.selectMessage("M2");
    expect(c.current()?.sent).toBeNull();
    expect(c.current()?.reasonCode).toBeNull();
    expect(c.current()?.note).toBe("");
  });
  it("invalidates confirmation when a loaded message changes or becomes lazy", async () => {
    const h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt);
    await ready(c, h);
    h.setMessages([message("M1", "Edited on server")]);
    await c.refreshMessages();
    expect(c.current()?.sent).toBeNull();
    expect(c.current()?.reasonCode).toBeNull();
    c.confirmMessage();
    h.setMessages([message("M1", null)]);
    await c.refreshMessages();
    expect(c.current()?.sent).toBeNull();
  });
  it("bounds pagination, detects token cycles and deduplicates repeated IDs", async () => {
    const h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt);
    await c.connect(h.port);
    c.confirmDraft("unknown");
    const token = "p1" as ApplicationPaginationToken;
    h.read.mockImplementation(async (page) => ({
      results: [message(page ? "M2" : "M1")],
      nextPageToken: token,
    }));
    await c.refreshMessages();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(c.current()?.messages.size).toBe(2);
    expect(c.current()?.incomplete).toBe(true);
    h.read.mockImplementation(async () => ({ results: [message()], nextPageToken: undefined }));
    await c.refreshMessages();
    expect(c.current()?.messages.size).toBe(1);
  });
  it("enforces a five-page cap even for fresh tokens", async () => {
    const h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt);
    await c.connect(h.port);
    c.confirmDraft("unknown");
    let page = 0;
    h.read.mockImplementation(async () => ({
      results: [message(`M${page}`)],
      nextPageToken: `p${++page}` as ApplicationPaginationToken,
    }));
    await c.refreshMessages();
    expect(h.read).toHaveBeenCalledTimes(5);
    expect(c.current()?.incomplete).toBe(true);
  });
  it("rejects stale A reads across A->B->A and retains the right immutable draft", async () => {
    const a = harness("A"),
      b = harness("B", draft("D2", "B draft")),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt);
    const slow = deferred<DraftView | undefined>();
    a.port.fetchDraft = () => slow.promise;
    const pending = c.connect(a.port);
    await c.connect(b.port);
    slow.resolve(draft("D1", "Stale A"));
    await pending;
    await c.pollDraft();
    expect(c.current()?.draft.text).toBe("B draft");
    expect(c.available()).toHaveLength(1);
    a.port.fetchDraft = async () => draft("D1", "Fresh A");
    await c.connect(a.port);
    expect(c.current()?.draft.text).toBe("Fresh A");
  });
  it("drops late message reads for A without putting them in B; returning requires confirmation", async () => {
    const a = harness("A"),
      b = harness("B", draft("D2")),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt);
    await ready(c, a);
    const slow = deferred<Page>();
    a.read.mockImplementation(() => slow.promise);
    const pending = c.refreshMessages();
    await c.connect(b.port);
    slow.resolve({ results: [message("MA", "A only")], nextPageToken: undefined });
    await pending;
    expect(c.current()?.conversationId).toBe("B");
    expect(c.current()?.messages.size).toBe(0);
    await c.connect(a.port);
    expect(c.current()?.sent).toBeNull();
    expect(c.current()?.reasonCode).toBeNull();
  });
  it("keeps D1 and D2 review states separate in the same conversation", async () => {
    const h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt);
    await ready(c, h);
    const old = c.current()?.key;
    h.port.conversation.draftId = "D2" as ApplicationDraftId;
    h.setDraft(draft("D2", "Second"));
    await c.connect(h.port);
    expect(c.available()).toHaveLength(2);
    const second = c.available().find((w) => w.draft.id === "D2");
    c.chooseWork(second!.key);
    expect(c.current()?.draftConfirmed).toBe(false);
    expect(c.current()?.sent).toBeNull();
    expect(c.current()?.reasonCode).toBeNull();
    c.chooseWork(old!);
    expect(c.current()?.draft.text).toBe("Original draft");
  });
  it("locks one immutable POST against double clicks and changes while saving", async () => {
    const gate = deferred<Receipt>(),
      post = vi.fn(() => gate.promise),
      h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), post);
    await ready(c, h);
    const a = c.save(),
      b = c.save();
    c.setReason("tone_wording", "Mutation after click");
    expect(post).toHaveBeenCalledOnce();
    expect(c.current()?.intent?.reasonCode).toBe("wrong_answer");
    gate.resolve(receipt);
    await Promise.all([a, b]);
    await c.save();
    expect(post).toHaveBeenCalledOnce();
  });
  it("keeps uncertain POSTs and refuses blind retries after reconnect", async () => {
    const post = vi.fn(async () => {
        throw new Error("timeout after possible commit");
      }),
      h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), post);
    await ready(c, h);
    await c.save();
    expect(c.current()?.status).toBe("unknown");
    expect(c.current()?.intent?.sent.text).toBe("Revised reply");
    await c.connect(h.port);
    await c.save();
    expect(post).toHaveBeenCalledOnce();
  });
  it("applies the shared field-change diff and configured reason pack", async () => {
    const post = vi.fn(async () => receipt),
      h = harness();
    h.port.conversation.customFieldAttributes = [
      { id: "F" as ApplicationCustomFieldId, name: "decision", type: "string", value: "before" },
    ];
    const c = new ManualCapture(
      { ...settingsFrom(new URLSearchParams()), decisionFields: ["decision"] },
      post,
    );
    await c.connect(h.port);
    c.confirmDraft("attested-manual");
    h.port.conversation.customFieldAttributes = [
      { id: "F" as ApplicationCustomFieldId, name: "decision", type: "string", value: "after" },
    ];
    h.setMessages([message("M1", "Original draft")]);
    await c.refreshMessages();
    c.selectMessage("M1");
    c.confirmMessage();
    await c.save();
    expect(post).not.toHaveBeenCalled();
    c.setReason("wrong_coverage_decision", "wrong pack");
    await c.save();
    expect(post).not.toHaveBeenCalled();
    c.setReason("wrong_answer", "");
    await c.save();
    expect(post).toHaveBeenCalledOnce();
  });
  it("does not require a reason on an unchanged answer and performs no reads after close", async () => {
    const post = vi.fn(async () => receipt),
      h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), post);
    await c.connect(h.port);
    c.confirmDraft("unknown");
    h.setMessages([message("M1", "Original draft")]);
    await c.refreshMessages();
    c.selectMessage("M1");
    c.confirmMessage();
    await c.save();
    expect(post).toHaveBeenCalledOnce();
    c.close();
    await c.refreshMessages();
    await c.pollDraft();
    expect(h.read).toHaveBeenCalledTimes(1);
  });
  it("retains data but invalidates an association on a new draft or reviewer in the same conversation", async () => {
    const h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt);
    await ready(c, h);
    h.port.conversation.draftId = undefined;
    await c.connect(h.port);
    expect(c.current()?.sent).toBeNull();
    c.selectMessage("M1");
    c.confirmMessage();
    h.port.teammate.id = "B" as ApplicationTeammateId;
    await c.connect(h.port);
    expect(c.current()?.draftConfirmed).toBe(false);
    expect(c.current()?.origin).toBe("unknown");
    expect(c.current()?.sent).toBeNull();
  });
  it("clones loaded snapshots so an SDK object mutation cannot preserve a stale confirmation", async () => {
    const h = harness(),
      c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt);
    const m = message();
    await c.connect(h.port);
    c.confirmDraft("unknown");
    h.setMessages([m]);
    await c.refreshMessages();
    c.selectMessage("M1");
    c.confirmMessage();
    m.content!.body = "Changed in place";
    await c.refreshMessages();
    expect(c.current()?.sent).toBeNull();
  });
  it("pauses failed automatic draft reads and only retries on an explicit Load draft action", async () => {
    const h = harness(),
      read = vi.fn(async (): Promise<DraftView | undefined> => {
        throw new Error("reader refused");
      });
    h.port.fetchDraft = read;
    const c = new ManualCapture(settingsFrom(new URLSearchParams()), async () => receipt);
    await c.connect(h.port);
    await c.pollDraft();
    expect(read).toHaveBeenCalledOnce();
    read.mockResolvedValue(draft());
    await c.pollDraft(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(c.current()?.draft.text).toBe("Original draft");
  });
  it("does not capture a missing configured decision field as if it were known", async () => {
    const h = harness(),
      c = new ManualCapture(
        { ...settingsFrom(new URLSearchParams()), decisionFields: ["missing"] },
        async () => receipt,
      );
    await c.connect(h.port);
    expect(c.current()).toBeNull();
    expect(c.notice).toContain("fields");
  });
});
