# @script-it/json-views-react

An extensible React JSON inspector and editor. Requires React 18 or 19.

```tsx
import { JSONContent } from '@script-it/json-views-react'
import '@script-it/json-views-react/styles.css'

<JSONContent content={source} documentId={documentId} edit={{
  isEditing: false,
  editContent: source,
  onEditChange: setSource,
  onCommitContent: save,
}} />
```

Omit the edit callback for a read-only viewer. Use a stable document identity that includes the account/workspace/file. Save callbacks return real persistence completion; errors preserve the draft. To keep visual state across mounts, cache `presentationState` from `onPresentationStateChange` separately from the JSON and pass it back for that document.

The embedded frame provides Table and Source tabs, using table and `{ }` icons. Source sits directly below the shared view bar; there is no separate source toggle. Its Format action (when formatting is available) and save state use the shared toolbar. View options remains available in Source for the previously selected structured view, without leaving Source. JSON source is syntax-highlighted. Read-only embeds can inspect the exact source; editable embeds debounce valid source changes through the same save callback and retain invalid or failed drafts for repair. Hosts that already own their raw-source lifecycle can control the mode with `sourceVisible` / `onSourceVisibleChange` and mirror drafts through `edit.onEditChange`.

Use `CSVContent` for CSV or `StructuredDataContent` with a Core format adapter. Array-root JSON and CSV keep metadata in session state; provide `onRequestMetadataPersistence` to let the host confirm and create an object-root JSON document before embedded metadata is written.

Library styles are scoped to each viewer. Theme with `theme="light"` / `theme="dark"`, or inherit an ancestor's `data-json-views-theme` or `.dark`. Public `--json-views-*` variables allow host token mapping. The optional `standalone.css` only themes a host with the `json-views-app` class.

Mobile layout follows the browser's mobile identity, with a user-agent fallback, independently of window width. Hosts can read `useJsonViewsDevice()` or wrap viewers in `<JsonViewsDeviceProvider device="mobile">` (or `"desktop"`) to override it, including in previews. The same components and portaled controls share this setting.

