import { REASON_PACKS } from "@overturn-ai/shared/capture";
import { contentText, type Origin } from "./capture";
import type { ManualCapture } from "./controller";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}
export function mount(root: HTMLElement, controller: ManualCapture): () => void {
  let generation = 0;
  return function render(): void {
    const mine = ++generation;
    const action = (fn: () => void) => (): void => {
      if (mine === generation) fn();
    };
    root.replaceChildren();
    const head = node("header");
    head.append(
      node("h1", "Capture a confirmed correction"),
      node(
        "p",
        "Associate a draft with a reply you have already sent. This panel never holds Front’s Send button.",
      ),
    );
    root.append(head);
    const load = node("button", "Load draft");
    load.onclick = action(() => void controller.pollDraft(true));
    root.append(load);
    const status = node("p", controller.notice);
    status.className = "status";
    status.setAttribute("role", "status");
    root.append(status);
    const works = controller.available(),
      w = controller.current();
    if (!w) {
      root.append(node("p", "Load a draft in the selected conversation, then refresh here."));
      return;
    }
    if (works.length > 1) {
      const label = node("label", "Draft to review");
      const chooser = node("select");
      chooser.setAttribute("aria-label", "Draft to review");
      for (const item of works) {
        const opt = node("option", `${item.draft.id} · ${item.status}`);
        opt.value = item.key;
        opt.selected = item.key === w.key;
        chooser.append(opt);
      }
      chooser.onchange = action(() => controller.chooseWork(chooser.value));
      label.append(chooser);
      root.append(label);
    }
    const editable = controller.canEdit();
    const draftSection = node("section");
    draftSection.append(
      node("h2", "1. Confirm the draft"),
      node("p", `First observed snapshot · ${w.draft.id}`),
    );
    const draft = node("pre", w.draft.text);
    draft.setAttribute("aria-label", "Draft snapshot");
    draftSection.append(draft);
    if (controller.settings.decisionFields.length) {
      draftSection.append(
        node("p", "Decision fields in the observed draft snapshot"),
        node("pre", JSON.stringify(w.draft.fields, null, 2)),
      );
    }
    const originLabel = node("label", "Draft origin");
    const origin = node("select");
    origin.setAttribute("aria-label", "Draft origin");
    origin.disabled = !editable;
    origin.onchange = action(() => controller.setDraftOrigin(origin.value as Origin));
    for (const [value, label] of [
      ["unknown", "Unknown"],
      ["attested-ai", "AI · attested by me"],
      ["attested-manual", "Manual · attested by me"],
    ]) {
      const opt = node("option", label);
      opt.value = value || "unknown";
      opt.selected = value === w.origin;
      origin.append(opt);
    }
    originLabel.append(origin);
    draftSection.append(
      originLabel,
      node("p", "Choosing AI is your attestation, not a provenance check by Front."),
    );
    const confirmDraft = node(
      "button",
      w.draftConfirmed ? "Confirm draft and origin again" : "Confirm this draft and origin",
    );
    confirmDraft.disabled = !editable;
    confirmDraft.onclick = action(() => controller.confirmDraft(origin.value as Origin));
    draftSection.append(confirmDraft);
    root.append(draftSection);
    const sentSection = node("section");
    sentSection.append(node("h2", "2. Choose the reply you sent"));
    const refresh = node("button", w.reading ? "Loading messages…" : "Refresh sent messages");
    refresh.disabled = !editable || !w.draftConfirmed || w.reading;
    refresh.onclick = action(() => void controller.refreshMessages());
    sentSection.append(refresh);
    const messages = node("select");
    messages.setAttribute("aria-label", "Sent message");
    messages.disabled = !editable || !w.draftConfirmed || w.reading;
    const blank = node("option", "Choose a real sent message");
    blank.value = "";
    messages.append(blank);
    const out = [...w.messages.values()]
      .filter((m) => m.status === "outbound")
      .sort((a, b) => b.date.getTime() - a.date.getTime());
    for (const m of out) {
      const text = m.content ? contentText(m.content) : "";
      const opt = node("option", `${m.id} · ${text ? text.slice(0, 70) : "Body not loaded — refresh"}`);
      opt.value = m.id;
      opt.disabled = !text;
      opt.selected = m.id === w.selectedId;
      messages.append(opt);
    }
    messages.onchange = action(() => controller.selectMessage(messages.value));
    sentSection.append(messages);
    const selected = w.selectedId ? w.messages.get(w.selectedId) : null;
    if (selected) {
      sentSection.append(
        node("p", `Message ${selected.id} · sender address ${selected.from.handle} · human author unknown`),
      );
      const preview = node(
        "pre",
        selected.content
          ? contentText(selected.content)
          : "Body not loaded. Refresh messages before confirming.",
      );
      preview.setAttribute("aria-label", "Sent message preview");
      sentSection.append(preview);
      const fields = w.sent?.fields ?? controller.currentFields();
      if (controller.settings.decisionFields.length) {
        sentSection.append(
          node(
            "p",
            w.sent
              ? "Confirmed decision-field snapshot"
              : "Current decision fields. Confirm only if these values were used for this reply.",
          ),
          node("pre", fields === null ? "Configured fields unavailable" : JSON.stringify(fields, null, 2)),
        );
      }
      const label = node("label"),
        check = node("input");
      check.type = "checkbox";
      check.checked = w.sent?.id === selected.id;
      check.disabled = !editable || !selected.content || w.reading || fields === null;
      label.append(
        check,
        document.createTextNode(
          controller.settings.decisionFields.length
            ? "I confirm this sent message and the displayed field values belong with the draft above."
            : "I confirm this sent message belongs with the draft above.",
        ),
      );
      const confirm = node("button", w.sent ? "Association confirmed" : "Confirm this association");
      confirm.disabled = !check.checked || !!w.sent;
      check.onchange = action(() => {
        if (!check.checked && w.sent) controller.clearAssociation();
        else confirm.disabled = !check.checked;
      });
      confirm.onclick = action(() => {
        if (check.checked) controller.confirmMessage();
      });
      sentSection.append(label, confirm);
    }
    sentSection.append(
      node("p", "Only Front-loaded messages are available. This may be a partial conversation."),
    );
    if (w.incomplete)
      sentSection.append(
        node("p", "Some conversation context is not included. The capture records this limit."),
      );
    root.append(sentSection);
    if (w.contextOmittedBySize)
      root.append(
        node(
          "p",
          w.contextOmittedBySize +
            " earlier messages were omitted to keep the capture within its size limit.",
        ),
      );
    const reason = node("section");
    reason.append(node("h2", "3. Save the capture"));
    const label = node("label", "Why did you change it?");
    const codes = node("select");
    codes.setAttribute("aria-label", "Reason");
    codes.disabled = !editable || !w.sent;
    const noReason = node("option", "Choose a reason");
    noReason.value = "";
    codes.append(noReason);
    for (const r of REASON_PACKS[controller.settings.reasonPack]) {
      const option = node("option", r.label);
      option.value = r.code;
      option.selected = w.reasonCode === r.code;
      codes.append(option);
    }
    const note = node("textarea");
    note.setAttribute("aria-label", "Optional note");
    note.placeholder = "Optional detail";
    note.maxLength = 10000;
    note.value = w.note;
    note.disabled = !editable || !w.sent;
    codes.onchange = action(() => controller.setReason(codes.value || null, note.value));
    note.oninput = action(() => controller.setReason(codes.value || null, note.value));
    label.append(codes);
    reason.append(label, note);
    const save = node(
      "button",
      w.status === "posting" ? "Saving…" : w.status === "saved" ? "Capture saved" : "Save confirmed capture",
    );
    save.disabled = !editable || !w.draftConfirmed || !w.sent || w.reading;
    save.onclick = action(() => void controller.save());
    reason.append(save);
    const notice = node("p", w.notice);
    notice.className = "status";
    notice.setAttribute("role", "status");
    reason.append(notice);
    if (w.receipt)
      reason.append(
        node(
          "p",
          `Record ${w.receipt.runId}${w.receipt.deduplicated ? " · Existing suite case reused" : ""}`,
        ),
      );
    if (w.status === "unknown")
      reason.append(
        node("p", "Keep this panel open. The data remains here, and no second request will be sent."),
      );
    root.append(reason, node("footer", "Review data stays only in this open panel until it is saved."));
  };
}
