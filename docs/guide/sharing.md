# Sharing and permissions

Invite people to a workspace or a single base, choose their role, narrow who can edit a table or field, and share read-only links to views and bases.

## Roles

Everyone in a workspace has one of five roles. From highest to lowest: **Owner**, **Creator**, **Editor**, **Commenter** and **Read only**. Each role can do everything the roles below it can.

| What you can do | Read only | Commenter | Editor | Creator | Owner |
| --- | --- | --- | --- | --- | --- |
| See bases, tables, records, views and comments | Yes | Yes | Yes | Yes | Yes |
| Download a view as CSV, export a base as a ZIP | Yes | Yes | Yes | Yes | Yes |
| Comment and react, edit or delete your own comments | | Yes | Yes | Yes | Yes |
| Add, edit and delete records, upload attachments | | | Yes | Yes | Yes |
| Import a CSV into a table, restore values from a record's history | | | Yes | Yes | Yes |
| Create, change, duplicate and delete views and view sections | | | Yes | Yes | Yes |
| See the base's trash, restore deleted records and views | | | Yes | Yes | Yes |
| Create bases, import from Airtable | | | | Yes | Yes |
| Create and change tables and fields, lock views | | | | Yes | Yes |
| Set table and field edit permissions | | | | Yes | Yes |
| Create share links, embeds and public form links | | | | Yes | Yes |
| Manage snapshots, webhooks and automations | | | | Yes | Yes |
| Delete anyone's comment | | | | Yes | Yes |
| Invite people and change roles (up to Creator), share a base | | | | Yes | Yes |
| Restore deleted tables, fields and bases, delete permanently from the trash | | | | Yes | Yes |
| Grant, change or remove the Owner role | | | | | Yes |
| Rename or delete the workspace, manage billing | | | | | Yes |

Notes:

- Inside a base, your role is the higher of your workspace role and your role on that base. A base role can raise your access, never lower it. Workspace owners are owners of every base.
- Edit permissions on a table or field can narrow what editors, creators and owners may change (see below).
- A locked view can only be reconfigured by creators and owners. Personal views are seen only by the person who made them. See [Views](views.md).
- Personal access tokens never get more than your role allows, and can't manage members, sharing, permissions or snapshots. See [Getting started](getting-started.md) and the [REST API](../api/v1.md).

## Workspace members and invitations

Open **Members** from Home's sidebar or the workspace switcher. Everyone sees the member list; creators and owners also see **Invite people** and **Pending invitations**.

To invite someone:

1. Type their email address and pick a role (Editor is preselected).
2. Click **Invite**. They get an email with a link. It works for 7 days and only for that address.
3. When they open the link, they sign in (or sign up) with that email and click **Accept invitation**.

If the email couldn't be sent, the invitation is still saved; use **Resend** to try again. Resending replaces the old link, so only the newest email works. Revoke a pending invitation with the trash icon next to it.

Change a member's role with the role menu on their row, or remove them with the remove button. Rules:

- Creators can invite and manage people up to Creator. Only owners can grant, change or remove the Owner role.
- A workspace always keeps at least one owner. Make someone else an owner before you step down or leave.

On the hosted service, your plan's limits apply (see https://openrows.io/pricing); self-hosted instances have no limits.

## Base collaborators

To give someone access to one base without adding them to the whole workspace, open the base and click **Share** in the top bar (creators and owners). The **Share** dialog lists everyone who can reach the base under **People with access**, with where their access comes from: "Base only", "Workspace editor", or "Workspace editor, raised on this base".

- Invite by email with a role on this base: Creator, Editor, Commenter or Read only. Base invitations work like workspace invitations, and accepting one opens the base.
- For workspace members, you can only pick their workspace role or higher. **Reset to workspace role** drops the raise.
- For base-only collaborators, **Remove from base** takes away their access.
- Base-only collaborators have no workspace role, so they don't see the workspace's Members page.

## Interface-only collaborators

To share an interface without its base, open the interface's page (**Interfaces** in the base's top bar) and click **Share** (creators and owners). Invite people by email with **Can view** or **Can edit**. They see the interface's published pages at their own address, and under **Interfaces shared with you** on Home, but never the base, its grid, its other interfaces or the fields a page doesn't show.

- **Can view**: read the pages.
- **Can edit**: also change the fields a record review page marks as editable (on the records the page lists) and submit its form pages.
- A page filter on a user field or **Created by** set to **Me** shows each viewer their own records, interface-only collaborators included. They can be assigned in the base's user fields.
- People with access to the base see its interfaces already, so they aren't invited to one.
- Buttons that run automations and file downloads aren't available to interface-only collaborators yet.

## Edit permissions

Edit permissions narrow who can change data. Everyone with access still sees every record and field; permissions only limit changes. They never give more than a person's role: a commenter or read-only member listed in a permission still can't edit.