See [React integration](#react-integration) below for custom types, object widgets, external metadata, and persistence. MIT.

### Minimal editable embed

```tsx
<JSONContent documentId={file.id} content={file.source} revision={file.revision} onSave={save} />
```

`save(nextSource, context)` must resolve after persistence and may return the accepted source and revision. Omit `onSave` for read-only data; use `isSaving` for host-controlled locking. Legacy `edit.onCommitContent` integrations continue to work. See the integration guide for external annotation persistence, independent registries, and scoped styling.

The Table tab was previously labeled Root. This is a display-name change: `presentationState.activeView: "root"` still selects Table, and `"source"` selects Source. JSON root paths such as `$` are unchanged. The initial source-default heuristic never overrides a supplied `sourceVisible` value or a saved selection.

## Embedded HTML views

Use `display: "html"` with `path`, a non-empty `html` string and optional `css` string inside `$jsonviews.views`. The same-file template supports source-bound values, existing field editors, native controls and repeated arrays. See [HTML views](#html-views) below for the format, bindings, isolation, and examples.

## React integration

Install the matching core and React package versions, import `@script-it/json-views-react/styles.css`, and render `JSONContent` with the original JSON string. React 18 and 19 are supported. Package imports are ESM and declarations support NodeNext.

```tsx
import { JSONContent } from '@script-it/json-views-react'
import type { JsonDocumentSave } from '@script-it/json-views-core'
import '@script-it/json-views-react/styles.css'

export function FileViewer(props: {
  id: string
  path: string
  content: string
  revision: string
  save: JsonDocumentSave
}) {
  return <JSONContent
    documentId={props.id}
    path={props.path}
    content={props.content}
    revision={props.revision}
    theme="inherit"
    onSave={props.save}
  />
}
```

### Identity and persistence

`documentId` is stable for one document and changes when switching files, workspaces, or accounts. Use an opaque resource ID or an unambiguous encoding such as `JSON.stringify([accountId, workspaceId, fileId])`. `path` is a display label and fallback identity; two files with the same name must not share an explicit ID.

The save callback receives `(nextSource, { documentId, baseContent, baseRevision })`. Capture the storage destination from that context, apply revision checks in your backend, and resolve with `{ content: acceptedSource, revision: acceptedRevision }` only after persistence succeeds. Reject failures. Do not swallow errors or resolve a save when a request is merely queued. A legacy one-argument callback returning `Promise<void>` remains supported, but revision-aware acknowledgements distinguish delayed host renders from new external changes.

```ts
const save: JsonDocumentSave = async (content, context) => {
  return storage.compareAndSwap({
    id: context.documentId,
    expectedRevision: context.baseRevision,
    content,
  })
}
```

`storage.compareAndSwap` above represents your host API, not a package dependency. Keep the original source authoritative in host state. Publish returned acknowledgements to that state; the viewer preserves newer in-flight drafts. A failed edit remains visible with retry, discard, and source recovery. An external change while dirty requires explicit reload/discard after preserving the draft.

`JsonDocumentSession` is also exported by core for hosts with a source editor. Its `edit` and `commit` preserve arbitrary source text by default, an optional `validateContent` callback can enforce a format, and `receive` accepts host snapshots. Subscribe with `useSyncExternalStore`; use one session per document identity. See `apps/web/src/App.tsx` for the complete source/visual editor flow.

The host owns persistence. Supplying `onSave` enables visual edits; omitting it creates a read-only viewer. `isSaving` can additionally lock edits while the host is saving. The older `edit.onCommitContent` and `edit.isSaving` adapter remains supported; the top-level props take precedence.

The embedded frame provides Table and Source tabs, using table and `{ }` icons. Source sits directly below the shared view bar; there is no separate source toggle. Its Format action (when formatting is available) and save state use the shared toolbar. View options remains available in Source for the previously selected structured view, without leaving Source. JSON source is syntax-highlighted. It shows exact JSON or CSV source in read-only embeds and debounces valid source edits through the same save callback in editable embeds. Invalid and failed drafts stay visible. A host with an existing source session can pass `sourceVisible` and `onSourceVisibleChange`, mirror each draft through `edit.onEditChange`, and retain ownership of its save policy.

Presentation state is a separate, serializable host contract. Pass a cached `presentationState` and store each value emitted by `onPresentationStateChange` under the same stable document identity:

Load the cache before mounting the viewer. It seeds presentation state on mount and whenever `documentId` changes; updates for the same mounted document come from user interaction.

```tsx
<JSONContent
  documentId={props.id}
  content={props.content}
  presentationState={uiStateByDocument[props.id]}
  onPresentationStateChange={(state) => cacheUiState(props.id, state)}
/>
```

It includes the active view, per-view search, table widths/scroll, transient inferred-table sort and hidden columns, and general JSON navigation/scroll/Markdown display. It deliberately excludes selections, dialogs, confirmations, drags, and unfinished editors. Never insert it into `$jsonviews`: declared columns, filters, sorts, grouping, labels, and display modes already belong to metadata and remain authoritative.

`JSONContent` automatically infers typed widgets and useful nested collection views when `$jsonviews` is absent. The inferred metadata is transient. If a user saves inferred view settings, the normal commit callback receives JSON with the inferred schema and views materialized under `$jsonviews`. An explicit `$jsonviews` always disables inference.

### Register a custom type and widget

```tsx
import {
  JsonViewsProvider,
  createDefaultWidgetRegistry,
} from '@script-it/json-views-react'
import { createDefaultTypeRegistry } from '@script-it/json-views-core'

const types = createDefaultTypeRegistry().register({
  name: 'rating',
  validate(value, descriptor) {
    const maximum = Number(descriptor.maximum ?? 5)
    return typeof value === 'number' && value >= 1 && value <= maximum
      ? undefined
      : `Choose a rating from 1 to ${maximum}`
  },
})

const widgets = createDefaultWidgetRegistry().register(
  'rating',
  ({ label, value, disabled, onCommit }) => (
    <input
      aria-label={label}
      disabled={disabled}
      type="range"
      min="1"
      max="5"
      value={typeof value === 'number' ? value : 1}
      onChange={(event) => onCommit(Number(event.target.value))}
    />
  ),
)

export function App() {
  return (
    <JsonViewsProvider types={types} widgets={widgets}>
      {/* JSONContent instances use both registries. */}
    </JsonViewsProvider>
  )
}
```

Custom descriptor properties are preserved and passed to both validation and editor widgets. Add `validateDescriptor` for type-specific annotation shape checks. A type's optional `parse` maps persisted JSON into an editor model, and `serialize` maps the committed model back into JSON. The canonical validator runs on serialized JSON before source patching and saving; thrown errors remain visible in the editor. Omitted conversions are identity.

Editors receive `value`, `stringValue`, `descriptor`, `disabled`, `error`, and `onChange`/`onCommit`/`onCancel`. `onChange` updates the local draft; `onCommit(value)` submits a candidate, while `onCommit()` submits the current draft. Respect `disabled` while a save is pending. An optional display receives the canonical JSON value, `compact`, `onOpen`, and the host Markdown renderer. Object and array values use the same widget contract, including at the current/root location, with an Expand action for structural inspection.

Core `filterOperators`, `matchesFilter`, and `compare` supply custom filtering and ordering. Comparators must define a consistent order. Register implementations before compiling annotations; use registry methods to replace or unregister them. Registries notify mounted viewers of changes. Create a provider-scoped registry or clone when behavior must differ across instances. See the [complete extension contract](annotation-spec.md#extension-lifecycle) and the [working custom-object consumer](../examples/consumer/src/main.tsx).

Registrations are additive. Replacing only a type's editor preserves its existing display widget:

```tsx
const widgets = createDefaultWidgetRegistry().register('date', {
  editor: CustomDateEditor,
})
```

For optional dates, `JSONContent` sets Clear to `null` by default. Pass `clearBehavior="remove"` when the host should remove the property instead.

### Tall table cells

Table cells clip values taller than `9rem` (about six lines), so long text and wrapped choices keep rows scannable. Selecting a clipped cell floats its whole value over the rows below without changing any row height; editing a cell opens its editor in that same surface. A record's title cell keeps opening the record, which shows the whole value. Configure this with the optional `tableCells` prop on `JSONContent`, `CSVContent`, or `JsonViewer`:

```tsx
<JSONContent
  content={content}
  tableCells={{
    overflow: 'clamp', // default; 'grow' lets rows fit their tallest value
    maxHeight: 160,    // pixels or any CSS length; default '9rem'
    reveal: 'select',  // default; 'none' keeps clipped cells clipped
  }}
/>
```

Hosts can also set the limit in CSS, per container or breakpoint, with `--json-views-table-cell-max-height`; a `maxHeight` prop takes precedence for its viewer.

Built-in `select` and `multi-select` widgets are creatable. Descriptor `options` provide the initial suggestions, while new string values remain valid and are inferred back into the effective option list wherever the same schema declaration applies.

Use descriptor `optionColors` to assign a palette color per option. With writable annotations, the menu shows a palette button beside each option and persists the selected color through the annotation host callback.

### External annotations

Pass `metadata={{ version: 1, schema: ..., views: ... }}` to annotate any JSON root without inserting `$jsonviews`. This overrides embedded annotations and inference. Supply `onMetadataChange` to persist view settings separately; otherwise the external annotations are read-only. The host must return the accepted metadata through props. Removing `metadata` restores embedded annotations or inference. These saves do not request conversion or change the source. For transient annotations owned by the viewer, set `metadataPersistence="session"`; their lifetime is the mounted document session. Creating or deleting a property together with its annotation is offered for embedded object-root documents, where both can be committed atomically. Hosts using external annotations should coordinate such schema/data changes in their own storage transaction. Malformed and future versions produce visible diagnostics and cannot be silently replaced by version 1 settings.

JSON Views descriptors are not JSON Schema. The packaged `@script-it/json-views-core/schema.json` validates annotation structure; the compiler additionally validates paths, registered types, patterns, and document values. See the [normative specification](annotation-spec.md).

### Styling, portals, and accessibility

`JSONContent` includes `JsonViewsSurface` and scopes its styles and presentation state to that instance. State is in-memory unless the host supplies the presentation-state callbacks above. Navigation and hidden columns are never stored in a module-global cache. Each `JsonViewsProvider` also owns independent default registries. No host Tailwind installation is required. Use `theme="light"` or `theme="dark"` for explicit sibling themes; `inherit` reads the nearest host `data-json-views-theme`, `.light`, or `.dark`, falling back to light. It does not independently choose an OS theme.

Override semantic tokens on a containing element with `--json-views-background`, `--json-views-foreground`, `--json-views-card`, `--json-views-border`, `--json-views-muted`, `--json-views-accent`, `--json-views-primary`, `--json-views-ring`, their foreground companions, `--json-views-font-family`, and `--json-views-table-cell-max-height`. Popups receive the same theme and tokens in a per-instance portal root. Use `portalContainer` for a host modal/overlay boundary; the supplied element should belong to the same document. `JsonViewsSurface` is exported for compositions using lower-level components.

```css
.product-json-viewer {
  --json-views-background: var(--background);
  --json-views-foreground: var(--foreground);
  --json-views-card: var(--card);
  --json-views-card-foreground: var(--card-foreground);
  --json-views-border: var(--border);
  --json-views-muted: var(--muted);
  --json-views-muted-foreground: var(--muted-foreground);
  --json-views-accent: var(--accent);
  --json-views-accent-foreground: var(--accent-foreground);
  --json-views-primary: var(--primary);
  --json-views-primary-foreground: var(--primary-foreground);
  --json-views-ring: var(--ring);
}
```

`standalone.css` is optional and styles only a `.json-views-app` host. Embedded integrations normally import only `styles.css`. To fill a panel, give its parent a bounded height and pass `fillHeight`; the default table uses an inline height cap. Provide accessible labels for custom widgets and keyboard equivalents for any custom pointer interaction. Built-in column resizing supports arrow keys. Focus a Kanban card’s grip and use left/right arrows to change columns or up/down arrows to reorder; reduced-motion preferences are respected.

### Exact source and recovery

Keep the original string, including when uploading invalid JSON. The renderer reports duplicate keys and numbers that JavaScript cannot represent exactly. Structured inspection displays affected numbers using their exact source literals; replacement of an affected value or ancestor is disabled, while unrelated edits preserve those tokens. Ambiguous duplicate-key descendants require source editing. The recovery editor submits explicit source text and preserves it on failure. A custom exact-number editor should work on source tokens rather than rounded inspection values.

## Date type

The `date` type stores a calendar date, a floating date-time, or a timezone-aware date-time:

```json
{
  "$.tasks[*].due": {
    "type": "date",
    "title": "Due",
    "description": "When this task is due",
    "required": false,
    "minimum": "2026-01-01",
    "maximum": "2027-12-31",
    "defaultIncludeTime": false,
    "placeholder": "Select a date"
  }
}
```

Accepted values are `null`, `YYYY-MM-DD`, and ISO 8601 date-times with seconds. A date-time may be floating with no timezone, or include `Z` or a `±HH:MM` offset. Fractional seconds are accepted. Unix timestamps, locale-formatted strings, and empty strings are rejected.

### Editor behavior

Clicking a date opens its calendar immediately. Day, time, and timezone changes remain in a draft until Save; Cancel and Escape discard the draft. Enabling time requires a valid hour and minute and saves seconds. Floating date-times remain timezone-less unless the user chooses a timezone. Changing between timezone offsets preserves the instant; adding or removing a timezone preserves the displayed wall-clock time. Disabling time warns before saving the calendar date alone.

Clear is disabled for required fields. Optional dates default to `null`; a host can remove the property instead:

```tsx
<JSONContent clearBehavior="remove" {...props} />
```

Date-only bounds and filter operands compare the written calendar day. Timestamp operands use a consistent reference timeline: zoned values use their instant, while date-only and floating values use their written fields as a UTC ordering reference. Equal references break ties by kind (date, floating, zoned). This does not assign a timezone to floating values. Missing and invalid values remain last in either sort direction. Filters support `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `isEmpty`, and `isNotEmpty`. See the [normative date semantics](annotation-spec.md#dates-sort-order-and-calendar-predicates).

### Replace only the widget

Parsing, validation, serialization, comparison, and filtering live in `@script-it/json-views-core`. The display and editor are registered separately in `@script-it/json-views-react`, so a consumer can replace the editor without replacing the core behavior or built-in display:

```tsx
const widgets = createDefaultWidgetRegistry().register('date', {
  editor: CustomDateEditor,
})
```

The built-in calendar supports Enter or Space to open, Escape to cancel, arrow keys to move by day or week, Page Up and Page Down to move by month, and Home and End to move to the start or end of a week.

## HTML views

A view with `display: "html"` contains its HTML and CSS in the same `$jsonviews.views` declaration as the rest of the document. Data is stored once. Editing a binding changes the source field through the existing save callback and source-preserving adapter.

```json
{
  "name": "Launch",
  "progress": 65,
  "tasks": [{ "id": "t1", "title": "Welcome screen", "done": false }],
  "$jsonviews": {
    "version": 1,
    "schema": { "$.progress": { "type": "number", "minimum": 0, "maximum": 100 } },
    "views": [{
      "id": "launch",
      "name": "Launch page",
      "path": "$",
      "display": "html",
      "html": "<main><h1><jv-field bind=\"$.name\"></jv-field></h1><label for=\"progress\">Progress</label><input id=\"progress\" type=\"range\" min=\"0\" max=\"100\" jv-bind=\"$.progress\"><jv-repeat source=\"$.tasks\" as=\"task\" key=\"id\"><p><input type=\"checkbox\" jv-bind=\"task.done\" aria-label=\"Done\"><jv-field bind=\"task.title\"></jv-field></p></jv-repeat></main>",
      "css": "main { max-width: 720px; margin: auto; padding: 32px; } h1 { font: 36px Georgia, serif; }"
    }]
  }
}
```

### Bindings

- `jv-value` element: display a scalar value without editing.
- `jv-field` element: display a scalar value and open the existing schema/registry field editor when clicked. Shared editors appear in the product layer, outside the authored CSS.
- `jv-bind` on input or textarea: edit the source value. Supported inputs are text, number, range, and checkbox. Range commits at pointer/keyboard completion; text and number commit on blur or Enter; textarea uses blur or Ctrl/Cmd+Enter. Escape cancels. A failed native edit can be retried by completing the interaction again.
- `jv-value` attribute on progress/meter: bind the numeric value property.
- `jv-attr-<attribute>`: read a scalar into an allowed attribute: title, aria-label, aria-valuenow, aria-valuetext, x/y/cx/cy/x1/x2/y1/y2/width/height/r/rx/ry/fill/stroke/opacity. URLs are not permitted in attributes.
- `jv-repeat source="$.tasks" as="task" key="id"`: repeat over an array. Aliases use ordinary path suffixes (`task.title`, `task['odd.key']`); nested repeats can reference outer aliases. Keys must be unique strings or finite numbers. Unkeyed arrays can display/edit against an unchanged acknowledged document, but have no stable row identity across reorder.

Use explicit closing tags for custom elements (`<jv-field ...></jv-field>`); self-closing XML syntax is unsupported. `$` always references the document root. Bindings must stay within the declaration's `path` and cannot access `$jsonviews`. Bindings do not contain arithmetic, functions, wildcards or JavaScript expressions. Computed values and custom JavaScript are not supported.

Missing bindings and unsupported object/array fields show an error indication. Use repeats for collections. Edits that began before another accepted source change are refused rather than redirected to a different record. Exact numeric source spelling and unsafe edit restrictions are retained.

### Authoring and portability

Create an HTML view directly in the JSON source by adding a view with `display: "html"`, a non-empty `html` template, and optional `css`. Once declared, **View options** can edit the HTML/CSS, Preview, and Apply. Apply saves both strings atomically. Cancel discards the working preview. Existing Source, Download, browser persistence, and sharing carry the template with the data. Embedded HTML works in the reusable React viewer without web-app-specific registration; omit the save callback for read-only use.

Layout/CSS runs in a sandboxed frame. Authored scripts, forms, navigation, external resources, event handlers, inline style attributes, and unsafe embedding/SVG elements are removed. Common structural HTML, tables, allowed controls, inline SVG shapes/text, and bounded raster data-URI images are supported. CSS is inserted as style text and external loads are blocked. Unsupported markup produces renderer warnings; raw source remains available.

The frame inherits `--jv-background`, `--jv-foreground`, `--jv-muted`, `--jv-border`, and `--jv-accent` tokens and the viewer's color scheme. Templates can use `light-dark()` for their own palette.

Limits: HTML and CSS 256 KiB each, template 5,000 nodes / depth 64, expansion 10,000 nodes. Large arbitrary layouts are not virtualized. HTML views do not use built-in columns/filter/sort/group configuration; use another ordinary view to browse the same collection as a table or board.

Examples are bundled as `Examples/HTML Launch.json`, `Examples/HTML Room Plan.json`, and `Examples/HTML Product Sheet.json`.
