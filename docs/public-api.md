# Public API (`/api/v1`)

The public API lets you drive your wacrm instance from your own
scripts and automations — send messages, manage contacts, launch
broadcasts — without going through the dashboard UI.

> **Status:** authentication, scopes, rate limiting, `GET /api/v1/me`,
> `POST /api/v1/whatsapp/send`, `POST /api/v1/disparador/campaigns`,
> and `GET /api/v1/disparador/campaigns/{id}` ship now. The remaining
> data endpoints (`contacts`, `conversations`, …) land one at a time
> in follow-up releases — see [Roadmap](#roadmap).

## Authentication

Every request authenticates with an **API key**, sent as a bearer
token:

```
Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are **account-scoped**: a key acts on exactly one account, the
one it was created in. There is no cross-account access.

### Creating a key

In the dashboard: **Settings → API keys → New API key**. Only
**admins and owners** can create keys.

1. Give the key a name (after the integration that will use it).
2. Grant the **scopes** it needs — nothing more (see below).
3. Copy the key. **The full key is shown exactly once.** wacrm
   stores only a SHA-256 hash, so it can never be shown again. If you
   lose it, revoke it and create a new one.

### Revoking a key

**Settings → API keys → Revoke.** Revocation is effective on the
key's next request. Revoked keys stay in the list as an audit trail.

## Scopes

A key can do only what its scopes allow — independent of who created
it. Grant the minimum.

| Scope                | Allows                                   |
| -------------------- | ---------------------------------------- |
| `messages:send`      | Send WhatsApp messages                   |
| `messages:read`      | Read messages and delivery status        |
| `contacts:read`      | List and read contacts                   |
| `contacts:write`     | Create and update contacts               |
| `conversations:read` | List and read conversations              |
| `campaigns:write`    | Create and enqueue Disparador campaigns  |
| `campaigns:read`     | Read Disparador campaign status and metrics |

A key with **no scopes** still authenticates and can call
`GET /api/v1/me` — useful for verifying a key works.

## Response envelope

Every response uses one of two shapes:

```jsonc
// success
{ "data": { /* ... */ } }

// failure
{ "error": { "code": "forbidden", "message": "This API key is missing the 'messages:send' scope" } }
```

Branch on `error.code` (stable); `error.message` is for humans and
may be reworded.

| Status | `code`         | Meaning                                          |
| ------ | -------------- | ------------------------------------------------ |
| 401    | `unauthorized` | Missing / malformed / unknown / revoked / expired key |
| 403    | `forbidden`    | Valid key, but missing the required scope        |
| 429    | `rate_limited` | Per-key rate limit exceeded                      |
| 400    | `bad_request`  | Malformed input                                  |
| 404    | `not_found`    | No such resource                                 |
| 500    | `internal`     | Server error                                     |

## Rate limits

Requests are limited **per key**: **120 requests per minute**. On a
`429`, these headers tell you when to retry:

- `Retry-After` — seconds until the window resets
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

> The limiter is in-memory and **per process**. A single-instance
> deploy (the common case for a self-hosted fork) is fine as-is. If
> you scale to multiple instances, swap the limiter for a shared
> store (Redis/Upstash) — see the note at the top of
> `src/lib/rate-limit.ts`. The limit is otherwise unenforced across
> instances.

## Endpoints

### `GET /api/v1/me`

Returns the account a key is bound to and the scopes it carries.
Requires only a valid key (no scope). Use it to verify a key works
and to discover its scopes.

```bash
curl https://your-crm.example.com/api/v1/me \
  -H "Authorization: Bearer wacrm_live_xxx"
```

```json
{
  "data": {
    "account": { "id": "…", "name": "Acme Inc" },
    "key": { "id": "…", "scopes": ["messages:send"] }
  }
}
```

### `POST /api/v1/whatsapp/send`

Sends a WhatsApp text and/or media message. Requires `messages:send`.
Finds or creates the target contact and conversation on your active
channel (WAHA or Meta, whichever this account has configured) before
sending.

```bash
curl -X POST https://your-crm.example.com/api/v1/whatsapp/send \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+5527999991212",
    "text": "Hello from the API",
    "name": "Optional contact display name"
  }'
```

`phone` accepts the alias `to`; `text` accepts the alias `message`.
`phone` must resolve to a valid E.164 number. `name` is optional —
only applied when creating a new contact or renaming an existing one.
`text` is required unless a media field (below) is present — a media
message can be sent with no separate text, just a caption.

```json
{
  "data": {
    "success": true,
    "message_id": "…",
    "whatsapp_message_id": "wamid.…"
  }
}
```

Errors: `bad_request` (400) for a missing `phone`/`text` (when no
media is present), an invalid phone format, or no WhatsApp channel
configured for the account; `internal` (500/502) if the send or the
database write fails after the message was accepted by the provider.

#### Media

Send an image, video, audio, or document alongside (or instead of)
text, via a hosted URL or raw base64. Never send both `media_url` and
`media_base64` in the same request.

| Field | Required | Notes |
| --- | --- | --- |
| `media_url` | no | Public URL, must start with `https://`. Fetched directly by the provider — nothing is uploaded. |
| `media_base64` | no | Raw base64, **no** `data:` prefix. Uploaded to Meta's media endpoint first (WAHA takes it inline). Max 16MB decoded. |
| `media_type` | required with `media_base64`, optional with `media_url` | MIME type — see the accepted list below. With `media_url`, omitting it falls back to guessing from the URL's extension. |
| `media_caption` | no | Caption — only applied for `image`/`video`; silently ignored for `audio`/`document`. Max 1024 chars. |

