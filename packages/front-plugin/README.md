# Overturn for Front

Use the sidebar to pair the first draft the panel observed with the reply you actually sent. You confirm both the draft’s origin and its association with the outgoing message.

## Install the sidebar

1. From the workspace root, run `pnpm --filter @overturn-ai/front-plugin build`. Serve the contents of `packages/front-plugin/dist/app/` over HTTPS. The build also packages those files in `dist/overturn-front-plugin.zip` inside the package.
2. In your Front app configuration, set the sidebar URL to the hosted `index.html`.
3. In the Front Developer Portal, configure a Server for the app with the HTTPS base URL of your Overturn instance. Select bearer authentication and configure the Overturn project credential on the server side. Associate that Server with the plugin. The sidebar calls the fixed relative route `POST /v1/capture` through `Front.sendHttp`. Keep credentials out of the sidebar URL and browser bundle. [Front app configuration](https://dev.frontapp.com/docs/create-and-manage-apps)

Append any required settings to the sidebar URL as query parameters.

| Setting | Effect |
| --- | --- |
| `agent` | Overturn workflow name. Defaults to `support-reply`. |
| `reason_pack` | Use `support` (default) or `claims` for the reason picker. |
| `require_reason` | Defaults to `true`. Set to `false` to allow saving a changed reply without a reason code. |
| `scope_tag` | Optional Front tag that limits capture to matching conversations. |
| `decision_fields` | Comma-separated Front custom field names. Each must match one field containing text, a finite number, a boolean, a date or null. A missing or ambiguous field or an unsupported value prevents capture. |

## Record a reply

1. Open a conversation with a draft. Review the frozen text and confirm the draft. Leave its origin as unknown unless you can attest that it was AI-assisted or written manually.
2. Send the reply normally in Front. Refresh the messages, select the outgoing reply by its text, and confirm its association with this draft. If decision fields are configured, review their current values before confirming them for this reply. A change to those values requires fresh confirmation. Clearing the confirmation also clears the reason. Only an outgoing message with a loaded body is eligible.
3. Choose a reason for a change when required, then save the capture. The reason check applies to saving in Overturn. Front’s native Send remains available.

The capture records the reviewer’s ID and sets `actor` to `unknown`. A shared sending address cannot identify the teammate. Draft origin is the reviewer’s attestation, and `secondsToSend` stays null.

## Limits and recovery

- Context includes loaded public message text strictly earlier than the confirmed reply, up to five pages or 500 messages per refresh. A message with the same timestamp is omitted and flags a gap because its order is ambiguous. Internal notes and attachment contents are excluded. A known gap sets `contextIncomplete` to true. A null value means completeness is unknown.
- The panel allows 512 KiB of context and 2 MiB for the full capture, measured as UTF-8 JSON. It keeps recent eligible messages first, reports omissions and sets `contextIncomplete` to true when it drops a message. If the full capture still exceeds 2 MiB, validation stops before the draft and reply are reserved or any request is sent. You can edit the note and try saving again.
- Switching conversations clears the outgoing-message confirmation. Closing or reloading the panel clears all pending work from memory.
- Each SDK read times out after 10 seconds. If a draft read fails, use **Load draft** to resume. A save times out after 15 seconds. When its outcome is unknown, check Overturn for the capture. The panel retains the attempt in memory and disables resending it.

A simulated browser session exercised this workflow locally. Live Front verification, including server authentication, and sponsor acceptance of manual association are outstanding.
