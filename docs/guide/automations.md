# Automations

Automations run actions when something happens in a base: create or update records, send emails, Slack messages or HTTP requests, or run a script.

## Overview

Each automation belongs to one base and has one trigger ("When") and up to 25 actions that run in order. Open a base and click **Automations** in the top bar (owners and creators of the base see it). The page lists every automation with its trigger, an on/off switch, its last run and how many runs its history holds.

- Click **New automation**, pick a trigger, then use **Add an action…** to add steps. Move steps up or down; each step's number is what tokens use to refer to it.
- Click **Save**, then turn the automation on with its switch. New automations are off, and an automation needs at least one action before you can turn it on.
- A base can have up to 50 automations.
- Automations are managed in the app only; they aren't part of the [REST API](../api/v1.md) or personal access tokens yet. To notify another system of changes without building an automation, see [Webhooks](../api/webhooks.md).

### Who an automation runs as

Actions run with the permissions of the person who last saved the trigger or actions, or turned the automation on ("Whoever saves becomes who it runs as"). Their current role applies, and so do table and field edit permissions (see [Sharing and permissions](sharing.md)). If that person loses access to the base, the automation turns itself off and shows "Turned off: the person it ran as lost access to the base. Turning it on runs it as you."

## Triggers

| Trigger | Runs when | Settings |
| --- | --- | --- |
| When a record is created | A record is added to the table (in the grid, by import, a form, the API or another automation) | Table |
| When a record is updated | A record of the table changes | Table, **Fields to watch** (none picked: any field) |
| When a record matches conditions | A record enters the conditions: it is created matching them, or changes to match them | Table, **Conditions** (the same filter builder as views) |
| When a form is submitted | Someone submits the chosen form view of the table | Table, **Form** |
| When a button is clicked | Someone clicks the chosen button field in a record | Table, **Button field** |
| At a scheduled time | On a repeating schedule | **Repeat**, time zone |
| When a webhook is received | Another system sends a POST to the automation's own URL | None (the URL is generated) |

Notes:

- Only changes made after the automation is turned on trigger it.
- "When a record is updated" with no fields picked runs on any change a person or automation makes, but not when only computed values (formulas, lookups, rollups) recalculate.
- "When a record matches conditions" fires once when a record enters the conditions. It fires again only after the record leaves the conditions and comes back.
- "When a form is submitted" needs a [form view](forms.md) on the table first.

### Button clicks

A [button field](fields.md) normally opens a URL. In the button's field settings, set its action to **Run automations**, then pick that field in a "When a button is clicked" trigger. Clicking the button in the grid runs every automation that is turned on for it ("Automation started", or "No automation is turned on for this button"). Clicking needs permission to edit the record. The automation still runs as its own creator; the person who clicked is available as a token.

### Schedules

Pick **Repeat**:

- **Every…**: every N minutes, hours, days or weeks (N from 1 to 1000), **Starting** at a date and time.
- **Cron expression**: five fields, minute hour day month weekday, for example `0 9 * * 1-5` (weekdays at 09:00). Names (`mon`, `jan`), ranges, lists and steps (`*/15`) work, and so do `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly` and `@annually`.

Every schedule has a **Time zone**, and times are wall-clock times there, so a 09:00 run stays at 09:00 across daylight saving changes. A time the clock skips in spring runs the same distance after the change (01:30 in a 01:00 to 02:00 gap runs at 02:30); a time repeated in autumn runs once. Minute and hour intervals count elapsed time; day and week intervals keep the starting time of day. A schedule can run at most once every 5 minutes. If the server was down for several scheduled times, the automation runs once when it is back, not once per missed time.

### Webhook-received triggers

The trigger card shows the automation's **Webhook URL**. POST JSON to it to start a run:

```sh
curl -X POST "https://app.example.com/hooks/a/<token>" \
  -H "Content-Type: application/json" \
  -d '{"email": "ada@example.com", "plan": "pro"}'
```

