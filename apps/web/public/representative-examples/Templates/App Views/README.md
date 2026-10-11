# App Views

Familiar app layouts built with embedded HTML views. Open **Templates → App Views** in JSON Views. Data is fictional and API-shaped, not captured from live accounts; responses are shortened to the fields used by the examples. `$jsonviews` is local presentation metadata, not an API response field. LinkedIn is explicitly a UI mock.

Edits only change the local JSON. These fixtures are not write-request bodies or live integrations. Nullable, optional, and differently ordered fields in other responses require adapting the bindings. Only built-in text formatting runs in the views: currency, dates, explicit labels, and UTF-8 base64url decoding. No scripts or API calls run inside templates.

See the [HTML views reference](https://github.com/script-it/json-views/blob/main/skills/json-views/references/html-views.md) for bindings and restrictions. API documentation reviewed on 2026-10-07.

## Gmail Message

A Gmail message with editable headers and a decoded, editable plain-text MIME body.

GET /gmail/v1/users/me/messages/{id}?format=full. Headers are a name/value array; this fixture binds its known header order. Locate headers by name before adapting another message. The view decodes this known text/plain body as UTF-8; edits re-encode body.data as base64url and update body.size atomically. Multipart messages require traversing payload.parts and may require attachments.get.

References: [developers.google.com](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages), [developers.google.com](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments).

## HubSpot Contacts

A CRM v3 contact list with editable names, companies, email addresses, and lead statuses.

GET /crm/v3/objects/contacts?limit=100&properties=firstname,lastname,email,company,hs_lead_status,hubspot_owner_id,notes_last_updated. Explicitly request these properties. This is a final list page, so paging is omitted; list responses do not include the search API total. Owner values are IDs; resolve names with the Owners API. Notes are separate CRM objects, not a default notes property.

References: [developers.hubspot.com](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide), [developers.hubspot.com](https://developers.hubspot.com/docs/api-reference/legacy/crm/owners/guide).

## Slack Channel

Channel history with native user IDs, message timestamps, reactions, and reply counts.

GET https://slack.com/api/conversations.history?channel=C08LAUNCH. Messages are newest first; user contains an ID and ts is a Unix-seconds string. Reactions and reply_count are optional and populated in this fixture. Channel names, user names, thread replies, and permalinks require conversations.info, users.info, conversations.replies, and chat.getPermalink respectively; they are not invented history fields. Slack mrkdwn is shown as plain text. The view reverses the newest-first API array without changing source order. The channel title, user-name/initial labels, and emoji lookup are explicit fictional presentation context; a real integration must populate them from the companion APIs. Times use Asia/Jerusalem. The date divider covers this single-day fixture.

References: [docs.slack.dev](https://docs.slack.dev/reference/methods/conversations.history/), [docs.slack.dev](https://docs.slack.dev/messaging/retrieving-messages/).

## Notion Project

A Notion page with editable title, description, assignee name, and due date.

GET /v1/pages/{page_id}, using the data_source_id parent model introduced in Notion-Version 2025-09-03. Name, Status, Assign, Due Date, Priority, and Description are example data-source properties, not universal page fields. Description is a rich_text property, not page body blocks (those come from blocks.children.list). Text edits update text.content and plain_text together. The assignee name and due date edit directly; status and priority stay read-only to preserve their name/id pairs.

References: [developers.notion.com](https://developers.notion.com/reference/page), [developers.notion.com](https://developers.notion.com/reference/parent-object), [developers.notion.com](https://developers.notion.com/reference/rich-text).

## Stripe Payments

A familiar payments table with editable amounts, statuses, descriptions, notes, and billing contacts.

GET /v1/payment_intents?limit=3&expand[]=data.payment_method. This is a shortened response fixture: unused fields, card details, and client_secret are omitted. billing_details belongs to the expanded PaymentMethod, not PaymentIntent. amount remains an integer in minor currency units; the view formats it as currency and created as a date/time in Asia/Jerusalem. Amount edits use major units and update amount_received alongside amount for this fully received fixture; adapt that pairing for other payment states. receipt_note is an example user-defined metadata key. There are no fabricated display_amount, display_date, or summary fields.

References: [docs.stripe.com](https://docs.stripe.com/api/payment_intents/list), [docs.stripe.com](https://docs.stripe.com/api/payment_intents/object), [docs.stripe.com](https://docs.stripe.com/api/payment_methods/object).

## LinkedIn Messages (Mock)

An explicitly illustrative messaging mock; not a LinkedIn API response.

The provided conversation is a normalized UI mock, not a documented LinkedIn response. LinkedIn Messages API access is restricted to approved partners; its public documentation does not establish this inbox shape. No API compatibility is claimed. The draft field is local-only.

References: [learn.microsoft.com](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages).

Layout references: [Slack channel guide](https://slack.com/help/articles/360059928654-How-to-use-Slack--your-quick-start-guide/), [Stripe payment lists](https://support.stripe.com/questions/exporting-payment-data).
