# figma-bridge tools reference

Two transports, same commands. MCP tool names = HTTP command names.

## HTTP link API (any CLI, no config — preferred when the user pastes a link)

Base: `http://localhost:3055` (port from the bat; the plugin's link already has the right one).

- `GET /health` → `ok` (bridge running check)
- `GET /status` → `{ connected, file }` (plugin connection check)
- `GET /file?depth=2` → THE LINK: `{ ok, link, instructions, api_base, commands, for_browser_ai, document, selection, tree, components, styles }`. `depth` 0-5, default 2. Re-fetch for fresh state.
- `GET /selection` → `{ ok, result }` (current selection)
- `POST /api/<command>` with `Content-Type: application/json`, body `{"params": {...}}` → `{ ok, command, result }` or `{ ok:false, error }`
- `POST /api/batch` with body `{"calls": [{"tool": "<command>", "arguments": {...}}], "parallel"?: true, "stopOnError"?: true}` → `{ ok, command: "batch_tools", results: [{tool, ok, result|error}] }` (max 32 calls, sequential; `parallel:true` only fans out when every call is a read, up to 6 at once; 5MB total)
- Example: `curl -X POST http://localhost:3055/api/create_frame -H "Content-Type: application/json" -d '{"params":{"name":"Hero","width":800,"height":600}}'`

## MCP tools (opencode/Claude/Cursor via stdio; bat + opencode config required)

No `channel` param — the bridge auto-routes to the connected plugin (a legacy `channel` field is ignored if sent). If the bat's bridge already owns the port, the MCP instance auto-proxies over HTTP — no crash, no action needed.

## Command inventory (HTTP command = MCP tool name)

## Compact form (same results, fewer emitted tokens — prefer this)

Short tool names: `st` get_status · `doc` get_document_info · `sel` get_selection · `tree` get_node_tree · `node` get_node_by_id · `gcomps`/`gstyles`/`gvars` locals · `exp` export_node · `frm` create_frame · `rect` create_rectangle · `elp` create_ellipse · `txt` create_text · `stc` set_text_content · `fil` set_fills · `str` set_strokes · `props` set_node_props · `lay` set_layout · `del` delete_nodes · `clo` clone_node · `mov` move_node · `ssel` set_selection · `page` create_page · `grp` group_nodes · `comp` create_component · `inst` create_instance · `batch` batch_tools. Full names always work; long form wins if both given.

Short keys (any tool): `n` name · `w` width · `h` height · `f` fill · `p` parentId · `t` text · `s` fontSize · `id` nodeId · `ids` nodeIds · `cr` cornerRadius · `lm` layoutMode · `sp` itemSpacing · `pad` padding · `ff` fontFamily · `fs` fontStyle. Example: `{"tool":"frm","arguments":{"n":"Hero","w":800,"h":600}}`.

`get_node_tree` / `get_node_by_id` return slim nodes by default (heavy render keys `fills`, `strokes`, `effects`, bounding boxes, long text stripped); pass `"_full": true` to restore full fidelity. `get_selection` stays full — it is the codegen source.

`fields: [...]` allowlist on node-reading tools (`get_selection`, `get_node_tree`, `get_node_by_id`, locals, `get_dev_resources`, `inspect_css`, `get_canvas_view`, `get_reactions`): only those keys per node — `id`/`children`/`childIds`/`childCount` always survive for navigation. Example: `fields: ["name","type","x","y","width","height"]` for layout work without paint data. Omit for full data. Note: render keys (`fills`, `strokes`, `effects`) in `fields` still need `"_full": true` on tree reads, or default slim drops them after picking.

### Serialization tiers, write receipts, panel

- `_detail: "receipt" | "struct" | "full"` controls how much of a node serializes. `"receipt"` = `{id,name,type}` only (writes). `"struct"` = drops `fills`, `strokes`, `effects`, `relativeTransform`, `absoluteTransform`, `absoluteRenderBounds`, `layoutGrids`, `styledTextSegments`, `segmentsTruncated`, `rangeFonts`, `rangeFills`, `vectorNetwork`, `vertexCount`, `vectorPaths`, `fillGeometry`, `strokeGeometry`, `exposedInstances`, `annotations`, `guides`, `exportSettings`, `absoluteBoundingBox` (plus derived `annotationCount`/`guideCount`); used by `get_node_tree`/`get_node_by_id`. `"full"` = everything (default when absent). The bridge injects the tier; a per-call `_echo:true` (write) or `_full:true` (tree read) forces `full`, as does a `fields` list asking for a struct-dropped key. An explicit `_detail` is never overridden, and `fields` are never re-slimmed once supplied.
- Writes return a receipt `{id, name, type}` by default instead of the full node. `_echo:true` (per call, or top-level on `batch_tools`) restores the full response. Reads are unaffected. The honest-write report keys — `applied`, `mismatched`, `restoredChildren` — stay on the receipt even without `_echo`.
- `format: "panel"` on `get_node_tree` / `get_node_by_id` / `get_selection` / `get_current_page` returns `{panel, lines}` (indented text tree) instead of JSON. Any other value throws `invalid format: expected "panel"`. `export_node`'s `format` is unrelated (PNG/JPG/SVG/…).

Fetch discipline (catalog cheap, instances expensive): list first (pages, `depth: 0`–`1` child maps), then fetch only the nodes the task touches, only as deep as the decision needs — never whole-page `depth` ≥ 3 unless asked for everything. `get_node_tree` defaults to `depth: 2`. Session-static info (pages, component/style/variable inventories) is fetched once per session and re-fetched only after writes that change it.

## Session

- `get_status {}` → `{ connected, file }`
- `ping_figma {}` → `{ pong, file }`
- `get_plugin_info {}` → `{ apiVersion, mode, fileKey, editorType }` — `unknown` fallback per field
- `batch_tools { calls: [{tool, arguments}], parallel?, stopOnError? }` → `{ ok, results: [{tool, ok, result|error}] }` — up to 32 calls in one round-trip, sequential (ordered writes safe); `parallel:true` only when every call is read-only (fan-out 6 at once); stops at first error unless `stopOnError:false`; no nesting; 5MB total byte budget. For a single call, call that tool directly.

## Read

- `get_document_info {}` → `{ name, pages: [{id,name,childCount}], currentPage, editorType }` — `editorType` is `figma|figjam|dev|slides|buzz` (`unknown` fallback)
- `get_selection {}` → `{ count, nodes: [...] }` — serialized selection, depth 3
- `get_selection_colors {}` → `{ colors: [...] }` — paints used in the selection, up to 50
- `get_node_tree { nodeId?, depth? }` — subtree or current page; `depth` 0-10, default 2
- `get_node_by_id { nodeId, depth? }`
- `find_nodes { parentId?, types?[], nameContains?, textContains?, textEmpty?, limit?, pluginData?, sharedPluginData? }` → `{ total, returned, truncated, matches: [{ id, name, type, path }] }` — `types` from FRAME|TEXT|RECTANGLE|ELLIPSE|COMPONENT|INSTANCE|GROUP|VECTOR|POLYGON|STAR|LINE; `nameContains` / `textContains` are case-insensitive substring filters (`textContains` matches TEXT `characters` only); `textEmpty:true` matches TEXT nodes with empty text; `pluginData { keys[]? }` / `sharedPluginData { namespace, keys[]? }` criteria; `limit` default 100, clamped 1..1000 (never throws — `truncated:true` when more match). `path` is ancestor names joined `" / "`, capped at 6 levels with a leading `… / ` when deeper
- `get_local_components {}` → `[{ id, name, type, page }]`
- `get_local_styles {}` → `{ paints, texts, effects }`
- `get_local_variables {}` → `{ collections: [{ id, name, modes, variables }] }`
- `export_node { nodeId, format?: PNG|JPG|SVG|PDF|MP4|GIF|WEBM, scale?, fps?, quality?: LOW|MEDIUM|HIGH, loopCount? }` → PNG/JPG/PDF/video give `{ format, nodeId, base64, mime }`; SVG gives `{ format, nodeId, svg }`. Video: MP4/WEBM fps 12|24|30|60 + quality, GIF fps 8|12|15|24|30 + loopCount 0-1000. MCP-only `savePath` makes the bridge write the file and returns `savedTo` (HTTP has no savePath — fetch the base64 and write it yourself).
- `get_measurements { nodeId? }` → `{ measurements: [...] }` — page-level when nodeId omitted, capped 200
- `get_file_thumbnail {}` → `{ nodeId|null }` — node used for the file thumbnail

Serialized nodes include: `id, name, type, x, y, width, height, rotation, opacity, fills, strokes, effects`, auto-layout fields when present (`layoutMode, itemSpacing, padding*`, align), text fields for TEXT (`characters` truncated to 20000, `fontName, fontSize`, alignment), `children` recursively per depth (else `childCount` + `childIds`).

## Write

- `create_frame { name?, width?, height?, x?, y?, fill?, parentId?, layoutMode?: NONE|HORIZONTAL|VERTICAL, itemSpacing?, padding? }`
- `create_rectangle { name?, width?, height?, x?, y?, fill?, cornerRadius?, parentId? }`
- `create_ellipse { name?, width?, height?, x?, y?, fill?, parentId? }`
- `create_text { text, fontSize?, fontFamily?, fontStyle?, fill?, x?, y?, name?, parentId?, align? }` — `fill` is a hex string
- `set_text_content { nodeId, text }`
- `set_text_props { nodeId, lineHeight?: number|"AUTO", letterSpacing?: number, textCase?: ORIGINAL|UPPER|LOWER|TITLE|SMALL_CAPS|SMALL_CAPS_FORCED, textDecoration?: NONE|UNDERLINE|STRIKETHROUGH, leadingTrim?: NONE|CAP_HEIGHT, alignVertical?: TOP|CENTER|BOTTOM, autoResize?: NONE|WIDTH_AND_HEIGHT|HEIGHT|TRUNCATE, textTruncation?: boolean, maxLines?: positive int, textWrapStyle?: AUTO|BALANCE|PRETTY }` — text node only, fonts load automatically
- `set_text_range { nodeId, start, end, fontSize?, fontFamily?, fontStyle?, fill?, styleId?, fillStyleId?, link?: URL string|null|{type:URL,url}|{type:NODE,nodeId} }` — styles one character range only, fonts load automatically
- `get_text_list { nodeId }` → `{ type: ORDERED|UNORDERED|NONE }` — text node only
- `set_text_list { nodeId, type: ORDERED|UNORDERED|NONE }` — text node only
- `edit_text_chars { nodeId, mode: insert|delete, start, text?, end? }` — edits characters only, insert needs text and delete needs end
- `list_fonts {}` → `{ fonts: [{ family, style }] }` — read-only, at most 200 entries plus `truncated:true` when more exist
- `get_font_axes { family }` → `{ family, axes: string[]|null }` — null when the family is static
- `set_fills { nodeId, fills?[{color,opacity}], fill?, color? }` — fills[] also accepts `{type:"IMAGE",imageHash,scaleMode:FILL|FIT|CROP|TILE}`
- `set_strokes { nodeId, strokes?, strokeWeight?, strokeAlign?: CENTER|INSIDE|OUTSIDE, strokeTopWeight?, strokeRightWeight?, strokeBottomWeight?, strokeLeftWeight? }`
- `set_node_props { nodeId, props: { x,y,width,height,name,opacity,visible,locked,cornerRadius,fill,rotation } }` (also accepts flat props) — returns `{ applied, mismatched? }`; resizing needs BOTH `width` and `height`
- `set_layout { nodeId, layoutMode?: NONE|HORIZONTAL|VERTICAL|GRID, itemSpacing?, counterAxisSpacing?: number|null, padding?, paddingTop/Bottom/Left/Right?, primaryAxisAlignItems?, counterAxisAlignItems?, primaryAxisSizingMode?: FIXED|AUTO, counterAxisSizingMode?: FIXED|AUTO, preserveChildLayout? }` — returns `{ applied, mismatched?, restoredChildren? }`; `preserveChildLayout` (default true) snapshots children's `layoutGrow`/`layoutAlign`/`layoutPositioning` before a `layoutMode` change and restores them after (Figma normalizes them on that assignment)
- `delete_nodes { nodeIds[] | nodeId }` — confirm with user first
- `clone_node { nodeId, parentId?, x?, y? }`
- `move_node { nodeId, parentId, index? }`
- `rescale_node { nodeId, scale }` — scale must be >0, returns `{ id, scale }`
- `set_selection { nodeIds[] }` — selects + zooms
- `create_page { name?, select? }`
- `page_ops { action: rename|duplicate|background, name?, color? }` — acts on the current page; `background` needs `color`
- `create_section { name?, x?, y?, width?, height? }`
- `group_nodes { nodeIds[], name? }`
- `transform_group { nodeIds[], parentId?, index?, modifiers?[] }` — 2+ nodes, refuses PAGE/DOCUMENT, returns `{ id }`
- `flatten_nodes { nodeIds[] }` — 2-100 nodes, refuses PAGE/DOCUMENT, returns `{ id }` of the vector
- `create_component { name?, fromNodeId?, width?, height?, parentId? }`
- `create_instance { componentId, x?, y?, parentId? }`
- `set_instance_props { nodeId, properties }` — instance/component-set only, returns `{ applied, skipped }`
- `swap_instance { nodeId, componentId }` — instance only
- `detach_instance { nodeId }` — instance only
- `create_shape { kind: LINE|POLYGON|STAR, parentId?, x?, y?, pointCount?, name? }`
- `create_slice { parentId?, x?, y?, width?, height?, name? }`
- `create_variable_collection { name? }` → `{ id, name, modes }`
- `create_variable { collectionId, name, type?: COLOR|FLOAT|STRING|BOOLEAN|TIMING|EASING }`
- `apply_style { nodeId, styleId, kind: PAINT|TEXT|EFFECT }` — style must be local; TEXT needs a text node
- `set_export_settings { nodeId, settings[] }` — replaces exportSettings wholesale

## Selection/view

- `scroll_to_node { nodeId? | nodeIds[]? }` — scrolls viewport to node(s); selection unchanged
- `add_to_selection { nodeIds[] | nodeId }` — adds to current selection; drops PAGE/DOCUMENT ids
- `clear_selection {}` — clears current selection
- `get_canvas_view {}` → `{ center, zoom, bounds }` — read-only viewport, no node data
- `set_viewport { zoom?, centerX?, centerY? }` → returns the updated canvas view

## Layout/create

- `set_layout_child { nodeId, layoutGrow?, layoutAlign?: MIN|CENTER|MAX|STRETCH|INHERIT, layoutPositioning?: AUTO|ABSOLUTE }` — child props only, parent layout unchanged; returns `{ applied, mismatched? }`
- `set_layout` grid fields: `gridRowCount?, gridColumnCount?` (positive ints), `gridRowGap?, gridColumnGap?` (numbers >=0), `gridRowSizes?, gridColumnSizes?` (arrays), `gridAutoTracks?: NONE|ROWS` — GRID frames only
- `set_grid_child { nodeId, row, column, rowSpan?, columnSpan?, hAlign?: MIN|CENTER|MAX|AUTO, vAlign?: MIN|CENTER|MAX|AUTO }` → `{ nodeId, row, column, applied, mismatched? }` — child of a GRID frame only
- `get_transform { nodeId }` → `{ relativeTransform, absoluteTransform }` — read-only geometry
- `set_layout_constraints { nodeId, horizontal?: MIN|CENTER|MAX|STRETCH|SCALE, vertical?: MIN|CENTER|MAX|STRETCH|SCALE }` — constraints only, no auto-layout change
- `set_layout_positioning { nodeId, positioning?: AUTO|ABSOLUTE }` — positioning only, parent layout unchanged
- `set_layout_grids { nodeId, grids[] }` — frame/section/component only; each grid needs `pattern` ROWS|COLUMNS|GRID, missing numeric fields get sane defaults (COLUMNS/ROWS: STRETCH/24/12/0, GRID: sectionSize 100); returns `{ id, count }`
- `create_boolean_operation { nodeIds[], op?: UNION|SUBTRACT|INTERSECT|EXCLUDE, parentId?, index? }` — single boolean op only, needs paintable nodes
- `create_vector { parentId?, vectorNetwork?, x?, y? }` — raw vectorNetwork only, no path builder
- `set_image_fill { nodeId, imageHash, opacity?, scaleMode?, visible? }` — hash-only, no upload; hash must already exist in file
- `import_image { base64, name? }` — uploads base64 bytes (data-URI prefix ok, 5MB cap), returns `{ hash }`
- `get_image_bytes { hash }` — returns `{ hash, base64, width, height }`, truncated at 1500000 chars with `truncated:true`
- `toggle_layer_mask { nodeId, enabled? }` — mask flag only, needs shape parent to render

## Variables

- `set_variable_code_syntax { variableId, platform: WEB|ANDROID|iOS, value }` — code syntax only, no value change
- `bind_variable_to_property { nodeId, field, variableId }` — single field bind only, no bulk bind
- `set_variable_alias { variableId, modeId, aliasId }` — alias value only, both variables must exist
- `get_variable_modes { collectionId }` → `{ modes }` — read-only, no values
- `create_variable_mode { collectionId, name }` — adds empty mode only, no values set
- `update_variable_mode { collectionId, modeId, action: rename|remove, name? }` — rename/remove only, no add/duplicate
- `batch_update_variables { updates[] }` — non-atomic, partial failures return per-item `{ error }`
- `set_node_variable_mode { nodeId, collectionId, modeId }` — explicit mode override only, inherits when unset
- `get_variable_by_id { variableId }` → `{ id, name, resolvedType, collectionId, scopes }`
- `get_variable_collection_by_id { collectionId }` → `{ id, name, modes, variableIds, defaultModeId }`
- `list_library_collections {}` → `[{ name, key, libraryName }]` — up to 100
- `list_library_variables { key }` → `[{ name, key, resolvedType }]` — up to 200
- `get_node_binds { nodeId }` → `{ boundVariables, inferredVariables, resolvedVariableModes }` — read-only, null when absent

## Dev

- `get_dev_resources { nodeId? }` → `[{ name, url }]` — read-only, page-level when nodeId omitted
- `attach_dev_resource { nodeId?, name, url }` — attach URL only, no edit/delete helper
- `set_node_description { nodeId, description?, links?[] }` → `{ id, description?, linksApplied? }` — description capped 2000 chars, links need http(s) uri; node or style id
- `set_dev_status { nodeId, status: null|{type: READY_FOR_DEV|COMPLETED, description?} }` → `{ id, status }` — null clears
- `inspect_css { nodeId }` → `{ css }` — computed CSS only, read-only
- `create_version_history { title, description? }` — save-only snapshot, no list/restore; returns `{ id }` when Figma provides one

## Prototype

- `add_prototype_link { nodeId, destinationId, transition?: DISSOLVE|SMART_ANIMATE }` — tap-to-navigate link, appended to existing links
- `clear_prototype_links { nodeId }` — removes all links from a node
- `get_reactions { nodeId }` → `[...]` — read-only, `[]` when the node has no reactions

## Effects

- `set_effects { nodeId, effects[] }` — replaces effects wholesale
- `set_blend_mode { nodeId, blendMode? }` — blend mode only, no opacity change

## Motion (Beta)

Motion API renames go in the `MOTION COMPAT` table in `code.ts` only — no direct `node.applyAnimationStyle`/`figma.motion.*` calls elsewhere.

- `get_motion_info {}` → `{ playhead, styles: [{ styleId, name, description? }] }` (styles capped 100)
- `get_node_animations { nodeId }` → `{ animations, manualKeyframeTracks, timelines, animationStyles }` (arrays over 50 truncated)
- `apply_motion_style { nodeId, styleId, config?: { duration?, timelineOffset?, props? } }` → `{ id, nodeId }`
- `remove_motion_style { nodeId, id }` → `{ removed:true }`
- `set_manual_keyframes { nodeId, field, baseValue?, keyframes: [{t, value, easing?}], operation?: SET|OFFSET|SCALE }` → `{ nodeId, field, keyframes: count }` — field: `x|y|xy|opacity|scale|scaleX|scaleY|rotation|width|height|cornerRadius|strokeWeight` or real enum names (`TRANSLATION_X`, `STACK_*`, …) or `{collection:index[,field]}` for fills/strokes/effects; value: number|hex|`{r,g,b}`|string|boolean|raw `{type,…}`; easing: `EASE_IN|EASE_OUT|EASE_IN_AND_OUT|LINEAR|EASE_IN_BACK|EASE_OUT_BACK|EASE_IN_AND_OUT_BACK|GENTLE|QUICK|BOUNCY|SLOW|HOLD`|`{spring:{mass,stiffness,damping}}`|`{bezier:{x1,y1,x2,y2}}`
- `remove_manual_keyframes { nodeId, field }` → `{ removed:true }` — same field forms as `set_manual_keyframes`
- `set_timeline_duration { nodeId, id, duration }` → `{ nodeId, id, duration }` — duration must be > 0

### Motion gotchas (all hit in the wild)

- **VECTOR fields need a VECTOR value.** `SCALE_XY`, `SCALE_X`, `SCALE_Y`, `TRANSLATION_XY` reject a bare number with *"baseValue for SCALE_XY must be a VECTOR keyframe value"*. Pass raw `{type:'VECTOR', value:{x,y}}` for **both** `baseValue` and every keyframe. Scalar fields (`OPACITY`, `TRANSLATION_X/Y`, `ROTATION`, `WIDTH`…) take plain numbers.
- **`field: "scale"` maps to `SCALE_XY`**, so it needs the VECTOR form. Use `scaleX` / `scaleY` for scalar per-axis control.
- **Re-applying a track REPLACES it** (same field, whole track). To retime, just re-send the full keyframe list — no need to `remove_manual_keyframes` first.
- **Timeline ids are not stable.** Re-applying tracks after a plugin reload can mint a new timeline (`2149:197` → `2152:569`). Always read `timelines[0].id` from `get_node_animations` right before `set_timeline_duration`; never cache the id.
- **One timeline is shared** by every node that has tracks on it — set duration once from any tracked node.
- **No gravity in this sandbox of the API:** Motion has no built-in physics. Simulate offline and bake keyframes (see `motion-recipes.md`).
- **Video export is plan-capped at 30fps** on non-Pro plans: 60fps fails with *"exceeds the 1920×1080 / 30fps limit for this plan"*. `export_node { format:'MP4'|'GIF'|'WEBM' }` works at `fps:30`.
- `createCustomAnimationStyle` does **not** exist in the installed typings — never call it.

See `motion-recipes.md` for the keyframe-baking pattern (curved paths, pinned-tip physics).

## Styles

- `create_style { name, kind: PAINT|TEXT|EFFECT|GRID, color?, fontSize? }` — creates local style (GRID = layout-grid style), returns `{ id }`
- `delete_style { styleId }` — confirm with user first
- `rename_style { styleId, name }`
- `get_style_by_id { styleId }` — returns `{ id, name, type, description? }`
- `import_style { key }` — imports a published style by key, returns `{ id, name }`
- `get_style_consumers { styleId }` → `[{ nodeId, field }]` — capped 100
- `set_grid_style { nodeId, styleId }` → `{ id, styleId }` — node needs layoutGrids

## Pages & nodes

- `set_page_backgrounds { pageId?, backgrounds[] }` — replaces page backgrounds wholesale; `prototypeBackgrounds[]` optional passthrough
- `delete_page { pageId }` — confirm with user first
- `ungroup { nodeId }` — group/frame only, returns children
- `move_node_index { nodeId, index }` — reorder within parent only, no reparent
- `set_guides { pageId?, guides[] }` — replaces guides wholesale; page or frame
- `create_table { rows?, columns?, parentId?, x?, y? }`
- `create_connector { parentId?, x?, y?, connectorType? }`
- `create_sticky { text?, parentId?, x?, y?, fill? }`
- `create_shape_with_text { shapeType?, text?, parentId?, x?, y? }`
- `create_code_block { code?, language?, parentId?, x?, y? }`
- `create_slide { name?, parentId?, x?, y? }`
- `import_svg { svg, parentId?, x?, y?, name? }` — svg string only, no URL fetch
- `set_text_font { nodeId, fontFamily?, fontSize?, fontStyle? }` — text node only, fonts load automatically
- `create_page_divider { name? }` → `{ id, name }`
- `set_file_thumbnail { nodeId }` → `{ nodeId, set:true }` — node must be FRAME|COMPONENT|COMPONENT_SET|SECTION

## Components

- `create_component_prop_def { componentId, name, propType?: BOOLEAN|TEXT|INSTANCE_SWAP|VARIANT|SLOT, defaultValue? }`
- `delete_component_prop_def { componentId, propId }`
- `edit_component_prop_def { nodeId, propertyName, name?, defaultValue?, preferredValues?, description?, slotSettings? }` — only those fields accepted, anything else throws
- `import_component { key, set? }` — imports a published component by key (`set:true` imports the component set), returns `{ id, name, set }`
- `get_main_component { nodeId }` — instance only, returns `{ id, mainComponent: {id,name} | null }`
- `reset_instance { nodeId }` — instance only, resets direct overrides, returns `{ id, reset:true }`
- `combine_as_variants { componentIds[], name? }`
- `get_component_instances { nodeId }` → `[{ id, name }]` — component only, capped 100
- `create_slot { nodeId }` → `{ id }` — component only
- `reset_slot { nodeId }` → `{ id, reset:true }` — slot only

## Variables

- `rename_variable { variableId, name }`
- `import_variable { key }` — imports a published variable by key, returns `{ id, name }`
- `unbind_variable { nodeId, field }` — single field unbind only
- `delete_variable { variableId }` — confirm with user first
- `extend_collection { name, collectionKey? | collectionId? }` → `{ id, name }` — exactly one of collectionKey (library) or collectionId (local)
- `delete_variable_collection { collectionId, confirm:true }` → `{ deleted: 1, id }`

## Vectors & prototype

- `set_vector_network { nodeId, vectorNetwork }` — vector node only, replaces network wholesale
- `get_vector_geometry { nodeId }` → `{ fillGeometry, strokeGeometry, vectorPaths }` — read-only, null when absent
- `set_shape_props { nodeId, pointCount?, innerRadius?, arcData? }` — POLYGON: pointCount>=3 only; STAR: pointCount>=3 and/or innerRadius 0..1; ELLIPSE: arcData {startingAngle, endingAngle, innerRadius?} only
- `set_aspect_lock { nodeId, locked }` → `{ nodeId, locked }`
- `outline_stroke { nodeId }` — outlines strokes into a new vector, throws when the node has no strokes
- `create_text_path { nodeId, startSegment?, startPosition? }` — vector node only, returns `{ id }` of the text-path node
- `set_reactions { nodeId, reactions[] }` — replaces reactions wholesale
- `set_flow_starting_point { nodeId, name? }` — frame only

## Dev

- `edit_dev_resource { nodeId?, url, name?, newUrl? }` — updates matched URL only
- `delete_dev_resource { nodeId?, url }` — URL match only, no id needed

## App/storage/events

- `notify { text, timeout?, error? }` — toast (300 chars max, timeout 500-10000ms else default)
- `undo {}` — one undo step
- `client_storage { action: get|set, key, value? }` — plugin client storage (JSON-safe values)
- `node_data { nodeId, action: get|set, key, value?, shared?, namespace? }` — node plugin data (string values; `namespace` required when `shared:true`)
- `watch_document { on }` — opt-in `documentchange` events (log-only, no history; handler no-ops when off)
- `open_url { url }` → `{ opened:true }` — url must start with http:// or https://

Colors: hex strings (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, with or without `#`) or `{ r, g, b }` 0-1 (a numeric `.a` is honored; an explicit `opacity` argument wins over hex alpha). An invalid/malformed color throws (`invalid color: expected …`) rather than defaulting to gray; an absent color still uses the tool's gray default. Fonts load automatically (`Inter/Regular` fallback).
