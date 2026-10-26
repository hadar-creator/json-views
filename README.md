# JSON Views

An extensible JSON viewer and editor for browsers, React apps, local files, humans, and agents.

<img width="1112" height="559" alt="image" src="https://github.com/user-attachments/assets/5d22fee2-a99d-4dd8-bd56-09c7597f5158" />

The viewer supports adaptive tables, record drill-down, source-preserving edits, declared views, filters, sorting, and Kanban. Its core and React packages are independent of Script.it APIs and styling.

**Release status: public beta.** Feedback is welcome in [GitHub Issues](https://github.com/script-it/json-views/issues). For an example of consuming the published packages, see the [installed-package consumer](examples/consumer/README.md).

## Open a local file

```bash
npx @script-it/json-views ./data.json
```

The command binds only to `127.0.0.1`, opens a browser tab, and grants that session access to only the named file. Saves use revisions, serialize requests per file within the process, and atomically replace the file while retaining its permissions. Changes detected before replacement return a conflict. Independent processes do not share a lock; see the [local file and agent API](packages/cli/README.md#local-file-and-agent-api).

Use `--no-open` when an agent or another tool should consume the printed URL and local API.

## Use the public editor

The [browser editor](https://json-views.com/) supports upload, paste, download, share links, and a browser-local workspace backed by IndexedDB. Share links gzip the active JSON or CSV document, preserve its exact source and filename, and place the encoded data in the URL fragment so it is not sent to the server. Links longer than 8 KB carry an interoperability warning and links longer than 32 KB are rejected. Treat a share link as public to anyone who receives it.

The editor restores the last document, selected view, source/view mode, searches, navigation, table widths, transient presentation controls, and scroll positions per document without adding cache data to `$jsonviews`. A synchronous session-storage backup preserves each tab’s latest presentation changes during page unload; it contains no document content or metadata. The standalone static site has no upload backend. Imported text stays exact, including whitespace and large numeric IDs. Source edits require **Apply** (or **Save** for a CLI file); **Format** is an explicit action. Malformed JSON remains available for repair and download. Uploading from a CLI session creates a separate browser document.

json-views.com records anonymous usage counts — which interface opened a document and whether the source was JSON or CSV — and never the filename, the document, or any value inside it. There is no persistent identifier and no cookie. Turn it off in Settings. The `@script-it/json-views-core`, `-react`, and CLI packages send no telemetry and make no network requests at all.

Browser tabs on the same origin share versioned documents in IndexedDB. Saves compare each changed document’s revision inside the write transaction, so edits to different files can save independently. BroadcastChannel notifications refresh other tabs, with a focus/visibility refresh when a notification was missed. Conflicting source edits stay in the current tab: choose **Use saved version** (the previous draft remains downloadable) or **Save draft as copy**. Deleting an active file in another tab requires acknowledgment before it closes. View selection, source mode, and presentation controls remain independent per tab. Concurrent changes within one file are not automatically merged.

### Browser console API

The open editor exposes `window.jsonViews` for DevTools, browser extensions, and automation running in the page. Run `jsonViews.help()` for product context, viewer setup, API instructions, and JSON authoring examples. WebMCP exposes the same guide through `json_views_help`. Edit the main [agent skill](skills/json-views/SKILL.md), [nuances reference](skills/json-views/references/jsonviews.md), and [HTML views reference](skills/json-views/references/html-views.md); web development, builds, and tests combine them into `apps/web/src/agent-help.md` and bundle it for use without another network request.

```js
const documents = jsonViews.list()
const tasks = jsonViews.get('tasks.json')
const inspection = jsonViews.diagnostics('tasks.json')

await jsonViews.create('notes.json', { notes: [] })
await jsonViews.patch('tasks.json', [
  { op: 'test', path: '/tasks/0/done', value: false },
  { op: 'replace', path: '/tasks/0/done', value: true },
])
```

Commands update the visible editor and its persistence destination. `patch()` applies standard RFC 6902 operations atomically with RFC 6901 JSON Pointer paths while preserving unrelated source text; failed patches return structured diagnostics and save nothing. Browser documents are cached in IndexedDB; a CLI-backed document is written through its revision-safe local API. Use the stable document id returned by `list()` when filenames are duplicated. `source()` reads exact text and `setSource()` replaces it after validating that it is JSON. Every write returns document info with structured `diagnostics` for source, annotation, view, and value issues; `diagnostics()` provides the same inspection without changing the document. Pass `{ includeDiagnosticCount: true }` to `list()` when counts are useful. `valid` continues to report whether the source itself can be saved.

### WebMCP

In browsers and agent clients that support [WebMCP](https://webmachinelearning.github.io/webmcp/), the open editor registers tools for listing, reading, inspecting diagnostics, creating, patching, selecting, and deleting documents. Agents can manipulate the visible workspace through those tools without clicking the interface or executing DevTools commands. `json_views_get_diagnostics` inspects existing issues; create, patch, and source-replacement results include the same structured validation diagnostics shown by the website. The tools use the same persistence path as `window.jsonViews`; browsers without WebMCP continue to work normally.

## Automatic types and views

Ordinary JSON does not need `$jsonviews`. JSON Views predicts useful metadata in memory:

- booleans, finite numbers, validated web URLs, email addresses, ISO dates, and long text get matching edit widgets;
- select fields require a category-like field name and a small set of short values, each repeated at least twice across four or more records; a single observed category is allowed. Mode, platform, and channel fields qualify, including labels containing slashes. Multi-select requires the same repeated evidence in tags, labels, categories, or departments; arbitrary names, IDs, and string arrays remain generic;
- tables require at least three records and populated, consistently typed comparison columns. Four shared varying scalar columns with at least 60% readable top-level fields allow optional enrichment and nested details; otherwise the stricter 80% shared-field/readable-content rule and two useful columns apply;
- Kanban additionally requires distinct readable titles and two to six recurring groups in a `status`, `state`, `stage`, or `phase` field, with at least two records per group and recognized workflow values such as Open, In progress, or Done. Health states such as healthy/down do not qualify;
- uniform scalar records may remain tabular with null or constant fields. Consistent nested objects can supply up to 12 scalar columns through two object levels; arrays never expand into additional rows;
- collections inside individual dictionary records are not promoted to document tabs; collections inside ordinary response wrappers remain eligible;
- Table (table icon) and Source (`{ }` icon) are built-in tabs. Table is the structured browser for the document, including property lists and expandable values when a record table is unsuitable. Compact JSON (at most 100 pretty-printed lines and 8,000 characters) opens in Source when at least 60% of scalar values are three or more levels deep and no declared view or natural table applies. Saved selections take precedence; otherwise Table opens by default. Qualifying predictions are optional tabs. The same table check applies inside Table, with unsuitable collections shown as expandable values. Inference never adds a duplicate view for the root itself.

Opening inferred views never changes the source. Saved tab choices and explicit `$jsonviews` views take precedence over prediction; CSV remains tabular regardless of row count. Saving the settings of an inferred view materializes the predicted schema and views into `$jsonviews`, where they can be renamed and customized.

## Add views and types to JSON

JSON Views reads optional `$jsonviews` metadata from an object root:

```json
{
  "$jsonviews": {
    "version": 1,
    "schema": {
      "$.contacts[*].name": { "type": "text", "title": "Name" },
      "$.contacts[*].status": {
        "type": "select",
        "options": ["New", "Qualified", "Customer"]
      }
    },
    "views": [
      {
        "id": "contacts",
        "name": "Contacts",
        "path": "$.contacts",
        "columns": [
          { "label": "Name", "path": "$.contacts[*].name" },
          { "label": "Status", "path": "$.contacts[*].status" }
        ]
      }
    ]
  },
  "contacts": [
    { "name": "Ada", "status": "Customer" }
  ]
}
```

Built-in types are `text`, `markdown`, `html`, `number`, `checkbox`, `select`, `multi-select`, `date`, `url`, and `email`. Markdown renders automatically and edits as source text. Long text stays visible in tables; clicking it opens its record editor. Markdown properties appear at the end of each record. HTML is inferred from complete pages or styled fragments and shown in an isolated preview; Markdown is inferred from recognizable formatting. An explicit text annotation overrides inference. Legacy `body` annotations are accepted as Markdown, with no single-body restriction.

`select` and `multi-select` options are suggestions rather than closed enums. People and agents can enter a new text option directly in either widget; values already present in the document become available to every matching field.

Assign stable option colors with `optionColors`, for example `"optionColors": { "New": "blue", "Customer": "green" }`. The built-in palette is `gray`, `blue`, `green`, `yellow`, `orange`, `red`, `purple`, and `pink`. When annotations are writable, the select and multi-select menus expose the same palette beside each option.

The **New view** flow starts from the current JSON path. A single record becomes an editable page, while a record collection can become a table or Kanban board. Kanban creation also records the selected grouping property; arrays and scalar paths keep their natural JSON layout.

A root array cannot contain `$jsonviews` metadata directly. Before the first saved view, JSON Views shows a warning and requires an explicit **Wrap and create view** action. This changes the root to `{ "$jsonviews": {...}, "data": [...] }`, rebases inferred paths to `$.data`, and preserves the array items.

## Use it in React

```tsx
import { JSONContent } from '@script-it/json-views-react'
import '@script-it/json-views-react/styles.css'

export function Viewer({ source, save }: { source: string; save: (next: string) => Promise<void> }) {
  return (
    <JSONContent
      documentId="workspace:file-id"
      content={source}
      path="data.json"
      theme="inherit"
      edit={{
        isEditing: false,
        editContent: source,
        onEditChange: () => undefined,
        onCommitContent: save,
      }}
    />
  )
}
```

The packages are deliberately separated:

- `@script-it/json-views-core`: metadata inference and compilation, JSONPath subset, validation, view model, and source-preserving patches.
- `@script-it/json-views-react`: the extracted viewer UI plus type and widget registries.
- `@script-it/json-views`: the local file CLI and browser host; it installs the `json-views` executable.
- `@script-it/json-views-web`: the static upload/paste/download app.

Annotations can also be supplied separately through `metadata`, including for array and primitive roots. This preserves ordinary application JSON without adding `$jsonviews`.

See [the annotation specification](packages/core/README.md#annotation-specification), [React integration](packages/react/README.md#react-integration), and [the local file and agent API](packages/cli/README.md#local-file-and-agent-api). Each package documents its own contract.

## Agent skill

The repository includes a portable JSON Views skill at [`skills/json-views`](skills/json-views/SKILL.md). It teaches agents how to open local files, use revision-safe API writes, author `$jsonviews` metadata, and verify saved views.

## Develop

Requires Node.js 22.13+ in the 22 series, or Node.js 24+. React 18 and 19 are supported. The browser UI uses modern CSS, including nesting and `color-mix`; older browsers require a host-specific compatibility build.

```bash
npm ci
npm test
npm run check
npm run build
npm run dev
```

`npm run check:release` also installs the actual npm tarballs into an independent consumer and checks ESM, React SSR, strict TypeScript, browser bundling, and the installed CLI. CI runs Node 22/24 with React 18/19. Read [Contributing](CONTRIBUTING.md) before changing a public contract.

## License and trademarks

The source in this repository is MIT licensed; see [LICENSE](LICENSE).

The MIT license covers the code. It does not grant rights to the Script.it and JSON Views names, logos, or other brand assets, which remain the property of Script.it. A fork may use the code freely, but should carry its own name and marks rather than presenting itself as Script.it or JSON Views.
