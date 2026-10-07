# JSON Views

## 1. About the product

JSON Views is an open-source editor that presents JSON as editable tables, record pages, Kanban boards, and custom HTML layouts. People and agents work on the same JSON; views are saved presentations of that data, not separate copies.

Objects and arrays are navigable as table-like pages, including nested properties. The built-in Table tab browses structured data; Source shows the raw JSON. Named views give direct access to useful paths, columns, filters, sorting, and layouts. Users can edit both data and view settings through the UI.

Ordinary JSON works without annotations: the viewer infers field editors and useful views without changing the source. Optional `$jsonviews` metadata makes schema and views explicit and portable with the file. Schema describes field types, editors, and validation independently of any view; it does not convert the underlying data types.

## 2. Set up and use the viewer

The public website runs entirely in the browser. The local CLI connects the same viewer to files on disk. Use the interface that fits where the user's data should live.
### Open the viewer

- **Website:** open [json-views.com](https://json-views.com/) and upload or paste JSON. Documents persist in this browser profile across reloads and restarts. Download a document for a copy outside the browser; edits do not overwrite imported files.
- **Local file:** run the command below to connect the editor to a disk file. Accepted edits save back to that file. Add `--no-open` to print the URL and open it in the desired browser yourself.

```bash
npx @script-it/json-views <file.json>
```

### Work through the agent API

In the page's JavaScript context, use `window.jsonViews` (version 1), or discover the browser's registered WebMCP tools. `jsonViews.help()` and `json_views_help` return this guide plus its references, bundled for offline use. Discover the operations available in the current viewer before using them.

Prefix calls with `jsonViews.`. `id` accepts a stable document ID, unique filename, or relative folder path; prefer IDs. Document info includes `id`, `filename`, optional `relativePath`, `active`, `storage`, and `valid`.

| Call | Result |
| --- | --- |
| `list({ includeDiagnosticCount: true })` | Document info; options and diagnostic counts are optional. |
| `get(id)` | Parsed JSON; changing this object does not save it. |
| `source(id)` | Exact source, preserving formatting and numeric spelling. |
| `diagnostics(id)` | Document info plus validation diagnostics. |
| `await create(filename, value)` | Create and select a browser document. |
| `await patch(id, operations)` | Apply atomic RFC 6902 JSON Patch. |
| `await setSource(id, source)` | Replace complete source after syntax validation. |
| `select(id)` | Show a document; return its info. |
| `link(id, viewName?)` | Return a URL for the file and exact view name without navigating; omit the view for the file root. WebMCP: `json_views_get_link`. |
| `remove(id)` | Remove from workspace/cache; returns nothing, leaves local files on disk. |

Writes return document info plus diagnostics. For CSV, read/write exact text with `source()`/`setSource()`; `get()`/`patch()` require JSON.

Use `jsonViews.link(id, "Board")` to direct the user to an exact named view in the current workspace. This navigational link is not a shared copy; use snapshot sharing for another browser. Keep local-file URLs private because they contain an access token.

### Make and verify edits

Use atomic RFC 6902 patches for targeted changes. Supported operations are `add`, `remove`, `replace`, `move`, `copy`, and `test`. These paths are JSON Pointers: `/tasks/0/status`, `/$jsonviews`, `/tasks/-` to append, or `""` for the root. Escape `~` and `/` in property names as `~0` and `~1`.

```js
const result = await jsonViews.patch(id, [
  { op: "test", path: "/tasks/0/status", value: "Todo" },
  { op: "replace", path: "/tasks/0/status", value: "Doing" }
]);
```

Patches preserve unrelated source. Avoid whole-document rewrites that can lose numeric precision. Use `test` to guard expected values; after a persistence conflict, reread the current document before retrying.

Inspect diagnostics returned by every write. `valid` means syntax only: saved documents can still have schema/value errors, and invalid views may be excluded. Fix diagnostic causes, reinspect, and open each affected view to confirm its path and settings work. Invalid source or failed patches change nothing.

For storage timing, error response shapes, CSV operations, and link edge cases, consult [viewer and authoring nuances](#viewer-and-api-nuances).

## 3. Author JSON documents

### Document structure and paths

Keep ordinary data outside `$jsonviews`. Output strict JSON and preserve unrelated values, unknown metadata fields, existing view IDs, and original JSON types. Do not stringify numbers, booleans, or arrays for display. Choose views that expose the parts of the data the user needs to work with.

`$jsonviews: { "version": 1, "schema": {...}, "views": [...] }` sits beside data on an object root. Schema defines field editors and validation; views present the same data in different ways. This schema is a descriptor map, not JSON Schema.

Explicit `$jsonviews` metadata replaces inference; include every field and view you need. Wrapping an existing array root under `data` changes its paths: confirm that conversion with the user.

Metadata paths support `$`, `.property`, `['quoted key']`, `[0]`, and `[*]` (array/dictionary members), without recursive descent or filter expressions. View roots are concrete (`$.tasks`); collection field paths add `[*]` and a field (`$.tasks[*].owner.email`). These differ from patch pointers.

### Field schema

Every descriptor requires `type`; common properties are `title`, `description`, `required`. Optional fields allow null/missing values.

| Type | Value | Properties |
| --- | --- | --- |
| `text` | string | `multiline`, `placeholder`, `pattern` |
| `number` | finite number | `minimum`, `maximum`, `step` |
| `checkbox` | boolean | — |
| `select` / `multi-select` | string / string array | `options`, `optionColors` |
| `date` | date string | `minimum`, `maximum`, `defaultIncludeTime`, `placeholder` |
| `url` / `email` | HTTP(S) URL / email string | — |
| `markdown` | string rendered as Markdown with supported HTML fragments; edits preserve the source | `placeholder`, `pattern` |
| `html` | complete HTML page or styled fragment rendered in an isolated preview; edits preserve the source | `placeholder`, `pattern` |

Choice options are suggestions, accepting new strings. Colors: `gray`, `blue`, `green`, `yellow`, `orange`, `red`, `purple`, `pink`. Dates: `YYYY-MM-DD`, RFC 3339 with offset, or floating `YYYY-MM-DDTHH:mm:ss` (seconds required in timestamps); no empty strings, locale dates, or numeric timestamps. Patterns use RE2; `^…$` matches the whole string.

### Named views

Required: `name`, concrete `path`. Use stable `id` values; omitted IDs are generated. Table and Source are built-in tabs. Table browses the document structure; Source shows the raw JSON. Their icons are a table and `{ }`, respectively. Collections are arrays/dictionaries of records, including empty arrays/objects.

| Setting | Meaning |
| --- | --- |
| `display` | Omit for automatic layout: a record page for one record, a table for record collections; `"kanban"` for board; `"html"` for a custom HTML/CSS layout. Primitive arrays/scalars use their natural layout. |
| `html` / `css` | HTML views only: required non-empty HTML template and optional CSS string. |
| `columns` | Ordered `{ "label": "Task", "path": "$.tasks[*].title" }` entries; omitted/empty means infer. |
| `groupBy` | Existing scalar field path; required for Kanban. |
| `groupOrder` | Array of scalar lane values defining Kanban column order. |
| `orderPath` | Existing finite numeric field on every record, distinct from `groupBy`; persists Kanban ordering. |
| `filter` | `{ "match": "all", "rules": [{ "path": "$.tasks[*].status", "operator": "neq", "value": "Done" }] }`; match also accepts `"any"`. |
| `sort` | Ordered `{ "path": "$.tasks[*].due", "direction": "asc" }` entries; direction also accepts `"desc"`. |

Columns, grouping, ordering, filters, and sorting use collection field paths and require collections. Filters support type-specific subsets of `eq`, `neq`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `contains`, `notContains`, `isEmpty`, `isNotEmpty`. Membership takes array values; presence omits `value`. Dates support equality, ordering, presence; date-only comparisons use the written calendar day. Diagnostics supply allowed operators.

Choose the first column deliberately: put the field that best identifies each record (for example, task name or customer name) first in `columns`. It supplies the table's record link, Kanban card heading, and heading when that record is opened. Reordering or hiding it changes the record label. Without configured columns, the viewer infers a label such as `name` or `title`; standalone records also infer their headings. Schema `title` labels a field and does not select record identity.

### Example

```json
{
  "$jsonviews": {
    "version": 1,
    "schema": {
      "$.tasks[*].title": { "type": "text", "required": true },
      "$.tasks[*].status": { "type": "select", "options": ["Todo", "Doing", "Done"] },
      "$.tasks[*].due": { "type": "date" }
    },
    "views": [
      {
        "id": "open-tasks", "name": "Open tasks", "path": "$.tasks",
        "columns": [
          { "label": "Task", "path": "$.tasks[*].title" },
          { "label": "Status", "path": "$.tasks[*].status" },
          { "label": "Due", "path": "$.tasks[*].due" }
        ],
        "filter": { "match": "all", "rules": [{ "path": "$.tasks[*].status", "operator": "neq", "value": "Done" }] },
        "sort": [{ "path": "$.tasks[*].due", "direction": "asc" }]
      },
      {
        "id": "task-board", "name": "Board", "path": "$.tasks",
        "display": "kanban", "groupBy": "$.tasks[*].status",
        "columns": [{ "label": "Task", "path": "$.tasks[*].title" }]
      },
      { "id": "first-task", "name": "First task", "path": "$.tasks[0]" },
      {
        "id": "task-layout", "name": "Task layout", "path": "$.tasks", "display": "html",
        "html": "<jv-repeat source=\"$.tasks\" as=\"task\"><h2><jv-field bind=\"task.title\"></jv-field></h2><p><jv-value bind=\"task.status\"></jv-value></p></jv-repeat>",
        "css": "h2 { font: 24px Georgia, serif; }"
      }
    ]
  },
  "tasks": [
    { "title": "Draft the guide", "status": "Doing", "due": "2026-09-15" },
    { "title": "Review the example", "status": "Todo", "due": "2026-09-16" }
  ]
}
```

For HTML bindings, restrictions, and interaction details, read [HTML views](#html-views).

# JSON Views nuances

Supplement to the JSON Views skill. Use the main guide for product context, viewer setup, API basics, and JSON authoring; read the sections here only when their edge cases apply.

## Viewer and API nuances

- `browser`: asynchronous IndexedDB cache for this site/profile; no JSON upload backend. Successful writes may precede cache completion; clearing site data removes documents. Download for an independent copy.
- `local-file`: revision-checked writes to the connected disk file. Reread after a conflict before retrying.
- `example`: edits are not cached as user documents; download or create a browser copy to retain them.
- For CSV, read/write exact text with `source()`/`setSource()`; `get()`/`patch()` require JSON.
- Invalid source/patch writes change nothing. JavaScript rejects with `error.diagnostics`; WebMCP returns `{ ok: false, saved: false, diagnosticTarget, diagnostics }`. Other failures remain errors.
- Diagnostics include `scope`, `code`, `severity`, `message`, data/metadata paths, and repair `help`.

To direct the user to relevant data, return `jsonViews.link("tasks.json", "Board")`. URLs use `#/files/<filename-or-folder-path>/views/<view-name>`; encode each placeholder with `encodeURIComponent`. Names are case-sensitive and must be unique; renames break old links. These links open existing files in the same browser workspace, not shared copies. Use snapshot sharing for another browser. Local-file URLs retain their access token and must stay private.

## Schema and inference nuances

- Host-supplied external metadata takes precedence over embedded metadata. Explicit metadata replaces inference rather than merging with it.
- Saving an inferred view's settings writes predicted schema and views into `$jsonviews`.
- Compact, deeply nested JSON without a useful table or declared view can open in Source by default. Saved selections take precedence.
- Complete HTML pages and styled fragments infer `html`; simpler formatting infers Markdown, including when other strings in the property are plain text. Explicit `text` overrides inference.
- Markdown properties appear at the end of records without type selectors or preview buttons. Legacy `body` annotations become Markdown and no longer hide properties or limit records to one rich-text field.
- `required: true` rejects missing/null values and empty strings; it does not enforce collection size. Empty multi-select arrays are valid even when required. An existing empty collection has no required child instances.
- Floating timestamps have no timezone; add `Z` or an offset only when the intended timezone is known. Date-only comparisons use the written calendar day.

# HTML views

Use `display: "html"` for a layout over document data. Set a concrete `path`, a non-empty `html` template, and optional `css`. See the combined example in the main skill.

## Bindings and restrictions

| Interaction | Binding | Behavior |
| --- | --- | --- |
| Read-only value | `<jv-value bind="task.title"></jv-value>` | Displays a scalar. |
| Schema editor | `<jv-field bind="task.status"></jv-field>` | Opens the field's schema/registry editor. |
| Native input | `jv-bind="task.title"` on `input` or `textarea` | Edits the original value; input types: text, number, range, checkbox. |
| Repeat | `<jv-repeat source="$.tasks" as="task">...</jv-repeat>` | Renders array items; `task` aliases the current item. Optional `key="id"` preserves identity using an existing unique property; IDs are not required. `order="reverse"` reverses presentation without changing the array or edit paths. |

**Restrictions:** Use explicit closing tags for custom elements. `$` is the document root; bindings must resolve within the view's `path`, exclude `$jsonviews`, and contain no wildcards, expressions, arithmetic, or functions. Bind scalar fields; use repeats for arrays. Missing paths, including repeat arrays, are errors. HTML and CSS are strings, limited to 256 KiB each; style through `css`. Isolated templates do not support scripts, arbitrary computed values, event handlers, forms, navigation, external resources, or inline styles. HTML views cannot use `columns`, `filter`, `sort`, `groupBy`, `groupOrder`, or `orderPath`. Check renderer warnings as well as metadata diagnostics.

### Display formatting

`jv-value` and `jv-field` support a small set of text-only formats. Display never changes the source. Currency and base64url fields edit readable values and encode them back on save; other formats edit the original value.

- `format="currency-minor" currency-bind="payment.currency"` formats a safe integer using that currency's ISO minor units (for example, `24900` USD → `$249.00`). A fixed `currency="USD"` also works. Provider-specific currency exceptions need adaptation.
- `format="date"`, `"time"`, or `"datetime"` accepts ISO dates, or timestamps with `date-unit="seconds"` / `"milliseconds"`. Output uses English labels and `time-zone="UTC"` by default; set an IANA time zone explicitly when needed.
- `format="base64url"` decodes UTF-8 to plain text, never executable HTML. Use it for a known text MIME part, not arbitrary attachments or multipart traversal.
- `labels='{"U01":"Maya Chen"}'` supplies an explicit presentation lookup. Unknown values retain their raw display. Labels are fixture context, not additional fields in an API response.

For fields with paired API representations, `sync-bind="part.plain_text"` writes the same saved scalar to a second in-scope path atomically. `byte-length-bind="$.payload.body.size"` on a base64url field updates its UTF-8 byte count in the same save. Both targets must exist and be editable. An `aria-label` gives the field editor a readable name.

## HTML interaction nuances

Range commits at pointer/keyboard completion; text, number, and textarea commit on blur or Enter, and Shift+Enter inserts a line break in a textarea (on mobile, Return inserts it and Ctrl/Cmd+Enter commits). Escape cancels. A failed native edit can be retried by completing the interaction again. Shared editors appear in the product layer, outside the authored CSS.

- `jv-value` attribute on progress/meter: bind the numeric value property.
- `jv-attr-<attribute>`: read a scalar into an allowed attribute: title, aria-label, aria-valuenow, aria-valuetext, x/y/cx/cy/x1/x2/y1/y2/width/height/r/rx/ry/fill/stroke/opacity. URLs are not permitted in attributes.

Repeat aliases use ordinary path suffixes (`task.title`, `task['odd.key']`); nested repeats can reference outer aliases. Keys must be unique strings or finite numbers. Unkeyed arrays can display/edit against an unchanged acknowledged document, but have no stable row identity across reorder.

Edits that began before another accepted source change are refused rather than redirected to a different record. Exact numeric source spelling and unsafe edit restrictions are retained.

## App templates

On the website, open **Templates → App Views** for Gmail, HubSpot, Notion, Slack, and Stripe layouts using fictional data shaped like their documented API responses. A separate LinkedIn messaging example is explicitly labeled as a mock. The HTML views section in **About JSON Views → How the Editor Works** links to each example.

These are focused fixtures, not universal API renderers or live integrations. `$jsonviews` adds local presentation metadata; edits stay in the JSON file. Read the [API sources and adaptation notes](https://json-views.com/representative-examples/Templates/App%20Views/README.md) for endpoint parameters, optional fields, native units, and the LinkedIn limitation.
