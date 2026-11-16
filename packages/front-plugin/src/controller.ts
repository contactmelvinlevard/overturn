import type { ApplicationPaginationToken } from "@frontapp/plugin-sdk";
import type { CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import { within } from "./async";
import { budgetCapture, CAPTURE_LIMITS, type CaptureLimits } from "./budget";
import {
  buildCapture,
  contentText,
  type DraftSnapshot,
  type FrontPort,
  fieldsFrom,
  type MessageView,
  type Origin,
  type SentSnapshot,
  type Settings,
} from "./capture";

export interface Receipt {
  runId: string;
  kind: "edit" | "approve";
  deduplicated: boolean;
}
export type Post = (body: CaptureCreate) => Promise<Receipt>;
export interface Work {
  key: string;
  conversationId: string;
  subject: string | null;
  draft: DraftSnapshot;
  origin: Origin;
  draftConfirmed: boolean;
  messages: Map<string, MessageView>;
  incomplete: boolean;
  reading: boolean;
  selectedId: string | null;
  sent: SentSnapshot | null;
  reasonCode: string | null;
  note: string;
  status: "review" | "posting" | "saved" | "unknown";
  notice: string;
  receipt: Receipt | null;
  intent: CaptureCreate | null;
  contextOmittedBySize: number;
}
const MAX_PAGES = 5,
  MAX_MESSAGES = 500;
function pair(a: string, b: string): string {
  return JSON.stringify([a, b]);
}
function stamp(m: MessageView): string {
  return JSON.stringify([m.id, m.status, m.content?.type, m.content?.body, m.date, m.from.handle]);
}
export class ManualCapture {
  private port: FrontPort | null = null;
  private epoch = 0;
  private contextIdentity = "";
  private reviewer: string | undefined;
  private draftReading = false;
  private draftFailed = false;
  private closed = false;
  private work = new Map<string, Work>();
  private selection = new Map<string, string>();
  private used = new Set<string>();
  notice = "Open a conversation with a draft.";
  constructor(
    readonly settings: Settings,
    private post: Post,
    private changed: () => void = () => {},
    private now: () => Date = () => new Date(),
    private limits: CaptureLimits = CAPTURE_LIMITS,
  ) {}
  private emit(): void {
    if (!this.closed) this.changed();
  }
  current(): Work | null {
    const id = this.port?.conversation.id;
    return id ? this.work.get(this.selection.get(id) || "") || null : null;
  }
  available(): Work[] {
    return [...this.work.values()].filter((w) => w.conversationId === this.port?.conversation.id);
  }
  private scoped(): boolean {
    return (
      !!this.port &&
      (!this.settings.scopeTag || this.port.conversation.tags.some((t) => t.name === this.settings.scopeTag))
    );
  }
  async connect(port: FrontPort | null): Promise<void> {
    if (this.closed) return;
    const oldIdentity = this.contextIdentity,
      oldReviewer = this.reviewer;
    this.contextIdentity = port ? pair(port.conversation.id, port.conversation.draftId || "") : "";
    this.reviewer = port?.teammate.id;
    this.epoch++;
    this.port = port;
    if (oldIdentity !== this.contextIdentity || oldReviewer !== this.reviewer)
      for (const w of this.work.values())
        if (w.status === "review") {
          w.sent = null;
          w.reasonCode = null;
          w.note = "";
          if (oldReviewer !== undefined && oldReviewer !== port?.teammate.id) {
            w.draftConfirmed = false;
            w.origin = "unknown";
          }
        }
    this.notice = !port
      ? "Select one conversation."
      : !this.scoped()
        ? "This conversation is outside the configured scope."
        : "Confirm a draft snapshot, then choose the actual sent message.";
    for (const w of this.work.values()) {
      if (w.status === "review" && w.sent && w.conversationId === port?.conversation.id) {
        const fields = this.currentFields();
        if (fields === null || JSON.stringify(fields) !== JSON.stringify(w.sent.fields)) {
          w.sent = null;
          w.reasonCode = null;
          w.note = "";
        }
      }
    }
    this.emit();
    await this.pollDraft();
  }
  async pollDraft(manual = false): Promise<void> {
    if (manual) this.draftFailed = false;
    if (this.closed || this.draftFailed || this.draftReading || !this.port || !this.scoped()) return;
    const port = this.port,
      epoch = this.epoch,
      id = port.conversation.draftId;
    if (!id) return;
    const key = pair(port.conversation.id, id);
    if (this.work.has(key)) return;
    this.draftReading = true;
    try {
      const draft = await within(port.fetchDraft(id), 10000);
      if (this.closed || epoch !== this.epoch || this.port !== port || !draft || draft.id !== id) return;
      const text = contentText(draft.content);
      if (!text || text.length > 200000) {
        this.notice = "The draft needs a loaded text body of at most 200,000 characters.";
        return;
      }
      if (this.work.has(key)) return;
      const item: Work = {
        key,
        conversationId: port.conversation.id,
        subject: port.conversation.subject || null,
        draft: { id, text, observedAt: this.now().toISOString(), fields: fieldsFrom(port, this.settings) },
        origin: "unknown",
        draftConfirmed: false,
        messages: new Map(),
        incomplete: true,
        reading: false,
        selectedId: null,
        sent: null,
        reasonCode: null,
        note: "",
        status: "review",
        notice: "First observed draft snapshot. Its original source has not been verified.",
        receipt: null,
        intent: null,
        contextOmittedBySize: 0,
      };
      this.work.set(key, item);
      const selected = this.current();
      if (!selected || selected.status === "saved") this.selection.set(item.conversationId, key);
    } catch {
      if (!this.closed && epoch === this.epoch && this.port === port) {
        this.draftFailed = true;
        this.notice =
          "The draft or its configured decision fields could not be read. Automatic draft reads are paused; use Load draft to retry.";
      }
    } finally {
      this.draftReading = false;
      this.emit();
    }
  }
  chooseWork(key: string): void {
    const w = this.work.get(key);
    if (!w || w.conversationId !== this.port?.conversation.id || !this.scoped()) return;
    this.selection.set(w.conversationId, key);
    this.emit();
  }
  setDraftOrigin(origin: Origin): void {
    const w = this.editable();
    if (!w || w.origin === origin) return;
    w.origin = origin;
    w.draftConfirmed = false;
    w.sent = null;
    w.reasonCode = null;
    w.note = "";
    w.notice = "Draft origin changed. Confirm the draft and the message association again.";
    this.emit();
  }
  confirmDraft(origin: Origin): void {
    const w = this.editable();
    if (!w) return;
    w.origin = origin;
    w.draftConfirmed = true;
    w.sent = null;
    w.reasonCode = null;
    w.note = "";
    this.emit();
  }
  private editable(): Work | null {
    const w = this.current();
    return !this.closed && this.scoped() && w?.status === "review" ? w : null;
  }
  canEdit(): boolean {
    return this.editable() !== null;
  }
  currentFields(): ReturnType<typeof fieldsFrom> | null {
    if (!this.port) return null;
    try {
      return fieldsFrom(this.port, this.settings);
    } catch {
      return null;
    }
  }
  clearAssociation(): void {
    const w = this.editable();
    if (!w) return;
    w.sent = null;
    w.reasonCode = null;
    w.note = "";
    w.notice = "Association cancelled. Review and confirm the message before saving.";
    this.emit();
  }
  async refreshMessages(): Promise<void> {
    const w = this.editable(),
      port = this.port,
      epoch = this.epoch;
    if (!w || !port || !w.draftConfirmed || w.reading) return;
    w.reading = true;
    w.notice = "Loading sent messages…";
    this.emit();
    const messages = new Map<string, MessageView>(),
      tokens = new Set<string>();
    let token: ApplicationPaginationToken | undefined,
      incomplete = false;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await within(port.listMessages(token), 10000);
        if (this.closed || epoch !== this.epoch || this.port !== port || this.current() !== w) return;
        for (const m of result.results) {
          const prior = messages.get(m.id);
          if (prior && stamp(prior) !== stamp(m)) incomplete = true;
          if (messages.size >= MAX_MESSAGES && !prior) {
            incomplete = true;
            break;
          }
          messages.set(m.id, structuredClone(m));
        }
        const next = result.nextPageToken;
        if (!next) break;
        if (tokens.has(next) || page === MAX_PAGES - 1 || messages.size >= MAX_MESSAGES) {
          incomplete = true;
          break;
        }
        tokens.add(next);
        token = next;
      }
      if (w.sent) {
        const before = w.messages.get(w.sent.id),
          after = messages.get(w.sent.id);
        if (!before || !after || stamp(before) !== stamp(after)) {
          w.sent = null;
          w.reasonCode = null;
          w.note = "";
          w.notice = "The selected message changed or is not loaded. Review and confirm it again.";
        }
      }
      w.messages = messages;
      w.incomplete = incomplete || [...messages.values()].some((m) => !m.content);
      if (w.sent) w.notice = "Message confirmation kept for the same immutable snapshot.";
      else if (w.selectedId) w.notice = "Review and confirm the selected loaded message.";
      else w.notice = "Choose the message you sent. The panel never associates messages automatically.";
    } catch {
      if (!this.closed && epoch === this.epoch) {
        w.incomplete = true;
        w.sent = null;
        w.reasonCode = null;
        w.note = "";
        w.notice = "Messages could not be loaded. The draft is kept; refresh to try again.";
      }
    } finally {
      w.reading = false;
      this.emit();
    }
  }
  selectMessage(id: string): void {
    const w = this.editable();
    if (!w || w.reading || !w.draftConfirmed) return;
    const m = w.messages.get(id);
    if (m?.status !== "outbound") return;
    w.selectedId = id;
    w.sent = null;
    w.reasonCode = null;
    w.note = "";
    this.emit();
  }
  confirmMessage(): void {
    const w = this.editable(),
      port = this.port;
    if (!w || !port || w.reading || !w.draftConfirmed || !w.selectedId) return;
    const m = w.messages.get(w.selectedId);
    if (
      m?.status !== "outbound" ||
      !m.content ||
      !(m.date instanceof Date) ||
      !Number.isFinite(m.date.getTime())
    )
      return;
    const text = contentText(m.content);
    if (!text || text.length > 200000 || this.used.has(pair(w.conversationId, m.id))) {
      w.notice = "This message is empty, too long, or already has a capture attempt.";
      this.emit();
      return;
    }
    try {
      w.sent = {
        id: m.id,
        text,
        sentAt: m.date.toISOString(),
        senderAddress: m.from.handle,
        fields: fieldsFrom(port, this.settings),
        confirmedAt: this.now().toISOString(),
      };
    } catch {
      w.sent = null;
      w.notice = "Configured decision fields must be uniquely loaded text, number, boolean or date values.";
      this.emit();
      return;
    }
    w.notice = "You confirmed this association. Front does not verify the sender's human identity.";
    this.emit();
  }
  setReason(code: string | null, note: string): void {
    const w = this.editable();
    if (!w?.sent) return;
    w.reasonCode = code;
    w.note = note;
  }
  async save(): Promise<void> {
    const w = this.editable(),
      port = this.port;
    if (!w || !port || !w.draftConfirmed || !w.sent || w.reading) return;
    const logical = pair(w.conversationId, w.sent.id);
    if (this.used.has(logical)) return;
    let clipped = false;
    const sentAt = Date.parse(w.sent.sentAt);
    const tied = [...w.messages.values()].some(
      (m) => m.id !== w.sent?.id && m.date instanceof Date && m.date.getTime() === sentAt,
    );
    const context: CaptureMessage[] = [...w.messages.values()]
      .filter(
        (m) =>
          m.id !== w.sent?.id &&
          m.content &&
          m.date instanceof Date &&
          Number.isFinite(m.date.getTime()) &&
          m.date.getTime() < sentAt,
      )
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map((m) => {
        const text = contentText(m.content!);
        if (text.length > 200000) clipped = true;
        return {
          role: m.status === "inbound" ? "customer" : "agent",
          author: null,
          content: text.slice(0, 200000),
          at: m.date.toISOString(),
        };
      });
    let body: CaptureCreate;
    try {
      body = buildCapture(
        {
          conversationId: w.conversationId,
          subject: w.subject,
          draft: w.draft,
          sent: w.sent,
          origin: w.origin,
          reviewerId: port.teammate.id,
          reasonCode: w.reasonCode,
          reason: w.note,
          context,
          contextIncomplete: w.incomplete || clipped || tied,
        },
        this.settings,
      );
    } catch (error) {
      w.notice = error instanceof Error ? error.message : "Review the capture.";
      this.emit();
      return;
    }
    try {
      const packed = budgetCapture(body, this.limits);
      body = packed.body;
      w.contextOmittedBySize = packed.omitted;
      if (packed.omitted) w.incomplete = true;
    } catch (error) {
      w.notice = error instanceof Error ? error.message : "The capture is too large.";
      this.emit();
      return;
    }
    w.intent = structuredClone(body);
    w.status = "posting";
    this.used.add(logical);
    w.notice = "Saving the confirmed capture…";
    this.emit();
    try {
      const receipt = await this.post(structuredClone(w.intent));
      w.receipt = receipt;
      w.status = "saved";
      w.notice = "Capture saved.";
    } catch {
      w.status = "unknown";
      w.notice =
        "Capture result unknown. Your data is kept. Check Overturn before making another attempt; this panel will not resend it.";
    }
    this.emit();
  }
  close(): void {
    this.closed = true;
    this.epoch++;
    this.port = null;
  }
}
