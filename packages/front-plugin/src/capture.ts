import type {
  ApplicationDraft,
  ApplicationDraftId,
  ApplicationMessage,
  ApplicationPaginationToken,
  SingleConversationContext,
} from "@frontapp/plugin-sdk";
import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

export type DraftView = Pick<ApplicationDraft, "id" | "content" | "subject">;
export type MessageView = Pick<ApplicationMessage, "id" | "date" | "status" | "content" | "from">;
export interface Page {
  results: readonly MessageView[];
  nextPageToken: ApplicationPaginationToken | undefined;
}
export interface FrontPort {
  conversation: Pick<
    SingleConversationContext["conversation"],
    "id" | "draftId" | "subject" | "tags" | "customFieldAttributes"
  >;
  teammate: Pick<SingleConversationContext["teammate"], "id" | "email">;
  fetchDraft(id: ApplicationDraftId): Promise<DraftView | undefined>;
  listMessages(token?: ApplicationPaginationToken): Promise<Page>;
}
export interface Settings {
  agent: string;
  requireReason: boolean;
  reasonPack: ReasonPack;
  scopeTag: string | null;
  decisionFields: string[];
}
export function settingsFrom(query: URLSearchParams): Settings {
  return {
    agent: (query.get("agent") || "support-reply").slice(0, 200),
    requireReason: query.get("require_reason") !== "false",
    reasonPack: reasonPackFrom(query.get("reason_pack")),
    scopeTag: query.get("scope_tag") || null,
    decisionFields: (query.get("decision_fields") || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  };
}
/** Text only. The UI always renders this with textContent, never innerHTML. */
export function contentText(part: { body: string; type: "html" | "text" }): string {
  if (part.type === "text") return normalizeCaptureText(part.body);
  return normalizeCaptureText(
    part.body
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (whole: string, entity: string) => {
        const named: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
        if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
        const n = entity.toLowerCase().startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
          ? String.fromCodePoint(n)
          : whole;
      }),
  );
}
type Fields = NonNullable<CaptureAnswer["fields"]>;
export function fieldsFrom(port: FrontPort, settings: Settings): Fields {
  const out: Fields = {};
  for (const name of settings.decisionFields) {
    const matches = port.conversation.customFieldAttributes.filter((f) => f.name === name);
    if (matches.length !== 1) throw new Error("A configured decision field is missing or ambiguous.");
    const f = matches[0]!;
    const v: unknown = f.value;
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      out[f.name] = v;
    else if (v instanceof Date && Number.isFinite(v.getTime())) out[f.name] = v.toISOString();
    else throw new Error("A configured decision field has an unsupported value.");
  }
  return out;
}
export type Origin = "unknown" | "attested-ai" | "attested-manual";
export interface DraftSnapshot {
  id: ApplicationDraftId;
  text: string;
  observedAt: string;
  fields: Fields;
}
export interface SentSnapshot {
  id: string;
  text: string;
  sentAt: string;
  senderAddress: string;
  fields: Fields;
  confirmedAt: string;
}
export interface BuildInput {
  conversationId: string;
  subject: string | null;
  draft: DraftSnapshot;
  sent: SentSnapshot;
  origin: Origin;
  reviewerId: string;
  reasonCode: string | null;
  reason: string;
  context: CaptureMessage[];
  contextIncomplete: boolean;
}
/** Uses the same schema, normalized comparison and reason packs as the Zendesk reference. */
export function buildCapture(input: BuildInput, settings: Settings): CaptureCreate {
  const draft = { text: input.draft.text, fields: input.draft.fields },
    sent = { text: input.sent.text, fields: input.sent.fields };
  const changed = diffCaptureAnswers(draft, sent).changed;
  const code = input.reasonCode?.trim() || null;
  if (code && !REASON_PACKS[settings.reasonPack].some((r) => r.code === code))
    throw new Error("Choose a reason from the installed pack.");
  if (changed && settings.requireReason && !code)
    throw new Error("Choose why the reply changed before saving the capture.");
  if (input.reason.length > 10000) throw new Error("The optional note is too long.");
  return {
    // API controller fills a null actor from user-key auth. An explicit unknown sentinel avoids a false attribution.
    source: "front",
    externalId: `fr:${input.conversationId}`,
    agent: settings.agent,
    actor: "unknown",
    subject: input.subject?.slice(0, 2000) ?? null,
    context: input.context,
    draft,
    sent,
    reason: input.reason.trim() || null,
    reasonCode: changed ? code : null,
    secondsToSend: null,
    draftModel: null,
    draftProvider: null,
    draftRunId: null,
    url: null,
    tags: [
      "draft:" +
        (input.origin === "attested-ai" ? "ai" : input.origin === "attested-manual" ? "manual" : "unknown"),
      "public-reply",
      "association:operator-confirmed",
    ],
    metadata: {
      frontDraftId: input.draft.id,
      frontMessageId: input.sent.id,
      association: "operator_confirmed",
      originEvidence: input.origin,
      confirmedByReviewerId: input.reviewerId,
      sentAuthorEvidence: "unknown",
      senderAddress: input.sent.senderAddress,
      draftObservedAt: input.draft.observedAt,
      messageSentAt: input.sent.sentAt,
      associationConfirmedAt: input.sent.confirmedAt,
      decisionFieldsEvidence: Object.keys(input.sent.fields).length
        ? "operator_attested_current_snapshot"
        : "not_collected",
      contextTimeBound: "strictly_before_selected_message_date",
      contextSource: "front_loaded_messages",
      contextIncomplete: input.contextIncomplete ? true : null,
    },
  };
}
