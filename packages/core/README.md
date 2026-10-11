# @script-it/json-views-core

Framework-free annotation compilation, validation, view projection, document sessions, and source-preserving edits.

```js
import { applyJsonPatchInSource, compileJsonViewMetadata, inspectJsonSource } from '@script-it/json-views-core'
const { value, diagnostics } = inspectJsonSource(source)
const compiled = compileJsonViewMetadata(value)
const nextSource = applyJsonPatchInSource(source, [{ op: 'replace', path: '/done', value: true }])
```

Metadata is JSON Views' custom annotation format, not standard JSON Schema. The metadata schema is exported as `@script-it/json-views-core/schema.json`. Patterns use RE2 syntax without backreferences or look-around. Imported source must remain authoritative; inspection warns about unsafe numeric values and duplicate keys.

JSON objects, JSON arrays, and CSV use the exported format adapters. `csvFormat` normalizes rows for compilation while preserving BOM, quoting, line endings, and unrelated source bytes during edits. Use `convertToJsonViewsDocument` when array-root JSON or CSV needs embedded `$jsonviews` metadata.

`applyJsonPatchInSource` applies standard RFC 6902 operations atomically with RFC 6901 JSON Pointer paths. It preserves unrelated source bytes and reports the failed operation through `JsonPatchError`.