Accepted `media_type` values: `image/jpeg`, `image/png`,
`image/webp`, `image/gif`, `video/mp4`, `audio/ogg`, `audio/mpeg`,
`application/pdf`.

```bash
# By URL
curl -X POST https://your-crm.example.com/api/v1/whatsapp/send \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+5527999991212",
    "media_url": "https://example.com/invoice.pdf",
    "media_type": "application/pdf",
    "media_caption": "Your invoice is attached"
  }'
```

```bash
# By base64
curl -X POST https://your-crm.example.com/api/v1/whatsapp/send \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+5527999991212",
    "media_base64": "iVBORw0KGgoAAAANSUhEUgAA...",
    "media_type": "image/png",
    "media_caption": "Optional caption"
  }'
```

`media_id` is only present in the response when a `media_base64`
upload actually happened (Meta channels — the id returned by Meta's
media endpoint):

```json
{
  "data": {
    "success": true,
    "message_id": "…",
    "whatsapp_message_id": "wamid.…",
    "media_id": "123456789"
  }
}
```

**A `media_base64` send has no hosted copy of the file** — the CRM
inbox stores no URL for it and can't render a thumbnail/preview for
that message. If you need the file to show up properly in the inbox
UI, host it yourself and use `media_url` instead.

Errors: `bad_request` (400) for sending both `media_url` and
`media_base64`, a missing `media_type` with `media_base64`, an
unrecognized `media_type`, a `media_url` not starting with `https://`,
a `media_caption` over 1024 characters, or `media_base64` decoding to
more than 16MB or to nothing at all.

### `POST /api/v1/disparador/campaigns`

Creates a Disparador campaign and enqueues it immediately (status
goes straight to `em_execucao` — there is no draft/review step via
this endpoint). Requires `campaigns:write`.

```bash
curl -X POST https://your-crm.example.com/api/v1/disparador/campaigns \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "campaign_name": "September promo",
    "channel": "+5521999998888",
    "template_name": "promo_september",
    "contacts": [
      { "phone": "+5527999991212", "variables": ["Ana", "10%"] }
    ]
  }'
```

| Field | Required | Notes |
| --- | --- | --- |
| `campaign_name` | yes | |
| `channel` | no | Channel UUID or the Meta number's display phone. Omit only if the account has exactly one enabled channel. |
| `template_name` | Meta channels only | Must already be an **approved** template on that account. |
| `message` | WAHA channels only | Free text; use `{{1}}`, `{{2}}`, … for positional variables. |
| `contacts` | yes | Array of `{ phone, variables: string[] }`. External contacts — not matched against your CRM's contact list. |
| `slot_size` / `slot_interval_minutes` | no | Defaults `1000` / `30`. Contacts beyond one slot are scheduled in later slots at this interval. |
| `janela_inicio` / `janela_fim` | no | Defaults `08:00` / `18:00`. |
| `callback_url` | no | Fetched by the server when the campaign finishes. Rejected if it resolves to a private/internal address. |

```json
{
  "data": {
    "campaign_id": "…",
    "enqueued": 1,
    "skipped": 0,
    "slots": 1,
    "slot_size": 1000,
    "slot_interval_minutes": 30,
    "estimated_completion_minutes": 0
  }
}
```

`skipped` counts contacts dropped for having no phone or being on the
blacklist. Errors: `bad_request` (400) for a missing `campaign_name`/
`contacts`, an unresolvable `channel`, a missing/unapproved
`template_name` on a Meta channel, a missing `message` on a WAHA
channel, or an unsafe `callback_url`.

### `GET /api/v1/disparador/campaigns/{id}`

Returns a campaign's status and delivery metrics. Requires
`campaigns:read` **or** `campaigns:write` (a key that can create
campaigns can also read them back). Only sees campaigns belonging to
the key's own account — a campaign from another account (or an
unknown id) returns `not_found`, not `forbidden`, so a caller can't
tell the two apart.

```bash
curl https://your-crm.example.com/api/v1/disparador/campaigns/f68ec309-5022-484e-98fe-0df10fbdd490 \
  -H "Authorization: Bearer wacrm_live_xxx"
```

```json
{
  "data": {
    "campaign_id": "f68ec309-5022-484e-98fe-0df10fbdd490",
    "name": "September promo",
    "status": "em_execucao",
    "created_at": "2026-09-19T23:17:05.616Z",
    "window": { "start": "08:00", "end": "18:00" },
    "metrics": {
      "total_contacts": 1000,
      "sent": 450,
      "delivered": 440,
      "read": 200,
      "errors": 10,
      "pending": 550
    },
    "queue": {
      "agendado": 550,
      "enviando": 0,
      "entregue": 440,
      "erro": 10,
      "cancelado": 0
    }
  }
}
```

`metrics.pending` mirrors `queue.agendado` — how many contacts are
still waiting to be sent. Errors: `not_found` (404) if the campaign
doesn't exist or belongs to another account.

## Roadmap

Planned endpoints, shipping one per release (tracked in
[#245](https://github.com/ArnasDon/wacrm/issues/245)):

- `GET/POST /api/v1/contacts`, `GET/PATCH /api/v1/contacts/{id}`
  (`contacts:read` / `contacts:write`)
- `GET /api/v1/conversations` (`conversations:read`)
- Outbound event webhooks (so automations can react to inbound
  messages)