### Table permissions

In the base's sidebar, open a table's menu and choose **Edit permissions**. Set each of:

- **Who can add records**
- **Who can delete records**
- **Who can edit records**

### Field permissions

Open a field's header menu and choose **Edit permissions**, then set **Who can edit this field**. When the table also limits editing records, both apply.

When editors can't edit the field, you can tick **Allow this field to be filled through forms** so public forms can still set it on the records they create. See [Forms](forms.md).

### Permission levels

| Level | Who passes |
| --- | --- |
| Editors and up | Everyone who can edit records (the default) |
| Creators and up | Creators and owners |
| Specific people | The roles you tick (all owners, creators or editors) and up to 100 people you pick |
| Nobody (read-only) | No one; the field or action is locked for everybody |

As in Airtable, owners and creators are bound by these permissions too; they can change the permission instead. Restricted tables and fields show a lock icon.

## Share links

A share link gives anyone who has it a read-only copy of a view or a whole base, without signing in. Creators and owners make them.

- **A view:** open the view's menu in the sidebar and choose **Share view**. Grid, kanban, calendar, gallery, timeline and list views can be shared. Visitors see the view's records and visible fields; hidden fields and other views stay private. Form views have **Share form** instead (see [Forms](forms.md)).
- **A whole base:** click **Share** in the top bar and use **Share link to the whole base**. Visitors see every table as a tab and can pick among its shared views. Personal views and hidden fields stay private.

### Creating a link

Fill in the options, then click **Create link**:

| Option | What it does |
| --- | --- |
| Expires (optional) | The link stops working at the end of that day |
| Password (optional) | Visitors type it before they see anything. At least 8 characters |
| Only people signed in with an email at (optional) | Visitors must sign in with a verified email at one of these domains (up to 20), for example `example.com, example.org` |
| Allow copying data out | On by default. When off, visitors can't select or copy data from the page |
| Allow CSV download | Off by default. When on, visitors get a **Download CSV** button for the view they're looking at |
| Sites that may embed it (optional) | https sites allowed to show the link in an iframe (see Embeds) |

The new link appears once, under "New link (copy it now: it won't be shown again)". Click **Copy link**. OpenRows keeps only a fingerprint of the link, so it can't show it to you again; make a new one if you lose it.

### Managing links

Every live link is listed under **Active links** with when it was made, its expiry and short badges such as "Password", "Only example.com", "No copying" or "CSV download".

- **Settings** changes the password (or **Remove the password**), domains, toggles and embed sites. The link itself stays the same.
- **Revoke** turns the link off at once. Revoked and expired links show "This link isn't available" to visitors.

### What visitors see

- A read-only page with the base or view name and a **Read-only** badge.
- With a password: a password prompt. After 10 attempts from one place, they wait up to 15 minutes. Once unlocked, the link stays open in that browser for 12 hours, or until it expires if that is sooner. Some servers also show a CAPTCHA.
- With email domains: **Sign in to view**. Visitors signed in with another domain see "Your account can't open this link".

## Embeds

You can show a share link inside another website, such as an intranet page.

1. In the link's settings, add the site under **Sites that may embed it**, as an https origin like `https://intranet.example.com` (up to 20 sites). Every other site is refused.
2. When you create a link, the **Embed code** box below it holds an iframe snippet. Pick a **Theme** (Light, Dark or Match the visitor) and click **Copy code**.
3. Paste the code into a page on the allowed site.

The embed is a compact read-only page with a "View in OpenRows" link. You can add embed sites to a link later; the embed code stays the same.

Links with a password or email domains aren't embedded unless you also tick **Allow embedding even with a password or email domains**. Asking for a password or a sign-in inside another site's page invites phishing, and many browsers block the cookies it needs. In an embed, the sign-in opens in a new tab.

## Notifications

The bell in the top bar collects your notifications:

- someone mentions you in a comment,
- someone replies on a record you commented on,
- someone adds you to a user field that has **Notify collaborators when they're added** turned on.

Click a notification to open the record, or **Mark all as read**. You only see notifications for records you can still read.

### Email preferences

In **Settings**, under **Email notifications**, choose:

| Setting | Choices |
| --- | --- |
| What | All notifications, Only mentions, or Nothing |
| When | Right away (one email per record, at most every 10 minutes), Hourly digest, or Daily digest |

The bell always shows everything, whatever you pick for email. Each notification email also has a one-click unsubscribe link, which offers "Only when I'm mentioned" or turning emails off.

## Related

- [Views](views.md): personal, collaborative and locked views
- [Forms](forms.md): public form links
- [Bases, tables and records](bases-and-tables.md): comments, trash and exports
- [Webhooks](../api/webhooks.md) and [Automations](automations.md)
