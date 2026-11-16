// @vitest-environment jsdom

import type {
  ApplicationConversationId,
  ApplicationDraftId,
  ApplicationMessageId,
  ApplicationTeammateId,
} from "@frontapp/plugin-sdk";
import type { CaptureCreate } from "@overturn-ai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { type FrontPort, settingsFrom } from "./capture";
import { ManualCapture, type Receipt } from "./controller";
import { mount } from "./ui";

afterEach(() => document.body.replaceChildren());
it("invalidates a confirmed AI origin when the operator selects Unknown without confirming again", async () => {
  const root = document.createElement("main");
  document.body.append(root);
  let render = () => {};
  const post = vi.fn(
    async (_body: CaptureCreate): Promise<Receipt> => ({
      runId: "00000000-0000-4000-8000-000000000001",
      kind: "edit",
      deduplicated: false,
    }),
  );
  const c = new ManualCapture(settingsFrom(new URLSearchParams()), post, () => render());
  render = mount(root, c);
  const p: FrontPort = {
    conversation: {
      id: "C" as ApplicationConversationId,
      draftId: "D" as ApplicationDraftId,
      subject: "Example",
      tags: [],
      customFieldAttributes: [],
    },
    teammate: { id: "A" as ApplicationTeammateId, email: "a@example.test" },
    fetchDraft: async () => ({
      id: "D" as ApplicationDraftId,
      subject: undefined,
      content: { body: "Draft", type: "text", attachments: [] },
    }),
    listMessages: async () => ({
      nextPageToken: undefined,
      results: [
        {
          id: "M" as ApplicationMessageId,
          status: "outbound",
          date: new Date(),
          from: { handle: "support@example.test", name: undefined, type: "email", contact: undefined },
          content: { body: "Revised", type: "text", attachments: [] },
        },
      ],
    }),
  };
  await c.connect(p);
  c.confirmDraft("attested-ai");
  await c.refreshMessages();
  c.selectMessage("M");
  c.confirmMessage();
  c.setReason("wrong_answer", "reason");
  expect(button(root, "Save confirmed capture").disabled).toBe(false);
  const origin = root.querySelector<HTMLSelectElement>('[aria-label="Draft origin"]')!;
  origin.value = "unknown";
  origin.dispatchEvent(new Event("change"));
  expect(c.current()?.draftConfirmed).toBe(false);
  expect(c.current()?.sent).toBeNull();
  expect(c.current()?.reasonCode).toBeNull();
  expect(button(root, "Save confirmed capture").disabled).toBe(true);
  await c.save();
  expect(post).not.toHaveBeenCalled();
  button(root, "Confirm this draft and origin").click();
  c.selectMessage("M");
  c.confirmMessage();
  c.setReason("wrong_answer", "");
  await c.save();
  expect(post.mock.calls[0]?.[0].tags).toContain("draft:unknown");
  expect(post.mock.calls[0]?.[0].tags).not.toContain("draft:ai");
});
function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(label);
  return found;
}
it("renders inert text and completes both visible confirmations before one capture", async () => {
  const root = document.createElement("main");
  document.body.append(root);
  const post = vi.fn(
    async (_body: CaptureCreate): Promise<Receipt> => ({
      runId: "00000000-0000-4000-8000-000000000001",
      kind: "edit",
      deduplicated: false,
    }),
  );
  let render = () => {};
  const c = new ManualCapture(settingsFrom(new URLSearchParams()), post, () => render());
  render = mount(root, c);
  const p: FrontPort = {
    conversation: {
      id: "C" as ApplicationConversationId,
      draftId: "D" as ApplicationDraftId,
      subject: "Example",
      tags: [],
      customFieldAttributes: [],
    },
    teammate: { id: "A" as ApplicationTeammateId, email: "alice@example.test" },
    fetchDraft: async () => ({
      id: "D" as ApplicationDraftId,
      subject: undefined,
      content: { body: "<p>Original &amp; safe</p><script>alert(1)</script>", type: "html", attachments: [] },
    }),
    listMessages: async () => ({
      nextPageToken: undefined,
      results: [
        {
          id: "M" as ApplicationMessageId,
          status: "outbound",
          date: new Date(),
          from: { handle: "support@example.test", name: undefined, type: "email", contact: undefined },
          content: { body: 'Literal <img src=x onerror="alert(1)"> reply', type: "text", attachments: [] },
        },
      ],
    }),
  };
  await c.connect(p);
  expect(root.querySelector("script")).toBeNull();
  expect(root.textContent).toContain("Original & safe");
  button(root, "Confirm this draft and origin").click();
  button(root, "Refresh sent messages").click();
  await vi.waitFor(() => expect(root.querySelectorAll('[aria-label="Sent message"] option')).toHaveLength(2));
  const messages = root.querySelector<HTMLSelectElement>('[aria-label="Sent message"]')!;
  messages.value = "M";
  messages.dispatchEvent(new Event("change"));
  expect(root.querySelector("img")).toBeNull();
  expect(root.textContent).toContain("Literal <img");
  expect(post).not.toHaveBeenCalled();
  expect(button(root, "Save confirmed capture").disabled).toBe(true);
  const stale = button(root, "Confirm this association");
  const check = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  check.checked = true;
  check.dispatchEvent(new Event("change"));
  stale.click();
  expect(root.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  const revoke = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  revoke.checked = false;
  revoke.dispatchEvent(new Event("change"));
  expect(c.current()?.sent).toBeNull();
  expect(button(root, "Save confirmed capture").disabled).toBe(true);
  const reconfirm = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  reconfirm.checked = true;
  reconfirm.dispatchEvent(new Event("change"));
  button(root, "Confirm this association").click();
  const reason = root.querySelector<HTMLSelectElement>('[aria-label="Reason"]')!;
  reason.value = "wrong_answer";
  reason.dispatchEvent(new Event("change"));
  button(root, "Save confirmed capture").click();
  await vi.waitFor(() => expect(c.current()?.status).toBe("saved"));
  expect(post).toHaveBeenCalledOnce();
  expect(post.mock.calls[0]?.[0].actor).toBe("unknown");
  expect(root.textContent).toContain("Capture saved");
  stale.click();
  expect(post).toHaveBeenCalledOnce();
});
it("rejects a stale confirmation handler after a message selection change", async () => {
  const root = document.createElement("main");
  document.body.append(root);
  let render = () => {};
  const c = new ManualCapture(
    settingsFrom(new URLSearchParams()),
    async () => {
      throw new Error("not called");
    },
    () => render(),
  );
  render = mount(root, c);
  const p: FrontPort = {
    conversation: {
      id: "C" as ApplicationConversationId,
      draftId: "D" as ApplicationDraftId,
      subject: "Example",
      tags: [],
      customFieldAttributes: [],
    },
    teammate: { id: "A" as ApplicationTeammateId, email: "a@example.test" },
    fetchDraft: async () => ({
      id: "D" as ApplicationDraftId,
      subject: undefined,
      content: { body: "Draft", type: "text", attachments: [] },
    }),
    listMessages: async () => ({
      nextPageToken: undefined,
      results: ["M1", "M2"].map((id) => ({
        id: id as ApplicationMessageId,
        status: "outbound" as const,
        date: new Date(),
        from: { handle: "support@example.test", name: undefined, type: "email", contact: undefined },
        content: { body: id, type: "text" as const, attachments: [] },
      })),
    }),
  };
  await c.connect(p);
  c.confirmDraft("unknown");
  await c.refreshMessages();
  c.selectMessage("M1");
  const old = button(root, "Confirm this association"),
    check = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  check.checked = true;
  check.dispatchEvent(new Event("change"));
  c.selectMessage("M2");
  old.click();
  expect(c.current()?.sent).toBeNull();
});
