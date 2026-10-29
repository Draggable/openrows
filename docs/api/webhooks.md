# Webhooks

OpenRows sends a base's changes to a URL you choose, as signed JSON. Use them to push
records into n8n, Zapier, Make or your own code instead of polling the [REST API](v1.md).

On the hosted service, the [Zapier app](https://openrows.io/docs/zapier) registers and checks a webhook
for each Zap's trigger the same way, and the [Make app](https://openrows.io/docs/make) for Watch
Records (Make can't check the signature, so it reads each delivery's record again through the
API instead).

In n8n, the OpenRows Trigger of [`@openrows/n8n-nodes-openrows`](../../packages/n8n-nodes-openrows/README.md)
registers and verifies a webhook for you.

## Managing webhooks

A base's creators and owners manage its webhooks under **Webhooks** in the base menu, or through
the REST API with a session or a personal access token with the `webhook:manage` scope:

| Method and path | What it does |
| --- | --- |
| `GET /api/v1/bases/{baseId}/webhooks` | The base's webhooks (never their secrets) |
| `POST /api/v1/bases/{baseId}/webhooks` | Create one; the answer's `secret` is shown only this once |
| `PATCH /api/v1/bases/{baseId}/webhooks/{webhookId}` | Change the URL, description, events or filters; `enabled`; `{ "rotateSecret": true }` returns a new `secret` (the old one still signs for 24 hours); `{ "expirePreviousSecret": true }` ends that grace period now |
| `DELETE /api/v1/bases/{baseId}/webhooks/{webhookId}` | Delete it and its delivery log |
| `GET /api/v1/bases/{baseId}/webhooks/{webhookId}/deliveries?limit=50` | Its delivery attempts of the last 7 days, newest first |
| `POST /api/v1/bases/{baseId}/webhooks/{webhookId}/ping` | Send a signed `ping` now and answer with the attempt |
| `POST /api/v1/bases/{baseId}/webhooks/{webhookId}/deliveries/{deliveryId}/redeliver` | Queue a logged event again, with the same event id (`{ "queued": true, "eventId": "…" }`); 409 for a ping, a webhook that is off, or an event past the 7-day event retention |

```json
POST /api/v1/bases/{baseId}/webhooks
{
  "url": "https://example.com/hooks/openrows",
  "description": "Sync to the CRM",
  "events": ["record.created", "record.updated", "record.deleted"],
  "tableIds": ["<table id>"],
  "fieldIds": null
}
```

- **events**: `record.created`, `record.updated`, `record.deleted`, `record.restored` (out of the
  trash, or a record revision restore that brings one back), `form.submitted` (a public form's
  submission; delivered as `record.created` to webhooks that don't ask for it),
  `field.created`, `field.updated`, `field.deleted`, `field.restored`, `table.created`,
  `table.updated`, `table.deleted`, `table.restored`, `comment.created`, `comment.updated` (an
  edit or a reaction) and `comment.deleted`.
- **tableIds**: only these tables' events (`null`: every table, including new ones).
- **fieldIds**: record updates only when one of these fields changed (`null`: any field).
- A base has at most 10 webhooks. The URL must be `https` on port 443 at a public address (a
  self-hosted server can allow more with `OUTBOUND_HTTP_*`, see the deployment docs). It is
  checked when saved and again before every delivery.

## Deliveries

Each event is one `POST` with `Content-Type: application/json` and these headers:

| Header | Value |
| --- | --- |
| `X-OpenRows-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` |
| `X-OpenRows-Event-Id` | The event's id, the same on every retry: skip ids you already handled |
| `X-OpenRows-Event-Type` | `record.updated`, `form.submitted`, `ping`, … |

```json
{
  "id": "4b0c6f2e-…",
  "type": "record.updated",
  "timestamp": "2026-10-26T10:00:00.000Z",
  "webhookId": "…",
  "base": { "id": "…", "name": "Roadmap" },
  "table": { "id": "…", "name": "Tasks" },
  "record": {
    "id": "…",
    "before": { "<field id>": "Draft" },
    "after": { "<field id>": "Shipped" }
  },
  "fields": { "<field id>": { "name": "Status", "type": "singleSelect" } },
  "actor": { "id": "…", "name": "Ada" }
}
```

- `record.created` (and `form.submitted`): `after` holds every cell, `before` is `null`.
- `record.updated`: the changed cells before and after (`before` is `null` for changes made by
  links on the other side).
- `record.deleted`: `before` holds the record's cells, `after` is `null`.
- `record.restored`: like `record.created`, `after` holds every cell.
- `field.*`: `field` is `{ id, name, type }`. `table.*`: `table` names the table.
- `comment.*`: `comment` is `{ id, recordId, body, authorId, mentions, createdAt, editedAt }`;
  `body` is sanitized Markdown with `@[name](user:<id>)` mention tokens, and `null` (like
  `authorId` and the dates) for `comment.deleted`.
- `actor` is `null` for a public form's submission.
- Payloads only hold what the webhook's creator may read. A webhook whose creator lost access to
  the base is turned off.

Answer with any `2xx` within 10 seconds. Redirects are not followed. Anything else (an error
status, a timeout, a refused address) is retried 7 times with growing delays: about 7.5
minutes, 15 minutes, 30 minutes, 1, 2, 4 and 8 hours (each up to twice that, at random), about
a day in all. Deliveries aren't ordered: use `timestamp` and the event id. A webhook that fails
10 times in a row over at least a day is turned off and its creator gets an email; fix the
receiver, then turn it on again (the count starts afresh). Every attempt is in the delivery log
for 7 days, with its status, duration and the first 1 KiB of the response. A failed delivery has
a **Redeliver** button there (or `POST …/deliveries/{deliveryId}/redeliver`): the worker sends
the event again, as it is stored, with the same event id and the next attempt number; it counts
like any attempt.

## Verifying signatures

Check every request before you trust it:

1. Read the raw body as received (before parsing the JSON).
2. Split `X-OpenRows-Signature` into `t` and its `v1` values: there are two for 24 hours
   after a secret rotation, one per secret.
3. Refuse a `t` more than 5 minutes from your clock: that is the replay protection (a captured
   request can't be sent again later), together with skipping event ids you already handled.
4. Compute `HMAC-SHA256(secret, t + "." + rawBody)` as hex and compare it with each `v1` in
   constant time; accept the request when one matches.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = header.split(',').map((p) => p.split('=', 2));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, v]) => {
      const given = Buffer.from(v ?? '', 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

// Express: app.post('/hooks/openrows', express.text({ type: 'application/json' }), (req, res) => {
//   if (!verify(process.env.OPENROWS_WEBHOOK_SECRET, req.get('X-OpenRows-Signature'), req.body)) {
//     return res.sendStatus(401);
//   }
//   const event = JSON.parse(req.body);
//   res.sendStatus(204);
// });
```

```python
import hashlib, hmac, time

def verify(secret: str, header: str, raw_body: bytes, tolerance: int = 300) -> bool:
    parts = [p.split("=", 1) for p in header.split(",") if "=" in p]
    try:
        t = int(next(v for k, v in parts if k == "t"))
    except (StopIteration, ValueError):
        return False
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, v) for k, v in parts if k == "v1")
```

Rotating the secret (`PATCH … { "rotateSecret": true }` or "Rotate secret" in the app) returns
the new one once. The old one keeps signing for 24 hours (`previousSecretExpiresAt` on the
webhook): every delivery and ping carries a `v1` for each, so a receiver still on the old secret
and one already on the new one both pass. Switch your receiver over within the day. If the old
secret leaked, end the grace period at once with `{ "expirePreviousSecret": true }` (or rotate
with both). Rotating again within the 24 hours keeps only the secret just replaced as the
previous one.
