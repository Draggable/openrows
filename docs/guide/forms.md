# Forms

A form view turns a table into a public form. Anyone with the link can fill it in, and each submission adds a record to the table.

## Creating a form

In the base sidebar, click **Create view** and pick **Form**. The form builder opens with three parts:

- On the left, the **Fields** tab lists the fields on the form, and the **Settings** tab holds the form's own settings.
- On the right, a live preview shows the form as submitters will see it. You can try it out, but answers in the preview aren't saved.

Editors and above can build forms. Owners and creators can lock a form view so that only they can change it, and only owners and creators can publish a form link. See [Views](views.md) for locking and the other view options.

## Adding and arranging fields

Under **Add a field**, click a field to put it on the form, or click **Add all**. To take a field off, click its remove button. Drag fields to reorder them, or focus one and press Alt+Up/Down.

Computed, automatic and button fields can't be on a form: formula, lookup, rollup, count, autonumber, created time, last modified time, created by, last modified by and button. Every other field type can be added.

Icons next to each field in the list show that it is **Required** (an asterisk), **Shown on conditions**, or **Not on the public form**. Open the field's settings to see why a field stays off the public form.

## Field settings

Click a field in the list to open its settings:

| Setting | What it does |
| --- | --- |
| **Label** | The question shown on the form. Leave it empty to use the field's name |
| **Help text** | Shown under the label. Takes simple Markdown: bold, italic, links and lists |
| **Required** | Submitters must answer before they can submit |
| **Allow prefill from the form's link** | Lets the form's URL fill in this answer (see [Prefilling answers](#prefilling-answers)) |
| **Show only when conditions match** | Shows the field only when earlier answers match (see [Conditional fields](#conditional-fields)) |
| **Records people can pick** | Linked record fields only: the view whose records submitters can choose from |

### Conditional fields

Tick **Show only when conditions match** and add conditions on fields above this one on the form, with the same operators as view filters. With more than one condition, choose **all match** or **any matches**. A field can have up to 50 conditions.

A hidden field's answer counts as empty, so hiding a field also hides any field that depends on it. Answers to hidden fields aren't sent, and a required field only needs an answer while it is shown.

### Linked record fields

A linked record field appears on the public form only after you choose **Records people can pick**: a collaborative view of the linked table. Submitters can search that view's records by their primary field and pick one, or up to 100 when the field allows several. They see nothing but the records' primary field values.

### Fields that stay off the public form

Some fields show in the builder but not on the public form:

- **User fields**, because anyone with the link would see your collaborators.
- **Linked record fields** without a view to pick from.
- **Fields editors can't edit**, because of the field's edit permissions. To let forms fill such a field anyway, open the field's **Edit permissions** and tick **Allow this field to be filled through forms**. See [Sharing and permissions](sharing.md).

If the table's own permissions stop editors from adding records, the form takes no submissions at all.

## Form settings

The **Settings** tab sets:

| Setting | What it does |
| --- | --- |
| **Title** | The form's heading. Defaults to the view's name |
| **Description** | Text under the title, in simple Markdown |
| **Cover image** | A banner across the top of the form (PNG, JPEG, GIF or WebP) |
| **Logo** | A logo above the title (same image types) |
| **Submit button** | The button's label. Defaults to "Submit" |
| **After a submission** | **Show a message** (your own text, or a default thank-you) or **Redirect to a URL** |
| **Show "Made with OpenRows"** | The branding line at the foot of the form |

Redirects accept full `https://` addresses only. Until you set one, submitters see the message instead.

On the hosted service, removing the branding needs a paid plan (see https://openrows.io/pricing). Self-hosted instances have no limits.

## Publishing the form

Open the form view's **…** menu in the sidebar and choose **Share form**, then click **Create form link**. Copy the link straight away: it is shown only once. Anyone with the link can fill in the form, signed in or not.

The dialog lists the form's links. Click **Turn off** on a link to stop it working at once. With no links, the form is private. You can create a new link at any time.

## Prefilling answers

You can fill in answers through the form's URL, as in Airtable. For each field with **Allow prefill from the form's link** ticked, add `prefill_` and the field's name:

```
https://app.openrows.io/f/<form link>?prefill_Name=Ada%20Lovelace&prefill_Status=New
```

- Values are read the same way as pasted text, so a select option takes its name and a checkbox takes `true`.
- For fields that hold several values, such as multiple select, separate values with commas.
- Add `hide_<Field name>=true` to hide a prefilled field. Its value is still submitted.
- Attachments and linked records can't be prefilled.
- Prefill parameters for fields that don't allow prefill, and values that can't be read, are ignored.

Encode spaces and special characters in the URL, as in the example.

## What submitters see

Submitters see only the form: its title, description, images and the fields on it. They never see the table, its other records or its other fields.

- **Attachments**: submitters upload files directly in the form, up to 10 files per field and 20 MB per file.
- **Linked records**: submitters click **Add a record**, then search with **Find a record…**.
- **Required answers**: missing ones are marked "An answer is required." and the form isn't sent.
- **CAPTCHA**: when the server is set up with Cloudflare Turnstile, submitters complete a check before submitting.
- **After submitting**: they see your message (or "Thanks for your answers") or go to your redirect URL. **Submit another response** starts a fresh form.

Submitting twice by accident, for example with a double click, still creates one record. Forms are rate-limited per visitor, who then sees "Too many submissions from here. Try again in a few minutes."

If the base reaches its record limit on the hosted service, the form says it isn't accepting responses right now.

## Records from forms

Each submission creates one record. Values are checked like any other edit, and computed fields, revision history and automations update as usual. Submissions aren't made by a person: the record's activity shows **Form** as the author.

To act on new submissions, use an automation with the **When a form is submitted** trigger. It can, for example, send an email, post a Slack message or update other records. See [Automations](automations.md).

## Self-hosting notes

In production, public forms need Cloudflare Turnstile. Set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` on the server, or form links won't work. See [Self-hosting](self-hosting.md).
