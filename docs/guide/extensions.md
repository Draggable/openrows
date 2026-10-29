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
permissions it asks for before you install it. On app.openrows.io only workspace owners install
their own extensions. Self-hosted instances choose who may with `EXTENSIONS_CUSTOM_BUNDLES`
(`creators`, the default; `owners`; or `off`).