- The body must be JSON (`Content-Type: application/json`), at most 100 KB; an empty body counts as `{}`. The answer is `{"success": true}`.
- Anyone with the URL can trigger the automation, so treat it as a secret. **Make a new webhook URL** replaces it; the old one stops working at once.
- A URL whose automation is off or deleted answers 404.
- Each URL accepts 5 requests a second (bursts of 20), and each client IP 600 requests a minute across all webhook URLs; over that the answer is 429 with `Retry-After`.
- The card shows the **Last request received**. Its fields become tokens in the value picker, so send one sample request before you build the actions.

## Actions

| Action | What it does | Output for later steps |
| --- | --- | --- |
| Create record | Creates a record in a table with the fields you set | The created record |
| Update record | Updates a record, or every record in a list, with the fields you set | The updated records, their number |
| Find records | Finds records of a table matching **Conditions**, **At most** 1 to 100 (no conditions: any records) | The records found, their number |
| Send email | Emails people from the server's own address | How many emails were sent |
| Send Slack message | Posts a message to a Slack incoming webhook (or a compatible one) | The response status |
| Send HTTP request | Sends a GET, POST, PUT, PATCH or DELETE request with headers and a JSON body | The response status and body |
| Run a script | Runs your JavaScript in a sandbox | What the script outputs |

### Record actions

- **Create record** and **Update record**: pick a table, then **+ Add a field…** for each field to set. Values can hold tokens.
- **Update record**: the **Record ID** is a record's ID or a token, such as the trigger's record (`{{trigger.record.id}}`) or a list from a Find records step (`{{steps.1.records}}`). One step updates at most 100 records.
- A step writes like a person would: it can't change a table or field the automation's person can't edit.

### Send email

- **To**: addresses or tokens, separated by commas. A token can give an email field's value or a user field's people; people must have access to the base, others are skipped. One step sends to at most 50 recipients, and each gets their own copy.
- **Subject** (up to 500 characters) and **Message (Markdown)** (up to 20,000 characters).
- Each workspace can send a limited number of automation emails per day (UTC), counted per recipient: 100 by default; a self-hosted server's administrator can change it. Past the limit the step fails with a message saying so.

### Send Slack message

Paste the **Slack incoming webhook URL** and write the **Message** (up to 4,000 characters). The URL is stored encrypted and never shown again; leave the box empty to keep the saved one.

### Send HTTP request

Set the **Method**, **URL**, **Headers** (up to 20) and an optional **JSON body** (not sent with GET; sent as `application/json` unless you set `Content-Type`).

- Tick **Secret** on a header that holds a key: its value is stored encrypted and shown as "Saved (hidden)" afterwards.
- The request times out after 15 seconds; an answer other than 2xx fails the step. Up to 1 MB of the response is kept for later steps (JSON responses are parsed).
- URLs must be public `https` addresses on ports 80 or 443. Self-hosted servers can allow more (see [Self-hosting](self-hosting.md)).

## Tokens

Values in actions can include tokens in double braces, filled in when the automation runs. Click the `{}` button next to a box to search and insert one instead of typing it.

| Token | Value |
| --- | --- |
| `{{trigger.record.id}}` | The trigger's record ID (record, form and button triggers) |
| `{{trigger.record.fields.Status}}` | A field of the trigger's record, by field name |
| `{{trigger.record.fields["Due date"]}}` | Field names with dots or brackets use `["..."]`; spaces work either way |
| `{{trigger.user.name}}`, `{{trigger.user.email}}` | Who clicked the button |
| `{{trigger.scheduledAt}}` | The scheduled time of the run |
| `{{trigger.body.customer.email}}` | A value in the webhook request's JSON body |
| `{{steps.1.record.id}}` | The record step 1 created |
| `{{steps.2.records}}`, `{{steps.2.count}}` | The records step 2 found or updated, and how many |
| `{{steps.2.records[0].fields.Name}}` | A field of the first of them |
| `{{steps.3.status}}`, `{{steps.3.body.id}}` | An HTTP step's response status and body |
| `{{steps.4.sent}}` | How many emails step 4 sent |
| `{{steps.5.output.total}}` | A value a script step set |

How tokens fill in:

- A box that holds exactly one token keeps the value as it is: a number stays a number, and a list of records can fill a link field.
- Inside other text, lists are joined with commas, and linked records and people show their names.
- A missing value is empty. A step can only use the trigger and the steps before it, and the trigger itself can't hold tokens. One box can hold up to 50 tokens.
- Tokens name fields by name, so renaming a field breaks the tokens that use the old name. Update them after a rename.