The complete annotation contract is documented in [Annotation specification](#annotation-specification) below.

Requires Node 22.13+ in the 22.x line or Node 24+. Browser bundlers are supported. MIT.

### Exact comparisons and resource limits

`compareJsonValues` orders booleans, numbers, strings, arrays, and objects by type, then by value (containers use lexicographic key/value ordering); null and missing values sort last. `jsonValuesEqual` uses structural, case-sensitive equality. Numeric source tokens are compared as exact decimals without expanding exponents.

For source-aware projections, pass a number-token lookup as the fifth argument to `applyJsonViewViewRows` or `projectJsonViewCollection`. Build it from non-shadowed `unsafe-number` diagnostics, keyed by `JSON.stringify(diagnostic.sourcePath)`. Without a lookup, only the supplied JavaScript values can be compared. The React viewer supplies this lookup automatically. Embedded filter operands also retain their source paths; external metadata operates on its supplied parsed values.

Structured operations support up to `MAX_JSON_DEPTH` (512) nested object/array containers. Deeper input raises `JsonDepthLimitError`, whose code is `json-depth-limit`; this is a resource limit, not invalid JSON syntax. Keep original source available for recovery. Source scanning and diagnostic traversal use explicit stacks.

## Annotation specification

Version 1 describes how JSON is inspected, validated, and presented. The annotation `schema` is a JSON Views descriptor map; it is **not** the JSON Schema vocabulary. The packaged [`jsonviews.schema.json`](./schema/jsonviews.schema.json) is a Draft 7 JSON Schema **for annotation objects**. It checks their structural shape. The compiler additionally checks paths, registered types, regex syntax, valid dates, compatible views, and values in the document.

### Document and annotation boundary

```ts
import { compileJsonViewMetadata, createDefaultTypeRegistry } from '@script-it/json-views-core'

const registry = createDefaultTypeRegistry()
const metadata = {
  version: 1,
  schema: { '$.rows[*].score': { type: 'number', minimum: 0, required: true } },
  views: [{ name: 'Scores', path: '$.rows' }],
}
const compiled = compileJsonViewMetadata({ rows: [{ score: 3 }] }, registry, { metadata })
```

An explicit `metadata` option takes precedence over embedded annotations and inference, including when its value is null or invalid. This supports JSON roots of any type without inserting a property into the user's data. Without this option, the compiler selects the root's own `$jsonviews` property. If it is absent, the compiler infers useful descriptors and views. An existing invalid annotation never triggers inferred replacement.

The compiler returns the untouched effective `metadata`, its `metadataSource` (`external`, `embedded`, or `inferred`), and a `status`: `none`, `ready`, `invalid`, or `unsupported-version`. `ready` means version 1 was processed; callers must still inspect `diagnostics`. `recognized` identifies valid, explicitly supplied version 1 annotations. `active` identifies compiled presentation/validation work; invalid or unsupported annotation versions are inactive but still carry diagnostics.

Only integer version `1` is supported. Other positive integer versions produce `unsupported-metadata-version`; malformed annotations produce `invalid-metadata`. The raw future metadata is retained for round trips and source editing. Consumers must not overwrite it with inferred metadata or version 1 settings.

Checking every document value against the schema is most of the compile time on large documents. Callers that only need the compiled schema and views, such as a route or settings panel, can pass `{ validateValues: false }`: the schema, views, and every other diagnostic are identical, and value diagnostics are omitted.

### Paths and precedence

All paths start at `$`. Supported segments are `.property`, `['quoted property']`, `[0]`, and `[*]`. Quoted properties support single-quote, backslash, slash, control-character, and `\uXXXX` escapes. Array indices are nonnegative safe integers without leading zeros. A numeric-looking object key is a string property, such as `$['0']`; it is different from `$[0]`.

Wildcards match one array item **or one own dictionary property**. Recursive descent, slices, unions, JSONPath expressions, and filter expressions are not supported. View roots must be concrete; schema paths may contain wildcards. Record view fields must be `view.path + [*] + a concrete nonempty field path`, for example `$.rows[*].profile.email` for a `$.rows` collection.

Traversal reads own properties only. JSON keys including `__proto__` and `constructor` remain ordinary data. `setJsonValueAtPath` creates nested own data properties without following prototype properties or invoking inherited setters. Array construction accepts existing indices or the next consecutive index; it rejects sparse writes.

For a concrete location, schema precedence is:

1. More concrete segments win over wildcard segments.
2. Longer paths win where applicable.
3. Earlier declaration wins a tie.

Overlapping, equally specific descriptors that differ produce `schema-specificity-conflict`. This applies to dictionaries and arrays alike. Legacy `body` declarations normalize to `{ type: "markdown" }`. They do not select a special record property or limit how many text properties a record can contain.

### Descriptors and validation

Descriptors require `type`. Built-ins are `text`, `markdown`, `html`, `number`, `checkbox`, `select`, `multi-select`, `date`, `url`, and `email`. `body` is a legacy alias for Markdown. Applications register custom names through `JsonViewTypeRegistry`.

| Property | Contract |
| --- | --- |
| `title`, `description`, `placeholder` | Strings |
| `required`, `multiline`, `defaultIncludeTime` | Booleans |
| `minimum`, `maximum` | Finite numeric bounds, or valid date strings for `date`; null date bounds are ignored |
| `pattern` | RE2 pattern string of at most 4,096 UTF-16 code units |
| `options` | Array of strings; observed nonempty select values are appended to the compiled options |
| `optionColors` | Map of option value to `gray`, `blue`, `green`, `yellow`, `orange`, `red`, `purple`, or `pink` |
| `step` | Positive finite number used as an editor hint |

Invalid known descriptor fields generate diagnostics and are absent from the normalized descriptor. Unknown fields are preserved for extensions. An unregistered type generates `unknown-schema-type` and is excluded from the compiled schema. `nullable` is unsupported: optional values already permit null. `select` and `multi-select` are open choices; options are editor suggestions, not a closed enumeration. `step` is an editor increment, not a divisibility constraint.

Built-in descriptors warn about properties their editor/validator does not consume. `minimum`/`maximum` apply to number and date; `step` to number; `options`/`optionColors` to choice types; `multiline` to text; `placeholder` to text, body, and date; `defaultIncludeTime` to date. Common `pattern` checks strings only, so number, checkbox, and multi-select descriptors warn that it does not constrain their non-string values. Warnings preserve the fields for host extensions. Custom type definitions can declare `descriptorProperties` to supply their supported keys; omitting it keeps the extension vocabulary open. A registration snapshots this list alongside its operator list.

### Progressive diagnostics

Start with ordinary JSON and only the annotations the task needs. Valid documents do not receive a capabilities manual. When a problem occurs, each compiler diagnostic adds `help` with a concrete `fix`, `expected` shape, a bounded `received` preview, and relevant `examples`, `allowedValues`, or `capabilities`. Examples are illustrative values/fragments, not automatic patches. Value examples satisfy the normalized active constraints. Type names and filter operator allowlists come from the current host registry, including custom registrations.

`metadataPath` identifies the exact annotation property to edit; `sourcePath` identifies affected data. For a missing required ancestor, `sourcePath` can identify the unresolved container rather than the leaf, and the repair explains the distinction. `metadataSource` tells callers whether annotations are embedded, external, or inferred. For external annotations the leading `$jsonviews` in `metadataPath` is a logical namespace: remove that first segment when addressing the separate annotation object. Do not insert it into the data.

Diagnostics report independent syntax issues together, even when a view name or root path is invalid. Data-dependent checks wait for a resolvable path. Unknown annotation, view, column, filter, and sort properties produce warnings with supported keys; warning-only views remain usable. Invalid or duplicate explicit view IDs warn about the generated replacement. Errors exclude invalid views, while the raw document remains available.

The React issue count stays compact. Open an issue's **How to fix** disclosure for repair details and every affected data path. Repeated failures with the same cause are grouped; different failure messages on the same field remain separate. Browser console and WebMCP reads and writes return the same complete help directly to agents. Repair the reported issue, then inspect again; do not coerce data or weaken validation merely to clear diagnostics. Source diagnostics likewise explain exact-token and CSV repairs; their zero-based `start`/exclusive `end` offsets refer to UTF-16 source positions.

Null and missing values are allowed unless `required: true`. Empty strings are also optional empty values for every built-in except date; a date empty string is invalid. A required descriptor applies to its entire concrete path: missing, null, or scalar intermediate objects do not hide a missing required leaf. If an ancestor before a wildcard is missing or not a collection, the diagnostic points at that unresolved container prefix. An empty existing collection has no child instances, so required child fields do not impose a minimum collection size. Empty arrays are valid multi-select values even with `required`; use a custom type if a selection count is required.

`registry.validate` is the canonical pipeline used by document compilation and `validateJsonViewSchemaValue`. It checks optionality, the registered type validator, then the common pattern constraint. This gives the document issue list and editor commits the same outcome. Custom descriptor validation failures are schema diagnostics; throwing value validators and warning providers produce diagnostics instead of escaping rendering.

### Safe pattern semantics

Patterns use [RE2JS](https://github.com/le0pard/re2js), a pure JavaScript RE2 engine. Matching uses `matcher(value).find()`, so patterns search for a match; use `^` and `$` for a whole-string constraint. There is no user-controlled native `RegExp` backtracking path. Backreferences, lookaheads, and other unsupported constructs produce `invalid-pattern`. No lookbehind feature flag is enabled. JavaScript-specific regex syntax and Unicode details must not be assumed interchangeable with RE2.

Matching is linear in input length for a fixed pattern. The compiler caps pattern size at 4,096 code units and retains at most 128 compiled patterns. These limits bound pattern input and cache count; they are not a wall-clock deadline for processing an arbitrarily large document. Trusted custom validators remain application code and must implement their own appropriate cost bounds.

### Views, filtering, and sorting

A view requires `name` and a concrete `path`. Absent `id`, the compiler assigns a deterministic identifier; duplicate IDs gain a numeric suffix. `columns` optionally supplies `{label, path}` entries. Missing or empty columns means infer columns from current rows. Labels need not be unique; projection assigns independent column IDs. Put the identifying field first: the first configured column supplies record links, Kanban headings, and opened record headings. Reordering or hiding it changes the label. View `title` is unsupported; schema `title` still labels a field.

Collections are arrays of objects or dictionaries whose values are objects. Single records render as record pages automatically; collection views use tables unless `display` selects `kanban` or `html`. `kanban` requires a record collection and `groupBy`. Optional `groupBy` and `orderPath` follow the record field path contract. `groupOrder` stores the ordered scalar lane values; values not currently present render as empty lanes. `orderPath` must differ from `groupBy` and resolve to a finite number on every record. Invalid view configuration produces diagnostics and excludes that view; it does not make the raw document unavailable.

Filters have `rules` and optional `match: 'all' | 'any'` (default `all`). Empty rules leave rows unchanged. Common operators are `eq`, `neq`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `contains`, `notContains`, `isEmpty`, and `isNotEmpty`. Every operator except the two presence operators requires `value`. `in` and `notIn` require an array comparison value. Equality compares JSON structure, ignoring object property order. String containment ignores case; array containment uses structural equality. Presence treats missing, null, empty string, and empty array as empty. Missing values do not satisfy non-presence common operators, including `neq`.

A type's `filterOperators` is its allowlist. Custom names are accepted when the matching registered types declare them; custom operators use `matchesFilter`. All applicable field types in the current collection must allow a configured rule. A custom matcher can return `undefined` to use common operator behavior. Unknown operators never fall through to an ordering operation. A custom operator without a declared type is rejected. `date` permits equality, inequality, ordering, and presence operators only.

Invalid date comparison operands are diagnosed at the rule's `value`; use a real date/timestamp string or a presence operator for missing dates. Filter operands are not constrained by the field's minimum/maximum bounds. A `value` on a presence rule produces a warning because it is ignored.

Sort entries have `path` and `direction: 'asc' | 'desc'`. Source order is the stable tiebreaker, and missing/null values stay last. Sort keys are resolved once per row. Each sort column uses one comparator for every pair: one homogeneous registered type uses its comparator; mixed type annotations use the generic ordering. Plugins must supply comparators that are reflexive, antisymmetric, and transitive.

### Dates: sort order and calendar predicates

Dates accept `YYYY-MM-DD`, timezone-aware RFC 3339 timestamps with seconds and optional fractional seconds, and floating timestamps without an offset. Calendar validity is checked, including leap years. Offsets are bounded by ±14:00; leap seconds and `24:00:00` are unsupported. Floating timestamps are not converted using the computer's timezone.

Sorting uses one consistent reference timeline: zoned values use their instant, calendar dates use midnight UTC as an ordering reference, and floating values use their written fields as a UTC reference. Equal reference timestamps break ties by kind: date, floating timestamp, then zoned timestamp. Zoned strings expressing the same instant and fractional value compare equal. Invalid/empty values sort last in either direction. This ordering reference does not assign a real timezone to floating dates.

A **date-only filter operand** compares the value's written calendar day for every relational operator. Thus a timestamp on `2026-01-02` in any written offset satisfies `eq`, `gte`, and `lte` against `2026-01-02`, and does not satisfy `gt` or `lt`. Timestamp filter operands use the sort order. Date-only bounds likewise compare written days; timestamp bounds use the reference timeline.

The built-in date widget exchanges canonical JSON strings. Its registry conversion hooks are identity. `parseDateValue`, `serializeDateEditorValue`, and `convertDateTimeToOffset` are separate helpers for applications needing structured date editing or explicit offset conversion.

### Extension lifecycle

```ts
const registry = createDefaultTypeRegistry().register({
  name: 'point',
  validateDescriptor: (descriptor) =>
    typeof descriptor.radius === 'number' ? undefined : 'radius must be numeric',
  parse: (json) => (json as { x: number }).x,
  serialize: (editorValue) => ({ x: Number(editorValue) }),
  validate: (json) =>
    json !== null && typeof json === 'object' && 'x' in json &&
    typeof json.x === 'number' && Number.isFinite(json.x) ? undefined : 'Expected a point',
  filterOperators: ['near'],
  matchesFilter: (json, operator, expected) => operator === 'near'
    ? Math.abs((json as { x: number }).x - Number(expected)) < 2 : undefined,
})
```

`parse` converts persisted JSON to an editor model. `serialize` converts the committed editor model back to JSON. Omitted conversion hooks are identity. The commit order is **serialize → canonical validation → strict JSON source patch → persistence**. Register a corresponding React widget for a custom visual editor. Object and array JSON values participate in this contract.

Registering or unregistering changes `registry.version` and notifies `registry.subscribe`. Definition objects and operator lists are snapshotted at registration. Use registry methods to change behavior; do not mutate objects returned by `get`. `clone()` makes an independent registry. React consumers must subscribe rather than relying only on registry object identity.

### Source preservation and plans

Keep the original source string as the authority and parse a separate inspection value. `inspectJsonSource` reports duplicate object keys, unsafe integers, overflow, underflow, negative zero, and decimal tokens changed by JavaScript-number conversion. Structured inspection uses `JSON.parse` values and therefore displays the last duplicate occurrence. Numeric diagnostics supply exact source literals to the React renderer, including large integers, overflow, underflow, negative zero, and decimal round-trip changes. Exact tokens also remain available in diagnostics and source. The renderer keeps structured inspection available and protects affected paths. Replacing an unsafe numeric token or an ancestor container is disabled. Duplicate keys also block descendant replacements whose identity is ambiguous. Unrelated scalar edits, array appends, and whole-row deletions remain available because their patches preserve retained data lexemes. Each transaction checks the latest source. A visible source-recovery editor permits exact token edits; annotation rewrites are also protected if the annotation object contains risky source tokens.

Patching helpers preserve unrelated bytes. The agent-facing mutation API accepts standard RFC 6902 JSON Patch with RFC 6901 JSON Pointer paths and applies each batch atomically. Typed internal paths distinguish array indices from property names. Replacement and removal select the last duplicate property, matching `JSON.parse`; removing it can expose an earlier duplicate. Batch replacement validates one document, scans/indexes its source once, rejects duplicate or overlapping spans, and assembles one result without repeated whole-document rewrites.

`stringifyJsonValue` accepts null, strings, booleans, finite numbers, dense arrays, and plain own-data objects (including null-prototype objects). It preserves numeric negative zero. It rejects undefined, functions, symbols, bigint, non-finite values, sparse arrays, accessors, cycles, custom object prototypes, and `toJSON` methods; no getters or conversion methods are invoked. A replacement is serialized once. Use source-level editing for numeric lexemes that a JavaScript number cannot express exactly.

Compiled metadata includes the root and each view's `value` snapshot for direct rendering. `applyJsonViewViewRows`, `projectJsonViewCollection`, and `resolveJsonViewRowPath` resolve against their explicit current-root argument. `getJsonViewViewRows(view, root)` does the same; `getJsonViewViewRows(view)` intentionally reads the compiled snapshot. Recompile when annotations or registry behavior change, or to refresh diagnostics and inferred options for a new document revision.

The synchronous compiler and scanner have no universal document-size guarantee. Table virtualization limits mounted rows, not parsing, validation, projection, or Kanban work. `inspectJsonSource` keeps the diagnostics of the most recently inspected text, so hosts that inspect one revision several times pay for one scan; applications handling very large documents should perform compilation/inspection in a worker and choose their own measured size budgets. The test workload covers 1,000 independent edits within a 10,000-row document, and comparator/adversarial-pattern regressions are retained in the core suite.

### Host acknowledgements and reloads

`JsonDocumentSession` keeps acknowledged source separate from the current draft. Saves resolve to accepted `{content, revision}` snapshots when a host supports revisions. The session remembers up to 32 recently acknowledged identities and ignores their delayed host echoes. Rejected drafts never enter this history. A matching host observation received during an in-flight save is provisional; after successful persistence, its explicit revision takes precedence over the response revision for the same accepted content. Opaque revision strings have no sortable age, so this rule treats the newer host observation as evidence of current state rather than comparing revision text. Different content still produces a conflict and preserves the local draft.

A revision can be a content hash, so an intentional rollback to an old `{content, revision}` pair is indistinguishable from a delayed echo. Use `receive(source, { authoritative: true })` for an explicit reload/rollback, or create a fresh document session. Unknown new revisions remain authoritative without this option. Authoritative receive still preserves conflicting unsaved drafts; use `reset()` after the save has settled to discard the draft. Hosts needing unbounded replay detection must provide their own ordered revision stream; the finite local history is not a durable event log.

### Embedded HTML views

Use `display: "html"` with `path`, a non-empty `html` string and optional `css` string inside `$jsonviews.views`. The same-file template supports source-bound values, existing field editors, native controls and repeated arrays. See [HTML views](https://github.com/script-it/json-views/blob/main/packages/react/README.md#html-views) for the format, bindings, isolation, and examples.
