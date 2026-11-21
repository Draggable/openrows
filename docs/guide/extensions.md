# Extensions

Extensions are small apps that sit next to your views in a base's **extension panel**: a chart
that updates as records change, a print layout of the record you've selected, a preview of a
record's link. They run in your browser, in a sandbox, with your own access, and only with the
permissions they list.

Open a base and click **Extensions** in the top bar (on a phone, in the **More** menu). The panel
opens on the right and stays open on that browser until you close it.

## Add an extension

Creators and owners click **Add extension** and pick one of the built-in extensions:

- **Chart**: a bar chart of a table's records, counted by a field's values. Pick the table and the
  field in the chart; it updates live as records change.
- **Print view**: lays out the record you've selected (a grid cell, or the record you've opened)
  as a page. **Choose fields** picks what goes on the page; **Print** prints it.
- **URL preview**: previews the selected record's link from a URL field: YouTube, Vimeo and Loom
  videos and images play or show inline, other sites get an **Open link** button.

## Add an extension from the catalog

The extension catalog lists reviewed extensions with what you need to judge them before you add
one. Creators and owners open it from **Add extension** with **Browse the catalog**. Each listing
shows:

- the extension's name and version,
- its publisher (a name, linked to the publisher's site when there is one),
- a description,
- the permissions it asks for (see [Permissions](#permissions)).

Browsing the catalog doesn't install anything. To add a listing to the base:

1. Click **Add** on the listing. OpenRows shows the permission prompt: the extension's name,
   version and publisher, and every permission it asks for, the same prompt as for [your own
   extension](#your-own-extensions).
2. Read the permissions, then click **Install** to add the extension, or **Cancel** to go back to
   the catalog without adding it.

Nothing is added until you confirm. Once added, a catalog extension is like any other on the
base: it runs in the same sandbox, with your access and only the permissions it listed, it
appears in the panel for everyone on the base, and it counts toward the base's 20 extensions. If
a listing's permissions change between the prompt and the install (after an update, say),
OpenRows refuses the install and shows the catalog again, so you can review the new ones.

Today the catalog lists the built-in extensions, published by OpenRows; adding one from the
catalog adds that built-in, exactly as the built-in list in **Add extension** does. Editors,
commenters and read-only members, who can't add extensions, aren't offered the catalog.

Adding from the catalog is separate from uploading your own package: a listing is reviewed and
ships with OpenRows, so who may upload packages (`EXTENSIONS_CUSTOM_BUNDLES`, below) doesn't
change who may add a listing. Creators and owners add listings even where uploads are limited to
owners or turned off.

### How an extension gets onto the catalog

The catalog ships with OpenRows: it is a reviewed list in the source code
(`packages/shared/src/extensions/catalog.ts`), the same on every base of an instance, and the
server never downloads listings. A new extension is added to it by a pull request to the
OpenRows repository, reviewed like any other change: its code, the permissions its manifest asks
for, and the publisher it names. There is no sign-up for publishers and no submission form in
the app. A listing's publisher is the person or organisation who maintains the extension.

To run an extension that isn't in the catalog, upload it as [your own
extension](#your-own-extensions).

### Turn the catalog off

The catalog is on by default. A server's administrator turns it off with `EXTENSIONS_CATALOG=off`;
**Add extension** then has no catalog, the catalog API answers `available: false` with no
listings, and nothing can be installed from it (the API refuses with a 404, "The extension
catalog is turned off on this server"). Extensions already added from it stay. Built-in
extensions and uploads aren't affected (uploads follow `EXTENSIONS_CUSTOM_BUNDLES`, below).

## Manage extensions

Each extension's menu (**⋯**) lists what it may do, and has **Reload**. Creators also move
extensions up and down, make them small, medium or large, and remove them. A base has at most 20.

Everyone on the base sees its extensions, and each person sees them with their own access: a
read-only member's chart counts the records they can read, and an extension can't change a record
they couldn't change by hand. Editors and up change an extension's settings (the chart's table and
field, the print view's fields); everyone else sees them as they are.

## Permissions

An extension gets only the permissions in its manifest:

| Permission | What the extension can do |
| --- | --- |
| Read this base's tables and records | See tables, fields and views; read records; follow their changes |
| Create, change and delete records | Write records (as you, with your edit permissions) |
| See the table, view and record you have selected | Follow your selection |
| Change the extension's settings | Save its own settings (editors and up) |
| Show images from the web and videos from YouTube, Vimeo and Loom | Embed those players and `https:` images |

Whatever it asks for, an extension never sees your cookies or session, can't read or change the
OpenRows page around it, has no storage of its own, and has no network access: its frame's
security policy blocks requests, and its only way to your data is OpenRows, which checks every
call. An extension can still navigate its own frame to another site; OpenRows stops an extension
that does, but install third-party extensions only from people you trust.

## Your own extensions

Write an extension with [@openrows/blocks](https://www.npmjs.com/package/@openrows/blocks), the
typed SDK, and bundle it into one package file: a JSON file with the manifest (name, version and
permissions) and the bundle (HTML, CSS and one JavaScript file). The package's README describes
the format and the whole API.

Creators upload a package in **Add extension** under **Your own extension**: OpenRows shows the
permissions it asks for before you install it. An uploaded package isn't reviewed: install one
only if you trust whoever wrote it. On app.openrows.io only workspace owners install
their own extensions. Self-hosted instances choose who may with `EXTENSIONS_CUSTOM_BUNDLES`
(`creators`, the default; `owners`; or `off`).