## Run a script

**Run a script** runs JavaScript in a throwaway sandbox with no network access. Add **Input variables (input.config())** with **Add input** (values can hold tokens), then write the **Script (JavaScript)**. You can use `await` at the top level.

```js
const { email } = input.config();
const people = base.getTable('People');
const result = await people.selectRecordsAsync({
  filter: { conditions: [{ field: 'Email', operator: 'is', value: email }] },
  maxRecords: 1,
});
if (result.records.length === 0) {
  await people.createRecordAsync({ Email: email });
}
output.set('found', result.records.length);
```

What a script can use:

- `input.config()`: the input variables. `output.set(name, value)`: a value later steps read as `{{steps.N.output.name}}`.
- `base.getTable(nameOrId)` (tables of this base only), then `getField`, `selectRecordsAsync({ filter, sorts, fields, maxRecords })`, `selectRecordAsync(id)`, `createRecordAsync`/`createRecordsAsync`, `updateRecordAsync`/`updateRecordsAsync`, `deleteRecordAsync`/`deleteRecordsAsync`. Records have `getCellValue(field)` and `getCellValueAsString(field)`.
- `fetch(url, { method, headers, body })`, sent by the server under the same URL rules as HTTP requests, with `ok`, `status`, `text()` and `json()`.
- `console.log`, `info`, `warn` and `error`: the lines appear in the run history.

There is no `require`, no timers and no access to the server. Reads and writes run as the person the automation runs as, with their permissions.

Limits: up to 50 records per create, update or delete call, 20 `fetch` requests (10 seconds and 1 MB each), 500 calls in all, 64 KB of output and 200 log lines; the script itself is up to 50,000 characters, with up to 50 input variables. The step card shows the time, CPU and memory limits of your server (by default 30 seconds, 10 seconds of CPU and 128 MB).

Availability: scripts are off unless the server's administrator turns them on with `AUTOMATION_SCRIPTS` (see [Self-hosting](self-hosting.md) and [Run-script automation steps](../deploy/automation-scripts.md)). On the hosted service, scripts depend on your plan (see https://openrows.io/pricing). When scripts aren't available, the action shows as "Run a script (not available)".

## Testing

The panel beside the builder has two tabs, **Test** and **Run history**. A test runs the actions for real, as you: records are created and changed, and emails, messages and requests are sent.

- Record, form and button triggers: **Pick a record** to run with.
- Webhook triggers: the test uses the last request received; send one to the URL first.
- Schedules: the test runs as if the schedule fired now.

Click **Run test** (or **Save and test** with unsaved changes). The result shows each step's input, output and error. Tests aren't counted as runs and don't change the automation's last run.

## Run history and retries

**Run history** keeps runs from the last 30 days. Use **Show** to list all runs or only succeeded, failed or skipped ones. Open a run to see its trigger data and each step's input, output and error; header values, Slack URLs and query string values are shown as `[redacted]`. Tags mark **Test** and **Retry** runs, and why a run was skipped: **Loop guard** or **Plan limit**.

When a step fails, its own changes are undone, the steps after it are skipped, and the changes of earlier steps stay.

Click **Retry** on a failed run to run it once more, as you, with the automation's current actions. Record triggers use the record's values as they are now; webhook, schedule and button runs reuse the original request, time or clicker. Each failed run can be retried once, and not after its trigger type changed. Test runs can't be retried.

## Limits

- **Loop guard**: automations whose actions trigger other automations can chain at most 3 deep. A deeper run does nothing and shows as skipped with **Loop guard**.
- Per base: 50 automations, 25 actions each, 64 KB of configuration.
- Find records returns at most 100 records; one Update record step changes at most 100.
- Emails: 50 recipients per step and the daily email limit above.
- Outgoing requests (HTTP, Slack, email and script `fetch`) share a per-workspace rate; runs over it wait in the queue and nothing is dropped.
- On rare occasions, such as a server restart in the middle of a run, an email, message or request may be sent twice.
- Automation runs per month and records per base: on the hosted service, your plan's limits apply (see https://openrows.io/pricing); self-hosted instances have no limits. Runs over the monthly limit are skipped with **Plan limit**.
