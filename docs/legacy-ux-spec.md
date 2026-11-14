# Legacy FIESTA (Meteor) pixel-level UX specification

Extracted from the MagIC Meteor codebase; the reference for the React rebuild's UI-closeness work.

I now have everything needed. Here is the exhaustive pixel-level layout specification.

---

# MagIC Meteor App — Pixel-Level Layout Specification

## Sourcing notes / global constants (used everywhere below)

- Base font: `@fontName: 'Open Sans'`, `@emSize: 14px`, `@fontSize: 14px` → **1em = 14px** everywhere (`client/lib/semantic-ui/site/globals/site.variables:7,11-12`).
- Semantic "purple" class color = `@purple: rgb(121,47,145)` = **#792f91** (`site.variables`). But inline anchor links use **#800080** (`portals["MagIC"].rgb`, `lib/configs/portals.js:21`) and **#792f91** (`search.jsx:626`). The MagIC portal `color: 'purple'` (`portals.js:20`).
- Default Semantic segment (not overridden — `segment.variables`/`.overrides` are empty stubs): border `1px solid rgba(34,36,38,.15)`, `border-radius: .28571429rem` (~4px), box-shadow `0 1px 2px 0 rgba(34,36,38,.15)`.
- Default tabular menu border: `@tabularBorderColor: #d4d4d5`, `@tabularBorderWidth: 1px`.
- Global override (`site.overrides`): `.ui.tabular.menu .item.active` bottom border is overridden to **dashed** (`menu.overrides:5-7`). Circular basic labels forced white bg + 1px border of `@borderColor` (`site.overrides` `.ui.circular.basic.label`). Circular label `line-height: 0.7em`.

---

## 6. GLOBAL PAGE CHROME (do first — frames every screen)

`client/modules/common/components/layout.jsx` + `page.jsx` + `styles/layout.less` + `styles/page.less`

```
┌───────────────────────────────────────────────────────────────────────┐ ← top-menu: ui top FIXED secondary pointing menu, bg #F8F8F8
│ [☰]  Nav items (portal nav)                          [Log Out] [User ▾] │   right-menu also fixed, floated right
├───────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌────┐  Magnetics Information Consortium (MagIC)      ← page-title h1   │  layout-content: .ui.main.container
│  │ M  │  Promoting information technology ...          ← page-subtitle h4│  padding-top:4em; padding-bottom:4em
│  └────┘                                                                 │  page-logo floats LEFT
│  ─────────────────────────────────────────────  ← ui divider           │
│                                                                         │
│                      << PAGE BODY >>                                    │
│                                                                         │
├───────────────────────────────────────────────────────────────────────┤ ← footer: ui bottom FIXED small menu, bg #F8F8F8
│ Sponsored by NSF. Updated…   [✉ Having trouble? Email Us][Powered FIESTA]│   margin-top:-47px; segment pad 0.25em
└───────────────────────────────────────────────────────────────────────┘
```

CSS facts:
- **Container width**: content wrapper is `ui main layout-content container` (`layout.jsx:49`). `container` = standard Semantic `.ui.container` max-width (grid-driven, ~933–1127px stepped by breakpoint). If `fullWidth`, class becomes `full-width` with `padding-left/right: 2em` instead (`layout.less:46-49`). **FIESTA deviation (2026-09-25):** every page uses the `full-width` variant (header, node menu and content at `padding: 0 2em`); the fixed-width container is retired.
- **layout-content**: `padding-top: 4em !important; padding-bottom: 4em !important` (`layout.less:41-44`).
- **Top bar**: `ui top fixed secondary pointing menu top-menu`; `.top-menu, .footer { background:#F8F8F8 !important }` (`layout.less:19-21`). Secondary-pointing menu = borderless, no segment look, active item gets a pointing underline. Right menu: `width:auto; left:auto; right:0; border-bottom-color:transparent` (`layout.less:23-28`).
- **Footer**: `ui bottom fixed small menu footer`; inner `ui container` forced `width: calc(100% - 4em)` (`layout.jsx:117`). `#react-root > .layout.pushable > .footer { margin-top:-47px }` and its `.segment { padding-top:0.25em; padding-bottom:0.25em }` (`layout.less:63-71`). Footer buttons `ui button compact basic <color>` with `margin:0.5em 1em`. FIESTA logo img `height:1.75em; margin:-1.25em 0.5em -.5em` (`layout.jsx:142`).
- **page-logo** (`page.less:12-28`): a `ui menu basic button` rendered as a single capital letter. `display:inline-block; float:left; font-size:2.75em` (= 38.5px); `font-weight:bold; font-family:serif`; `height/min-height/line-height/width: 1.5em` (square ~57.75px box at that font-size); `margin: 0 0.25em 0 0; padding:0; text-align:center; vertical-align:middle`. Colored by portal class (purple).
- **page-title** (`page.less:1-5`): h1, `margin-top/bottom:0`; color `rgba(0,0,0,0.87)`. Default Semantic h1 ≈ 2rem (28px).
- **page-subtitle** (`page.less:7-10`): h4, `margin-top:0`; color `rgba(0,0,0,0.87)`. Default h4 ≈ 1.07rem.
- After logo/title: `ui divider` unless a `menu` prop supplied (`page.jsx:31`). Optional section header `<Header size='medium' dividing>` (`page.jsx:33`).
- Anchor color injected inline per portal: `a, a:hover { color:#800080 }` for MagIC (`page.jsx:16-20`).
- `#react-root` height 100%; `.layout.pushable` `overflow-y:scroll` (`layout.less:4-11`).
- **FIESTA deviation (2026-11-10): user menu.** Legacy shows `[Log Out] [User ▾]` side by side and the name links to the private workspace. Signed in, FIESTA's right menu is only the user's name with a caret; it opens a dropdown (right-aligned under the bar, the email on top) with Private Workspace (left out in data-source mode), Account (`/account`: name, email, handle, ORCID, password), Admin (node or super admins), Light/Dark Mode and Log Out. Escape or a click outside closes it; arrow keys move between entries. Signed out the bar is unchanged: the theme icon and Log In / Register.
- **FIESTA deviation (2026-11-12, user request): References and Users pages.** Legacy links these two portal-bar items to the separate ERR and ERML apps. Off the production hosts they open FIESTA pages (`fiesta/frontend/src/routes/portal-pages.tsx`, `/v2/portal/...`): at the portal in the multi-node layout (`localhost:8080/references`, `/users`, under the FIESTA header and with no node menu), under the node in a per-node build (`dev.earthref.org/MagIC/users`). Each is one sortable, searchable grid, 100 rows a page: a row per publication (citation, title, journal, year, DOI) or per contributor (name, handle, ORCID), a column per node with public contributions holding that row's count in the search page's white count pill (11px; the node's color is on its header), linked to the node's search for them (`doi:"…"` / `contributor:"…"`, which its sidebar shows as the Contribution DOI / Contributor filter), and the total, also a pill; text is 13px, headers as written (2026-11-13); sorted by total by default. The bar highlights the item while its page is open. Production hosts keep linking to ERR and ERML until the cutover.
- **FIESTA addition (2026-11-10): dark mode.** Legacy has none. A sun/moon icon item, first in the portal bar's right menu before Log In, toggles it; signed in, it is the Light/Dark Mode entry of the user menu (below). The choice is saved per browser (`localStorage["fiesta-theme"]`, shared by every node on the origin); without one the OS `prefers-color-scheme` applies. Light mode is the spec above, pixel for pixel. The hard-coded Semantic UI colors are theme tokens (`bg-surface`, `text-ink*`, `border-line`/`border-edge`, `bg-panel*`, `bg-bar`, CSS `var(--er-*)`; `fiesta/frontend/src/index.css`) whose light values are the legacy ones, and `html.dark` swaps them and mirrors the gray palette. Node colors used as text are lightened (`text-node-ink`, `inkColor()`). Plots (ECharts canvases, the plugins' SVG charts) take dark neutrals from the `--er-plot-*` tokens (axes, grid, nets, labels, tooltips, marker halos; the node color lightened like `text-node-ink`); light mode keeps the legacy plot colors and data series keep theirs. Corner glyphs on icon cards (the Search Interface magnifying glass) are outlined in the card's own background in dark mode rather than legacy white. The MagIC news icons are transparent PNGs (`configurations/magic/assets/`, white backgrounds removed; Mag-NetZ is now hosted there). **Deviation (2026-11-11, user decision):** the result rows' Download tiles and the footer's two buttons take the home icon cards' fill (`bg-panel-soft`, hover `bg-panel`) in both themes, instead of Semantic `basic` white with a node-soft hover. Map imagery is dimmed slightly (20% black, `MAP_DIM` in `fiesta/frontend/src/lib/theme.ts`): on MapLibre maps a `dim` background layer sits above the basemap and polar caps, below the labels and data; the result globe thumbnails darken their basemap pixels. Markers and labels stay at full brightness.

---

## 1. SEARCH PAGE (centerpiece)

`client/modules/magic/components/search.jsx`, `search_summaries_view.jsx`, `search_summaries_list_item.jsx` (+ `.less`)

### Overall nesting / wireframe

```
.magic-search
┌─ ui top attached tabular menu level-tabs ───────────────────────────────────────────┐
│ [Contribution (n)] [Locations (n)] [Sites (n)] … │           [ Private Workspace ]   │ ← right menu
└──────────────────────────────────────────────────────────────────────────────────────┘  (tabs join segment below)
┌─ ui bottom attached secondary segment (padding:0) ────────────────────────────────────┐
│  flex row (width:100%):                                                                │
│  ┌ ui labeled fluid action input (pad 1em, pad-bottom 0, flex:1) ─────┐ [⬇ Download   │
│  │ [🔍 Search MagIC][ input …………………… ][🔍 Search][⊘ Clear]           │  Results]     │
│  └────────────────────────────────────────────────────────────────────┘  (basic btn,  │
│                                                                            m:1em 1em 0 0)│
│  flex row  (marginTop:1em, height=state.height, width=state.width):                    │
│  ┌ SIDEBAR 275px ─────────────┐┌ RESULTS  flex:1 ─────────────────────────────────────┐│
│  │ ┌tabular small menu pad-L1em┐│ ┌ search-tab-menu: ui top attached tabular small menu ┐│
│  │ │ [Filters] … [Clear Filters]││ │ [Summaries(n)][Rows(n)]…      [Sort ▾ dropdown]     ││
│  │ └───────────────────────────┘│ └────────────────────────────────────────────────────┘│
│  │ ┌ filters segment ──────────┐│ ┌ view (borderLeft 1px #d4d4d5) ─────────────────────┐│
│  │ │ overflowY:scroll          ││ │ InfiniteScroller  overflowY:scroll bg white         ││
│  │ │  Publication Year  ▾      ││ │  padding:0 1em                                      ││
│  │ │  ──────────────           ││ │  ┌ search-summaries-list-item (accordion) ────────┐││
│  │ │  Author            ▾      ││ │  │ …result card…                                   │││
│  │ │  ──────────────           ││ │  └──────────────────────────────────────────────────┘││
│  │ └───────────────────────────┘│ └────────────────────────────────────────────────────┘│
│  └──────────────────────────────┘                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Layout / scrolling facts

- Root `div.magic-search` (`search.jsx:1281`).
- **Level tab bar**: `ui top attached tabular menu level-tabs` (`search.jsx:1283`). Each tab is `item`; active tab gets inline `backgroundColor:#F0F0F0` (`styles.activeTab`, `search.jsx:646`), inactive gets `cursor:pointer; color:#792f91` (`styles.a`, `search.jsx:626`). Each tab holds a count badge `ui circular small basic label` with inline `{color:#0C0C0C; margin:-1em -1em -1em 0.5em; minWidth:4em}` (`styles.countLabel`, `search.jsx:647-651`).
- **Private Workspace** sits in a `right menu` inside the same level-tab bar (`search.jsx:1315-1325`), item `paddingRight:0`; the button is `<color> ui compact button` (purple) with inline `paddingTop/Bottom:0.5em`, `to="/MagIC/private"`. Only shown when `user_id` cookie present.
- **Attached segment**: `ui bottom attached secondary segment`, inline `padding:0` (`styles.segment`, `search.jsx:644`; used at `:1329`). "secondary" = light grey bg; "bottom attached" = joined flush under the tab bar (no top radius, shares 1px border).
- **Search input row**: outer `div{display:flex; width:100%}` (`:1332`). The input group `ui labeled fluid action input` inline `{padding:1em; paddingBottom:0; flex:1}` (`styles.searchInput`, `search.jsx:652`). Left label `<color> ui label` = purple pill "🔍 Search MagIC". `<input class=prompt>` inline `{borderColor:#888888; borderLeft:none; borderRight:none; flex:1}` (`styles.input`, `search.jsx:632-637`). Two buttons `ui basic black button` ("🔍 Search", "⊘ Clear"); Clear has inline `marginLeft:-1px` (overlap borders) (`styles.searchButton`, `search.jsx:645`).
- **Download Results**: `<color> ui basic button` inline `margin:1em 1em 0 0` (`search.jsx:1396-1397`), sits to the right of the input group, hidden when searching a `private_key:`.
- **Results flex row** (`:1406-1414`): `display:flex; marginTop:1em; height:state.height||'100%'; width:state.width||'100%'`. Height is JS-computed = `window.height − 60(footer) − filters.offset().top + 20`; width = `window.width − filters.outerWidth − 2*filters.offset().left − 10` (`onWindowResize`, `search.jsx:775-793`). So the **page itself does not scroll for results — the sidebar and the results view each scroll independently** (`overflowY:scroll` on both).

### Filter sidebar

- Fixed **width: 275px** column: `div{display:flex; flexDirection:column; height:100%; width:'275px'}` (`search.jsx:1416-1422`). FIESTA: 220px since 2026-11-10 — the sidebar only lists the filters and their applied values (the controls are in modals), and 220px still fits the Filters tab and the Clear Filters button.
- **Header bar**: `ui top attached tabular small menu` inline `paddingLeft:1em` (`:1426`). Active `item` "Filters" with `styles.activeTab` (#F0F0F0). Right side `right aligned item` `padding:0 1em` holding a Clear-Filters button: `ui small compact button` + (`<color>` when active else `basic disabled`), inline `padding:0.5em`, icon `remove circle` (`:1432-1448`).
- **Filters scroll area**: `ui small basic attached segment` with inline `styles.filters` = `{whiteSpace:nowrap; overflowY:scroll; border:none; flex:1; margin:0; width:100%; padding:0}` (`search.jsx:653-661`, used `:1454`).
- **Each filter block**: inline `styles.filter` = `{padding:0.25em 1em 0.5em; borderBottom:1px solid #D4D4D5}` (`search.jsx:662-665`). So each accordion section is separated by a 1px `#D4D4D5` divider.
- **Accordion title row**: `ui small accordion` → `div.title` `paddingBottom:0`; inner clickable row `styles.flex` = `{display:flex; marginBottom:0.25em}` (`search.jsx:628`). Caret `i.dropdown icon` on the LEFT, then label `div` with `styles.flexGrow` (`{flexGrow:1; marginRight:0.5em; whiteSpace:normal}`) + `styles.b` (`{fontWeight:bold}`) (`search.jsx:629, 630`). Title font is default small accordion size (~1em). Content `styles.content` = `{padding:0 0 0.25em}`.
- **Numeric range filters** (Pub Year/Geospatial/Age/Intensity): `ui small labeled input` flex rows; sub-inputs `ui input` with `flexShrink:1; minWidth:20`; joined labels have squared corners (`borderRadius:0`) e.g. "to", "deg", unit dropdowns. Age unit label has `borderLeft:1px solid #dddede` (`:1866`).
- **Buckets/checkbox filters** rendered via `SearchFiltersBuckets` (imported `:8`); count badges are Semantic circular basic labels (white bg, 1px border, `line-height:0.7em`) per `site.overrides`.
- **KdD periodic table** (`KDD/client/modules/kdd/components/search.jsx:74`, `renderModalPeriodicTableFilter` `:1129-1248`; layout `KDD/lib/configs/kdd/elements.js`): an accordion title "Periodic Table of Elements" opens a `ui modal` (`min-width: min(90vw, 940px)`, content `min-height: 50vh`) of 10 rows × 18 columns placed by each element's `xpos`/`ypos`; each cell a `ui button` 3rem × 4.5rem showing the symbol over a `bottom attached mini basic label` count (a terms aggregation of `summary.kds._element_name.raw`, size 10000, under the query and the other filters), `disabled` at 0, the node colour when picked; a click toggles the element at once (OR across elements); picked elements are listed under the title with checked checkboxes and circular count labels; actions Clear and Close. FIESTA: the `periodic-table` plugin (2026-11-11). Parity: the same grid, counts, disabled and node-coloured cells, OR semantics and listed picks (chips with counts, as every FIESTA filter). Deviations: the modal edits a draft applied with **Apply** (Clear / Cancel / Apply, as every FIESTA filter modal since 2026-11-10) instead of searching on every click; the counts are on the column's own values (`element`, which holds symbols) instead of a derived `_element_name`, and match names too; the modal is FIESTA's `xl` width (64rem) and scrolls sideways under 44rem.

### Results sub-tab bar + sort (`renderTabs`, `search.jsx:3121-3221`)

- `ui top attached tabular small menu search-tab-menu` (`:3128`). Each view = `item`; active none-styled, inactive `styles.a` (purple, pointer). Count badge same `ui circular small basic label` + `countLabel` inline.
- **Each view's count** (`search_levels.js`): Summaries counts the matching docs (records), Rows sums their `summary.<level>._n_results` (rows), Poles counts the locations with a pole. The rebuild matches: Summaries = records, Rows = `rows_total`, Map = records with a position, and a plugin view its own docs (`countTable`: poles, rock-magnetic results). Switching views never changes the level tabs' counts; only the area filter does.
- **Sort dropdown** in a `right aligned item` `padding:0 1em` (`:3181`): `<color> ui dropdown label` (purple pill) inline `padding:0.5em`, text = current sort, `i.dropdown icon`, menu of `sortOptions`. (A hidden "Custom View" item exists with `display:none`, `:3169-3180`.)
- **View container** (`renderView`, `:3223-3230`): inline `borderLeft:1px solid #d4d4d5`; height = `state.height − tabs.outerHeight()`; width = `state.width`.
- **Scroller** (`search_summaries_view.jsx:12`): `{overflowY:scroll; background:white; padding:0 1em; borderRadius:0; boxShadow:none}`. Default pageSize 5.

### Measured metrics (pixel pass 2026-09-10, 1400×900, vs magic.earthref.org)

Computed styles read off the live legacy page with a headless browser; the
rebuild reproduces these exactly (see `fiesta/frontend/src/routes/search.tsx`,
`components/result-item.tsx`, `portal-bar.tsx`, `node-menu.tsx`, `footer.tsx`):

- **Font**: Open Sans 400/700 loaded from Google Fonts with Semantic's own
  `@importGoogleFonts` URL (`index.html`); body `line-height 1.4285em`, text
  `rgba(0,0,0,.87)`. Without the webfont every width differs by 5–15%.
- **Top bar**: 40px, `#F8F8F8`, 2px bottom border `rgba(34,36,38,.15)`; items
  14px/400, padding `.857em 1.143em`, line-height 1em, sidebar (hamburger) item
  first (53.5px), the first portal item has no left padding; active portal =
  node color + 2px node-colored bottom border (not bold). **FIESTA deviation
  (2026-09-27):** the hamburger shows only below 1024px, where the portal list
  collapses into the drawer; wide screens start with EarthRef.org at the normal
  item padding.
- **Header**: logo 57.75px square (1px segment border + 1px inset node shadow),
  h1 28px/36px, h4 15px **bold**/19.29px. The node menu is a flex BFC placed
  after the subtitle (top = subtitle bottom + .25em = 114.5px), *not* cleared
  below the floated logo; `main` clears.
- **Node menu**: `ui secondary small pointing menu` — 13px, min-height 2.857em,
  margin `.25em 0 1.25em`, items padding `.5em 1em`, line-height 1em, 28px tall,
  aligned to the bottom edge (`margin-bottom:-2px` over the 2px border); icons
  1.18em wide, margin-right .357em.
- **Search shell**: bottom attached segment is `#F0F0F0` (not #f3f4f5), text
  `rgba(0,0,0,.6)`, border `rgba(34,36,38,.15)`. Tabular items: padding
  `.92857143em 1.42857143em` at 14px (level tabs) and 13px (small menus);
  the 14px active item is 1px taller (43px bar); every active item has a **1px
  dashed #d4d4d5 bottom border**. Count pills: 11px bold, `line-height .7em`,
  padding .5em, min-width 4em, min-height 2em (22px), margin `-1em -1em -1em .5em`.
  FIESTA (2026-11-12, a deliberate deviation): **no text on the search page or
  in its filter modals is smaller than the results' 13px** — the sort pill,
  the Rows grid's headers and cells, chips, hints, the time scale, the map
  legend and Labels control, buttons, and the plugin views and thumbnails
  shown there — **except the count pills**, which stay 11px: the tabs' and
  sidebar's white pills, the modals' value counts and the node-colored
  "applied" badges. The sidebar's filters show their count in the tabs' white
  pill (min-width 3em, in the flow) and no filter icon. Charts' canvas text
  (axis labels) keeps ECharts' sizes.
- **Buttons**: `ui basic` buttons are weight 400 with a 1px inset box-shadow (no
  border), padding `.78571429em 1.5em`, line-height 1em, disabled opacity .45;
  icons 1em with margin `0 .43em 0 -.21em`. Search input 14px, padding
  `.678em 1em`, line-height 1.214em (38px tall); label icon margin-right .75em.
  Clear Filters: 13px, padding .5em, margin `-.5em 0` (26px pill in a 38px bar).
  Sort: 12px bold pill, padding .5em, line-height 1em (24px), caret .857em
  (FIESTA: 13px, see the count pills above).
- **Results row**: width = segment width − 10px; height = window − 79px − row top
  (legacy: `window − 60 − filtersSegment.top + 20`). Scroller padding `0 1em`,
  list margin `1em 0`, fitted dividers `.5em 0 1em`.
- **Card**: line-height 16px, `rgba(0,0,0,.87)`; the trigger row is 3.5px above
  the card box and 1em wider (padding `0 1em .5em`); caret box 1.25em at
  (−4.2px, +0.8px); cells row also 1em wider; download cell 14px/104px tall with
  a 42px block icon, 14px bold label, line-height 18px; map cell 14px; plot slot
  is a 98px content box with a 1px `rgba(0,0,0,.1)` border ("No Plots
  Available"); links cell line-height 1.4285em; other cells 13px with 1em
  (13px) right margins and 5px bottom margins; cell labels sit on 1.4285em
  lines above 16px clamped values.
- **Footer**: fixed, 13px, min-height 2.857em, 1px top border + `0 1px 2px`
  shadow; container margin `0 2em`; text segments 14px, padding `.25em 0`;
  the two `compact basic` buttons (14px/400, padding `.589em 1.125em`, margin
  `.5em 1em`) sit between the left/right blocks' auto margins.

### Deliberate deviations (search page, FIESTA rebuild)

- **Footer**: legacy renders a broken 16px `FIESTA.png` in "Powered by FIESTA";
  FIESTA shows the real logo at 1.75em. Legacy also prints "Updated on <deploy
  date>"; FIESTA has no deploy-date source yet.
- **Portal bar** lists the FIESTA nodes (KdD, CDR, KArAr, OSU-MGR) that the
  legacy bar lacks, styled identically.

- **Sort options** are the legacy list, served by `GET /v2/{node}/search/{table}?sort=…`. Legacy "Largest ID First" sorted `summary.contribution.id` *ascending* (`search.jsx:115`, a bug); FIESTA sorts it descending so the label is true. "Recently Published" and "Most Cited" sort on `_reference.year` / `_reference.n_citations`, which are empty until reference enrichment (ROADMAP C6) lands — they fall back to newest first.
- **Page size** is 10 (legacy 5) with the same infinite-scroll behaviour; a "Load More" button remains as the no-IntersectionObserver fallback.
- **Card header fallback** is "Contribution {id}" instead of legacy "Unknown" when a hit has no `_reference.citation` (no Crossref enrichment yet).
- **Download Results** downloads the top contribution file (no bulk-zip endpoint yet, ROADMAP); legacy zipped every matching contribution.
- **Level tabs** omit legacy "Experiments" until the derived experiment docs exist (ROADMAP C4).
- **Filter sidebar** renders the YAML `search.filters` (facet buckets, numeric ranges, a lat/lon box), each limited to the levels and result views it names; MagIC shows the buckets on Summaries/Rows and Age / Pole A95 / Geospatial on the Locations level's Poles view. The legacy Publication Year / Age / Intensity ranges are ported (2026-11-10) as range filters on every level's Summaries/Rows/Map views over the indexed numbers (`summary._num.<column>`, ages in years BP whatever their `age_unit`; `summary.contribution._reference.year`): Publication Year on every level, and Age (Ma, with the time scale) on Contributions, Locations and Sites. New in FIESTA, every other number column of the level is a range filter of its own (the `numeric` filter; the data model's label and unit; not the position columns lat/lon/lat_s/lat_n/lon_w/lon_e, which are the Geospatial filter's, 2026-11-13), and every other text column a facet (the `text` filter, 2026-11-12; on a record also the geography it inherits, a site's Location Type). Deviation (2026-11-13): with those and the sidebar's filter search on every node, the per-column facets and ranges the legacy sidebars listed (MagIC's method codes, geology and plate facets, its Paleointensity, VADM, Declination, … ranges with their display units; CDR's cruise, vessel, PI facets; ERDA's, OSU-MGR's, SC's, KArAr's) are gone: each column is still a filter, under its data-model label and in its data-model unit (Paleointensity in T, not μT). Only filters no single column gives stay configured: Geospatial, Publication Year, Age, With / Without Data, the contribution filters, and the plugin views' own (Poles: Age, Pole A95, Geospatial; Rock Magnetism: its parameter ranges, area and sample facets). The legacy age-unit drop-down is a fixed unit (Ma) instead. The legacy "With … Data" / "Without … Data" pairs (Contributions: Any Table + each table; Locations: Locations only; `search.jsx` `renderWithDataFilter`) are ported (2026-11-10) as ONE `exists` entry, "With / Without Data", whose modal has a tab per table and a With / Without switch, each tab listing the table's data-model columns in position order (no `downloadOnly()` ones) with the count of records with (or without) data in each and the legacy hover text ("N sites have data in the X column of the Sites table and match your search and other filters"), findable by name, label or description, sortable, Selected only; applied columns are chips ("With Sites: int_abs", "Without Samples: azimuth"). Same semantics as legacy (a table and sense's columns OR'd, separate ones AND). Deviation: every level gets the filter, with Any Table, its own table and the levels below it (a location's sites, samples, …: the index passes columns up to the records named), not just Locations; Contributions keeps every table (criteria, ages, images included). Every node also has Contribution ID, Contribution DOI (the reference DOI, the References grid's links) and Contributor (facets on the contribution block's `id`, `_reference.doi` and `_contributor`) and Contributed On (a date range on `summary.contribution.timestamp`: typed in date boxes, binned and shown as days, no log scale) (2026-11-13, new in FIESTA). Facet titles default to the singular of the column name ("Method Code"), matching legacy titles, or the filter's `label`.
  Filter modals (2026-11-10, a deliberate deviation from legacy's accordions): the sidebar lists the filters, each with its applied values as removable chips and a badge counting them (since 2026-11-12 also a count of the search's matches with a value for it, the most records it can match: a position, any number column, any recorded table, the facet's column, the range's field; `/search/{table}/filters`, one request per table counted; disabled at zero unless it has applied values), and choosing one opens its modal, which edits a draft applied with Apply (Clear, Cancel). A facet's modal lists every value (`facet_size`) with its count for the search without the facet's own values (values of one facet are OR'd, so a count is what picking it adds), a Find box over values and descriptions, a Most records / A–Z sort and "Selected only"; values that are the node's method codes show their definitions, grouped as on the Method Codes page. A range's modal draws the search's distribution of the field (`/search/{table}/histogram`, without the field's own range) in linear or log bins, where dragging or clicking selects whole bins and the min/max boxes take exact bounds; the bin count is Auto by default (since 2026-11-12: the API's 2·n^⅓ for n values, 10–100) or one of 10–200. An age range (`timescale: true`) also has the geologic time scale under its histogram (click a unit for its range) and, after the min/max boxes, a "Named age range" box to type a unit's name in and pick it from the matches. Since 2026-11-12 (later the same day as a tabbed modal, replaced): the sidebar has a "Find a filter" box over its filters (Enter opens the first match), lists applied filters first and then the most records with a value, and hides a filter no record of the search has a value for (unless it is applied). The `numeric` filter is one entry per number column of the level (its range modal, no column picker), and the `text` filter one facet per text column (data-model String and List columns, named by their data-model label) that no configured facet has; "With / Without Data" is two entries, With Data and Without Data, each its sense's modal. Modal titles are the size of the level tabs (1rem bold). The Geospatial modal has the search's map (the Map tab's, with the area's draggable outline, drawn on opening when there is none, and "Filter by area" to draw one again once removed) and the area's bounds as numbers; a bbox filter (Poles) uses the same modal, and on such a view the level's area entry shows only while an area is set.
- **Summaries are a grid** (2026-09-30), not the legacy card list: one row
  per record, one column per tile (the card's cells, unchanged: download,
  links, counts, map and plot thumbnails, geo, geology, age, intensity, method
  codes, citations; the card header's citation, title or name breadcrumb and
  date/contributor are stacked in the first column, "Contribution" on the
  Contributions level and the level's record ("Site") elsewhere, whose filter
  matches any of them; since 2026-11-12 a contribution shows its citation
  over up to 4 lines of the reference title (3 when the date and contributor
  wrap onto a second line), and a lower level's record its
  name top-left with "{citation} ⇒ {location}" (not bold) bottom-right above
  the date and contributor), each row capped at 105px, its columns 1em apart
  (2em before 2026-11-12). A sticky header
  names the columns; a sortable column sorts the search on a click (ascending,
  descending, back to the dropdown's order; the dropdown shows the header sort
  while it applies), a filterable one has a filter icon after its label (as on
  osu-mgr.org's result tables, 2026-11-09): a badge counts its applied filters,
  and a click opens the column's filter modal (2026-11-10; a drop-down menu
  before) — the sidebar's facet modal over the column's facet lists (a tab per
  list, the same `<column>:"<value>"` tokens as the sidebar, counted over the
  level's records), a "Contains" text box for a column without facets (`filter=<column>:<text>`, which also narrows the Rows
  and Map views and is cleared by switching levels), and on the map tile the
  Geospatial area. Clear Filters clears them all. Columns, headers, widths, sorting and filtering are set
  per level in the node YAML (`search.levels[].columns`) and the admin Summary
  Grid tab; a level without them shows the default tiles. Deviation
  (2026-11-13): the legacy card gave every level of every node the same cells,
  most of them always "No … Data" below Contributions and on the non-MagIC
  nodes (Counts is always "1 Measurement" on a measurement). Each node's YAML
  now names its levels' tiles: records drop Counts and the tiles their table
  has no columns for, and gain `fields` tiles of their own results (MagIC
  Sites: Direction and VGP; Measurements: Treatment, Result, Conditions; CDR:
  cruise, coring, depth and track data; KdD: elements, phases, Kd ranges;
  KArAr: irradiation, experiment, step and intercept columns, its Geology on
  its lithology/material columns); Contributions keep the legacy cells on
  MagIC, and elsewhere show what the contribution holds (values) and spans
  (ranges). The expand caret is
  gone (the modal below replaced it); a count ("2 Locations") opens the
  contribution's modal at that level's tab. The home page's recent
  contributions and the private workspace's contribution use the same grid
  without sort/filter controls; the portal home shows each node's row without
  a header. On the search page (2026-11-10) the grid scrolls virtually (only the
  rows in view and 10 above and below are in the DOM, rows measured as they
  render). The scrollbar spans every match (up to OpenSearch's 10,000-result
  window, with a note under the grid past it): the legacy Load More and
  infinite scroll are gone, and the pages of 20 under the view are fetched
  once scrolling settles, placeholder rows standing in until they arrive. A
  click anywhere on a row outside its links and buttons
  (or Enter on a focused row) highlights it and opens its contribution's modal
  at that level's tab.
- **Rows grids** (2026-11-10), on the search page's Rows view and the modal's
  level tabs, scroll virtually the same way (25 records above and below the
  view; the modal's scrollbar spans the whole table, no window), with fixed
  column widths set from the first rows, and their headers sort (ascending,
  descending, back). Both sorts are
  server-side: on the search page `sort=rows.<column>:…` orders every matching
  record by its rows' values (a record's rows stay together, ordered within);
  in the modal the API sorts the contribution's whole table. The modal's rows
  come from the file (`/contributions/{id}/tables/{table}`) with their row
  numbers, and cells with validation issues take the online editor's colors
  (errors red, warnings amber, the messages as a tooltip; a whole-row issue
  tints the row), and a level tab counts its rows with errors (`bg-danger`,
  the workspace's dark red) and warnings (yellow). Both are for the
  contributor (2026-11-13): a deployment shows them only on a private
  (unactivated) contribution; a local stack (localhost) shows them on every
  contribution.
  Both run edge to edge of their view (the cells carry the padding, as on
  Summaries) under a three-row sticky header per column: its name (the data
  model's label, sorting), field (the column in the file) and type ("Number
  in Degrees", as the Data Models page writes it), from the node's latest
  data model; a column the model lacks is named by its field. A click on a
  search Rows row (or Enter on a focused one) highlights it and opens its
  contribution's modal at that level's tab with the row selected: the API
  finds the row in the file (`/tables/{table}/locate`), the modal scrolls it
  to the middle of the view (its page fetched there), and `?row=<n>` keeps
  the selection in the link. A click on a modal row selects it.
- **Contribution modal** (2026-09-27) replaces the legacy expand caret, the
  map and plot modals and the contribution page, after osu-mgr.org's record
  modal: clicking a card's header, its map thumbnail or a plot (the plateau
  age spectrum) opens one modal on the search page (`?contribution=<id>&tab=`;
  `/<id>` and `/contributions/<id>` redirect there, keeping `private_key`).
  Header: node key + id + version, citation and title, Copy Link (the `/<id>`
  link), Download, close (Esc, backdrop). Tabs down the left (a select on
  narrow screens) with counts, empty ones hidden (2026-11-12: while counts
  load, one "Loading…" row with a spinner stands in for the tabs they decide,
  and a group's counted tabs appear together once its counts are all known,
  so no tab shows and then vanishes): **Records** — Contribution
  (reference, links and DOIs, revision history, the contribution row's values),
  then each search level's rows in it (100 at a time); **Assets** — Map (a
  MapLibre globe of one level's records, labelled with their names, levels
  switchable; opens on the level with the most records), then plugin tabs
  (Poles, Depth Plots, Age Plots). Since 2026-11-11 the modal spans the
  view, inside the margin it keeps above and below (2rem; 0.5rem on a phone).
  The PmagPy plot tabs (Equal Area, Zijderveld, …) draw the selected plot
  large and interactive, the first by default, over or beside half-size cards
  of the level's other plots (beside when that leaves the cards the larger
  view, the full width under the plot against two-fifths of it at full
  height), each card picking its plot with a click and the selected one
  outlined in the node color; a search grid's Plot tile opens the tab with its plot
  selected (`&plot=`), so the legacy thumbnail's "open this plot" is one click.
- **Map thumbnail** uses the doc's own `_geo_point` on level cards (inherited from the nearest ancestor with coordinates when the row has none) and every distinct position of its rows on contribution cards, rather than the legacy summary's points and envelopes.
- **Map thumbnail** is drawn from the Esri Ocean basemap (the Map tab's, as on osu-mgr.org) instead of the legacy SVG globe of 110m countries coloured by a climate lookup (2026-09-27).
- **CDR depth thumbnail** (`depth-plot`; legacy `CDR/client/modules/cdr/components/search_summaries_list_item.jsx` `renderDepthPlots`): the Plot tile after the map on Contributions and Cores cards, one panel per series with values, depth increasing downward, no ticks, negative (calibration) depths left out; a click opens the modal's Depth Plots tab; "No **Depth Plots**" when nothing plots. **Deviation (2026-11-13):** a Cores card draws only its own core's tracks (legacy drew the whole contribution's on every card), and each series is thinned to 300 points for the 100 px tile.
- **KArAr age plots** (`plateau-calculations`; legacy `KArAr/lib/modules/karar/plateau_calculations.js`, `search_summaries_list_item.jsx`). **Deviation (2026-11-12, user decision):** legacy recomputed every step age from the isotope ratios with an assumed J of 1e-3 and searched for its own plateau (lowest MSWD, ≥ 3 steps, ≥ 50% ³⁹Ar, MSWD ≤ 2.5), so its spectra disagreed with the published ages. FIESTA draws only contributed values: step ages from `measurements.age`, the plateau from the experiment's Plateau row (its `age_steps` highlighted, the band and line at its age ± σ, caption MSWD and ³⁹Ar width), the steps sized by the first ³⁹Ar column every step fills. Additions: normal and inverse isochrons (the corrected isochron ratios as 1σ error ellipses, the line through the isochron row's `40ar_39ar_ratio` and `40ar_36ar_ratio` intercepts, steps not in its `age_steps` hollow); a specimen view (its `age_experiments`' spectra in the categorical palette under the preferred age, dashed) on the Specimens tile and in the modal; and every contributed age in a table per experiment. Since 2026-11-12 (user decision) the plots are two modal asset tabs, "Specimen Age Plots" (`specimen-age-plots`) and "Experiment Age Plots" (`experiment-age-plots`), laid out as MagIC's plot tabs: the selected plot large, the rest as cards to pick from (they replaced one "Age Plots" tab, `age-spectra`, grouped by specimen). Further additions (2026-11-13, user request): K/Ca, ⁴⁰Ar* and ³⁸Ar(Cl)/³⁹Ar(K) spectra under the age spectrum and a ³⁹Ar release curve per experiment; ranked experiment ages and an ideogram per specimen; a third tab, "Contribution Age Plots" (`contribution-age-plots`), with the specimens' ages as a histogram and ideogram, age against sample elevation, stratigraphic height and depth, and J against irradiation position; and an "Age Distribution" sub-tab on the Specimens search level. None of these existed in legacy KArAr. Whatever is missing, such as intercepts, ratios or listed steps, is said in the caption rather than calculated.
- **Lunar records** (2026-09-30, new in FIESTA; legacy drew them on Earth): a location whose `location_type` is Lunar (the node YAML's `search.bodies`), and everything below it, is positioned on the Moon. Its thumbnail is a Moon (LROC WAC) globe; the Map tab shows **Earth / Moon** buttons before the view buttons on a node with `search.bodies` (the contribution modal's Map when its records include another body), opening on the body with the most records, over OpenPlanetaryMap's lunar basemap and names (the Labels button toggles them; not drawn in the pole views). The area filter is on Earth: "Filter by area" is hidden on the Moon, whose records an area leaves out (shown in grey). Martian records stay on Earth (2026-11-10): MagIC's and KArAr's are meteorites, positioned where they were found, so there is no Mars map.
- **Map tab** (new, 2026-09-27): levels whose data-model table has lat/lon columns get a Map sub-tab after Rows, ported from osu-mgr.org's search map — MapLibre over Esri Ocean in four views (Globe, Mercator, North Pole, South Pole), every matching record plotted, and an area filter (the `area` search param) that also narrows Summaries and Rows. Legacy had no equivalent.
  Color by (2026-09-28, new in FIESTA): a "Color by" menu beside the view buttons colors the markers by one of the node's `search.map_colors` offered at the level (MagIC: publication year, age, paleointensity, VADM, inclination, VGP latitude, magnetic moment, mass susceptibility), yellow → red → purple between the values' 2nd and 98th percentiles (log10 for a `log` field), records without a value in grey and drawn underneath; a legend at the bottom left gives the ends and "No value"; tooltips add the value (a location's mean). "None" is the node color. The choice is remembered in the browser, like the view.
  A large search (over 10,000 records at a level of points) maps its unique locations per contribution with a record count each (tooltips "9 sites, at one location in contribution 101"), from an OpenSearch aggregation, instead of stopping at 50,000 records.
  Toggle counts (2026-10-01): the mapped records are counted in the toggles instead of a "N mapped Sites" line — each body button its records ("Moon (53)"), and for the body shown Globe all of them, Mercator those within ±85.05°, North / South Pole those in that hemisphere (a record on the equator in both). A toggle with none shows no count and is disabled, its tooltip "No mapped sites on the Moon" plus, for a filtered search (query, ranges, column filters or area), "match this search; clear its filters to see more". Only a truncated map keeps a line ("The first of 412,000 mapped sites").
  Geospatial filter (2026-09-28): the area narrows every level with positions and each level tab's count, and stays across level tabs. The sidebar's **Geospatial** entry (and the map tile's header filter) opens the Geospatial modal (2026-11-10; before, a checkbox that switched to the Map tab): the search's map at the current level, which on opening without an area draws one around the search's records (or over the view when unfiltered, as on osu-mgr.org), and its bounds as numbers; once removed ("Remove area" on the map, or Clear), "Filter by area" on the modal's map draws a new one the same way (since 2026-11-13 the Map tab only shows the search, an area included: no outline, no Filter by area / Remove area, no grey records outside it); with an area the entry shows its latitude/longitude extent as a chip that removes it. The "Only … inside the area" notices on Summaries/Rows were dropped.
  Synced with osu-mgr.org's map again on 2026-09-27: labels are vector (OpenStreetMap place, water and boundary names from OpenFreeMap's Positron layers, plus GEBCO undersea feature names from `/v2/basemap/undersea-features`) instead of Esri's raster reference tiles; the area on a filtered search starts as the smallest area around its records (across the antimeridian when that is smaller), on an unfiltered one over the middle of the view; the area is moved by dragging its outline (corner handles resize); records outside it are dark grey.

### RESULT ITEM CARD (`search_summaries_list_item.jsx`) — most detailed

```
.search-summaries-list-item  (ui accordion; text-align:left)
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ▾  Citation, v.N    Title ⇒ Location ⇒ Site …                 Jul 7, 2026 by Contributor│ ← header row
│    (small,bold)     (small, ellipsis, flex:1)                 (small, right aligned)     │
│                                                                                          │
│ [Download ][ Links      ][Counts ][Map ][Plot][Geo ][Geol][Age ][Int][Method][Cites]   │ ← flex data row
│  100px      200px         135px    100  thumb 125   125   120   75   125     125         │   (max-h 105px collapsed)
└──────────────────────────────────────────────────────────────────────────────────────┘
       ┌ grey icon button (caret ▼) 10em wide, appears on hover, straddles bottom edge ┐
```

- Root: `ui accordion search-summaries-list-item` (+` active` when expanded) (`:690-693`). `.search-summaries-list-item { text-align:left }` (`less:1-3`).
- Title wrapper `div.title` inline `padding:0 0 0 1em` (`:720`). Caret `i.dropdown icon` inline `{position:relative; left:-1.3rem; top:-.2rem}` (`:722-725`). Inner `ui grid` inline `{marginTop:-1.5rem; marginBottom:-.5em}`.
- **Header/citation row**: `div.row.accordion-trigger` inline `{display:flex; padding:0 1em 0.5em}` (`:731-732`), `cursor:pointer` (`less:19-21`).
  - Citation span: `fontSize:small; fontWeight:bold`; color `#9F3A38` if unactivated+dev else default (`:734-743`). Adds ` v.N`.
  - Title span: `fontSize:small; flex:1; height:1.25em; overflow:hidden; textOverflow:ellipsis; margin:0 0.5em` (`:755-767`). `renderTitle` produces `location ⇒ site ⇒ …` with the last level bolded (`:72-103`).
  - Date/contributor span `.description`: `fontSize:small; float:right; textAlign:right`; `moment(...).format("LL")` + " by **contributor**" (`:771-789`).
- **Flex data row**: `div.row.flex_row` inline `{padding:0; fontWeight:normal; whiteSpace:nowrap; display:flex}` (`:792-800`). Collapsed height cap via CSS: `.title:not(.active) .flex_row { max-height:105px; overflow:hidden }` (Poles view variant `155px`) (`less:5-13`).

  **Ordered cells with exact widths** (each cell also `marginRight:1em; marginBottom:5px`, values `fontSize:small`):
  | # | Cell | minWidth=maxWidth | Notes / source |
  |---|------|------|------|
  | 1 | Download | **100px** | button `ui basic tiny fluid compact icon header purple button`, inline `padding:20px 0; height:100px` (`:122-140,145-147,184`) |
  | 2 | Links | **200px** | `fontSize:small; overflow:hidden; textOverflow:ellipsis`; bold labels + `<p>` links (`:198`) |
  | 3 | Counts | **135px** | `fontSize:small; lineHeight:1`; a `<table>` of count/label rows, right-aligned counts (`:255-256`) |
  | 4 | Map thumbnail | **100px** | `a.ui.tiny.image` → `SVGMapThumbnail width=100 height=100`; placeholder if none (`:385,399`) |
  | 5 | Plot thumbnail | (component `SearchPlotThumbnail`) | `:805-847` |
  | 6 | Geo (geographic) | **125px** | `whiteSpace:normal`; bold "Geologic:"/"Geographic:" + Clamp (`:596`) |
  | 7 | Geology (class/type/lith) | **125px** | `:625` |
  | 8 | Age | **120px** | bold "Age:" + range (`:448`) |
  | 9 | Intensity | **75px** | `:481` |
  | 10 | Method Codes | **125px** | `:651` |
  | 11 | Citations | **125px** | `:669` |

  (For the "Queued for Indexing" variant the row is only Download+Links+Counts+`renderQueuedForIndex` 200px, color `#AAAAAA`, `:311-317, 865-869`.)
- **Cell label vs value typography**: labels are `<b>` inline bold (default small); values plain `fontSize:small`. Truncation via `Clamp lines={n}` component.
- **"No X Data" placeholder** style (repeated, e.g. `:399, 412, 460, 530, 609, 643, 658, 676`): same width box, `fontSize:small; color:#AAAAAA; textAlign:center; overflow:hidden; textOverflow:ellipsis`, content `<br/>No<br/><b>Label</b><br/>Data<br/><br/>`.
- **Expanded content**: `div.content` inline `{fontSize:small; paddingBottom:0}` (`:873-878`). Contains reference HTML, abstract (`marginTop:0.5em`), keywords/tags, Crossref count, and a **history table** `ui very basic compact collapsing table` with headers Download/MagIC Link/DOI/Version/Data Model/Date/Contributor (`:967-988`). In dev, an extra `ui compact red table` of developer tasks (`:1169`).
- **Open/close caret buttons** (`:1327-1348`): two `ui grey icon button accordion-button` (down caret / up caret). CSS `.accordion-button { display:none; width:10em; height:1.5em; padding:0.25em; position:relative; margin:1em auto -2.5em; z-index:1; border-top-left-radius:0; border-top-right-radius:0 }` (`less:23-33`) — a flat-topped grey tab centered, pulled up over the card bottom via negative margin. Shown/hidden on `mouseOver`/`mouseLeave` with 500ms timeouts, toggling which arrow shows based on active state (`:694-712`).

---

## 2. DATA MODEL BROWSER

`client/modules/magic/components/data_model.jsx`, `data_model_column.jsx`, `styles/data_model.less`

```
.data-model
┌ ui top attached tabular menu ─────────────────────────────────────────────────┐
│ [Version:] [3.0 (n)] [2.5] [2.4] …            [right menu: 🔍 Search columns…]  │
└────────────────────────────────────────────────────────────────────────────────┘
┌ ui bottom attached segment (min-height 200px) ────────────────────────────────┐
│  [6-wide: Click on a table/group/column name:] [4-wide: Updated on …] [6-wide R:│
│   ↓ ui inverted active dimmer "Loading"                     json | Google Sheet]│
│  ┌ ui styled fluid accordion (bordered rounded box, mt 1em, no shadow) ───────┐│
│  │ ▾ 1. Locations, locations            (n)  description……………………………           ││ table title
│  │ ├───────────────────────────────────────────────────────────────           ││
│  │ │ ▾ Geographic Group                 (n)                                    ││ group title (bg #aaa)
│  │ │   ▾ 1.3 Latitude, lat  [Number]  desc  [Required][Vocabulary]…            ││ column title
│  │ │     └ content: ui very basic small compact table (Description/Type/…)     ││
│  └────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Version tab bar**: `ui top attached tabular menu` (`:245`). First item `disabled item` "**Version:**". Each version a `Link` `item` (active gets `active` class). Active version carries a `ui circular small basic floating label data-model-count` (`:253-256`). Right side `right menu` → `active item` → `ui search` → `ui transparent icon input` with prompt input (min-width 200px, `border-radius:0`; `data_model.less:10-13`) and a close/search icon (purple).
- **Bottom segment**: `ui bottom attached segment`, `min-height:200px` (`less:1-3`); holds a `ui inverted active dimmer` loader.
- Header grid: `ui grid` with `six wide column` + `four wide column` + `right aligned six wide column` (`:287-307`). The "not published" note styled `color:#912d2b` (`:298`).
- **Accordion**: `ui styled fluid accordion` = bordered, rounded, 1px-separated rows. Overridden: `margin-top:1em !important; box-shadow:none !important` (`less:19-22`). Title rows `padding:0.5em 0; display:flex` (`less:24-27`).
- **Title row layout** (`:313-324`): `i.dropdown icon` caret LEFT → `<span>{position}.` number → `<span>{label}<span class=table>, tableKey</span>` (tableKey `font-weight:normal`, `less:62-65`) → `div.ui.circular.small.basic.label.data-model-table-count` (count badge, right of label) → `<span class=description>` (grows, ellipsis, normal weight; `less:41-49`). Direct children forced `white-space:nowrap; flex-shrink:0; margin-right:0.5em` (`less:34-39`).
- **Group title**: `title group-title` with `background:#aaaaaa !important` and inset white shadow `inset 0px -5px 35px 15px white` (`less:29-32`). Group count badge `data-model-group-count`.
- **Column title** (`data_model_column.jsx:328-355`): caret, `{tablePos}.{colPos}` number, `{label}<span class=column>, col</span>`, a `ui basic horizontal small label` for type/unit, description, then a series of colored horizontal small labels by validation.
- **Badge colors** (all `ui <color> horizontal small label`, `data_model_column.jsx`): Required = **red**; Recommended = **yellow**; Download Only = **black**; Found In = **teal**; Validation = **purple**; Vocabulary = **orange**; Required(?) = **green** (`:337-354` and `formatValidation`). Type/unit badge = `basic` (grey outline). Colors are the EarthRef Semantic theme's (`public/lib/semantic-ui/compiled/2.4.2/semantic.css`), not stock Semantic: red `#9f0202`, yellow `#f0ad4e`, black `#1c1c1c`, teal `#005b87`, purple `#800080`, orange `#bb4b1c`, green `#006600`, all with white text. `less:71-75` sets `font-weight:normal; color:rgba(0,0,0,0.6); padding:0.4em`, but its color loses to `.ui.<color>.label`'s higher-specificity `!important`, so the text stays white.
- **Expanded table**: `ui very basic small compact table` (`:357`); left cells `top aligned collapsing` bold labels (Description/Notes/Type/Unit/Links/Examples/Validations/version Column/previous Column).
- **Indentation per nesting**: `.accordion .content { padding:0em 1.75em 0.5em !important }` (`less:67-69`) — each level indents content ~1.75em (24.5px). Active column hides its description (`visibility:hidden`, `less:51-53`). No-match rows `display:none` (`less:77-81`).

---

## 3. PRIVATE WORKSPACE

`client/modules/magic/components/private_contributions.jsx`

**Deviation (data-source mode, 2026-11-09):** while a node's `contributions_mode` is `source` the API refuses every write, so the SPA hides the private workspace: `/private` and `/upload` show only the source-mode notice, and the home page's Upload Tool and Private Workspace cards, the search page's Private Workspace button and the portal bar's user-name link to `/private` are left out (the name stays as plain text). They return unchanged at the cutover to `public`.

```
ui list (margin:0)
  [+ Upload Data…]  [📄 New Contribution]  [✎ In Preparation (n)]  [☑ Published (n)]   ← floated buttons
  ┌ item (marginBottom:1.5em) ── ONE CONTRIBUTION CARD ────────────────────────────────┐
  │ ┌ <color> ui top attached INVERTED segment (purple bar, pad 0.5em, w:calc(100%+2px))┐│
  │ │ [ Private Contribution Name |  input………… | 🔴Save ]  [Edit][Share][Delete]        ││ ← inverted top bar
  │ └────────────────────────────────────────────────────────────────────────────────────┘│
  │ ┌ ui attached secondary segment (pad 0.5em) ─────────────────────────────────────────┐│
  │ │ [ Labs | dropdown multi……… | 🔴Save ]        [+Funding][+Supplement]                ││
  │ └────────────────────────────────────────────────────────────────────────────────────┘│
  │ ┌ ui attached secondary segment (per Funding row) … [Funding|title|url|Save][−This]  ┐│
  │ ┌ ui attached secondary segment ─────────────────────────────────────────────────────┐│
  │ │ [ DOI | input | Save ] [ Description | input | Save ]  [Validate][Publish][Published]││
  │ └────────────────────────────────────────────────────────────────────────────────────┘│
  │ ┌ ui BOTTOM attached segment (pad 1px 1em 0) — collapsed result list item ───────────┐│
  │ └────────────────────────────────────────────────────────────────────────────────────┘│
  └──────────────────────────────────────────────────────────────────────────────────────┘
```

- Top control buttons: each `<color> ui icon button`, floated (`float:right`) with `margin:0 1em 0.5em 0` (or `0 0 0.5em` for the first) (`:343-456`). The count badges are `ui circular small basic label` inline `{color:#0C0C0C; margin:-1em -0.5em -1em 0.5em; minWidth:4em}` (`:379-386`, `:425-432`).
- **Card = stacked attached segments** all forced `width:calc(100% + 2px)` via a `ref` setProperty (so their 1px borders bleed to the card edges). Order & anatomy:
  1. **Inverted top bar**: `<color> ui top attached inverted segment` inline `padding:0.5em` (`:531-536`). Purple background, white text. Inside: `flex row wrap`; left `flex:1 1 auto` `ui labeled fluid small input` with label "Private Contribution Name" + input (`borderRadius:0`) + right-attached save button `ui small right attached icon button` (`+ red`/`disabled`/`loading`), `marginRight:0` (`:548-585`). Then `ui small button` Edit / Share / Delete each `margin:0 0 0 0.5em` (`:587-639`).
  2. **Labs segment**: `ui attached secondary segment` pad 0.5em (`:642-644`). `ui corner labeled fluid small input` (`+ error` when empty): label "Labs" (red when empty, squared right corners), a Semantic `<Dropdown multiple selection search>` (`borderRadius:0; flexGrow:1`), right-attached Save. Then two `ui small purple button` ("+Funding", "+Supplement") `margin:0 0 0 0.5em; whiteSpace:nowrap` (`:719-743`).
  3. **Funding / Supplement rows** (repeated): `ui attached secondary segment` pad 0.5em; a labeled input with two text inputs (title/url) + Save, and a `ui small purple button` "− This Funding/Supplement" (`:746-944`).
  4. **DOI/Description segment**: `ui attached secondary segment`; two `flex:1 1 auto` labeled inputs (DOI required→red label; Description) + action buttons: Validate `ui red small button`; Publish `ui small button <color|disabled red>`; Published `ui green disabled small button`; dev "Make Private" `<color> ui basic small button` (`:945-1123`).
  5. **Bottom segment**: `ui bottom attached segment` inline `padding:1px 1em 0` (`:1125-1127`) wrapping a collapsed `SearchSummariesListItem`.
- **Spacing between cards**: each wrapper `item` has `marginBottom:1.5em` (`:530`).
- **FIESTA deviations (2026-11-10):**
  - The In Preparation / Published buttons choose one list instead of toggling each independently: the page opens on In Preparation only, and Published lists the caller's published contributions newest publication (`activated_at`) first. Their count badges are the search level tabs' `CountLabel` (bold 11px, `lineHeight:0.7em`, `margin:-1em -1em -1em 0.5em`).
  - Red and green fills use the muted `--er-danger` / `--er-success` tokens (index.css, light and dark) instead of Semantic `red`/`green`.
  - The Labs / Funding / Supplement / Description controls are node configuration: the YAML's `workspace.fields` names contribution-table columns, and each column's data-model type picks its control (List → multi-select over its `cv()` vocabulary, Dictionary → title + URL rows, otherwise a text input; `required()` columns get the red label while empty). MagIC lists the four legacy columns; other nodes list none. Each Save writes the column into the canonical file as a new revision (`PUT /private/contributions/{id}/fields`). Description gets its own segment above the DOI row rather than sharing it. A Funding/Supplement row's remove button reads "Remove".
  - With `workspace.require_reference` (MagIC), a line under the DOI row shows the resolved citation, or says the DOI is not registered yet. Publish stays disabled (red) until the DOI resolves, as legacy's `hasReference` did, and the API refuses `activate` too. Saving the same DOI again re-checks it.
- **FIESTA deviation (2026-11-12): card redesign.** It replaces the stacked attached segments (items 1–4 above; item 5's summary row stays at the bottom of a published card only) to make each card's actions easier to find and to show what blocks Publish (`components/workspace-card.tsx`):
  - **Header**: the contributor's name for the contribution (legacy "Private Contribution Name", the `name` column, `PUT .../name`; the file name until one is set, and in the meta line after) as the title, with a **Rename** button that turns it into an input with Save / Cancel (Enter saves, Escape cancels; empty clears it; published contributions too, as it is a workspace label and saves no revision), and a status badge (Ready to publish · *n* steps before publishing · Checking · Published · Superseded by version *n*), a meta line (contribution id, version, updated or published date, data model, "New version of contribution *n*" linking to it), and the everyday actions on the right as small buttons: Preview (the private-key link), Share, Edit · History · Files, Delete in preparation; View, Copy link, History · Files once published. The card has a 4px left accent (node color in preparation, green published, gray superseded).
  - **In preparation**: two columns (stacked below `lg`). *Details* holds the node's `workspace.fields` and the DOI as flat labeled rows (no segment borders). *Publishing* is a checklist in the order to work through it (data file uploaded; each required workspace field filled in; DOI added, or for `require_reference` found at Crossref/DataCite; validation passed), each step done ✓, to-do ○, blocked ✕ (red, with the reason: the parse error, *n* validation errors with View results, DOI not registered yet) or in progress (spinner), followed by Validate and Publish buttons. Publish is disabled until every step is done, and its tooltip lists the remaining steps (once ready, what publishing does). Every saved edit starts a new revision that the API re-validates on its own, so the checklist follows the processing status (the list polls every 3 s while one is processing) and the validation is cached per head revision. At the foot of *Details*, instead of the full summary row, a *Contents* line lists the record counts per search level (as search's Counts tile), each opening the private preview at that level. **2026-11-13 density pass:** the card's action buttons use the page's standard 13px Button (not the 12px `sm`), the Publishing panel sizes to its content (`self-start`), the done file step drops its detail (the file name is in the header), and the trailing remaining-steps line is gone (the header badge already counts them), so the two columns no longer leave a tall blank beside the checklist. **2026-11-13 layout pass:** on an in-preparation card the actions sit in a row under the title and meta line, above *Details*, and *Publishing* is a full-height panel attached to the card's right edge (below `lg`, a full-width panel across the bottom). The card's left edge and its status badge follow readiness: red while any step is blocked (validation errors, unreadable file, missing file, DOI not registered), amber while steps remain or validation passed with warnings, green when ready with no warnings, and the node color while checking. Published cards keep their header layout and edge colors.
  - **Published**: one line of explanation, then **Create new version** as the primary action (it opens In Preparation scrolled to the new card), or, once a next version exists, **Continue version *n*** / **Go to version *n***. Contributors cannot unpublish (legacy's dev-only "Make Private"): the API's `deactivate` is node-admin only, and node admins get an *Admin* section under Saved revisions in the History · Files modal with **Unpublish** behind an inline confirmation.
  - In Preparation sorts by last change; the empty states explain each list and offer Upload Data.

### Grid editor (`client/modules/fiesta/components/edit_contribution_modal.tsx`)

Legacy: a Handsontable grid in a modal. The data model's tables are a tab menu, each tab with a red circle (rows with errors), a purple circle (rows edited) and "of *n*" rows. Edited cells get an inset 2px `#ce93d8` outline and cells with errors a `#fde8e8` fill (a comment holds the messages). Read-only (`downloadOnly()`) cells are gray. A context menu inserts and removes rows, Ctrl+Z / Ctrl+Y undo and redo, and `cv()` columns have "(cv)" in their header. The table keeps 100 spare rows at the end; pages hold 100 / 250 / 500 / 1000 rows (250 by default). A 350px side panel shows the selected cell's column, label, type, unit, description, notes, 3 examples, its validation errors and the vocabulary as checkboxes (method codes grouped in an accordion). "Show Empty Columns" defaults to on for an empty table and off otherwise. Every edit re-runs the client-side MagIC validator, and Save Edits writes to OpenSearch and re-summarizes.

FIESTA (`components/contribution-grid.tsx`, 2026-11-13; MagIC #547) has all of the above, with these deliberate deviations:

- **The grid is built in-house** on `@tanstack/react-virtual`, which the SPA already uses (MIT), and not on Handsontable (non-commercial licence) or AG Grid Enterprise. It is a lazy chunk that loads when the editor opens. Rows and columns are both virtualized, so 1000-row pages with every column shown stay responsive. Keyboard: arrows / Tab / Enter / F2 / Escape, Shift to extend a selection, drag to select, Delete clears, Ctrl+A, and copy, cut and paste as tab-separated text to and from spreadsheets. Pasting one value fills the selection, and a block past the last row appends rows.
- **Saving is a new revision** through `PUT /private/contributions/{id}/content` (expected revision plus an idempotency key that a retried save reuses), never an OpenSearch write. The grid writes the file back in its own table and column order, with added tables and columns after them in data model order and empty rows, columns and tables left out. Values lose tabs and line breaks, which the format cannot hold. The worker validates the new revision, and the editor polls for that result.
- **Validation is the server's**, mapped to cells by table, row and column, and it describes the saved revision. A cell edited since then shows light client checks instead (type, `min`/`max`, `required()`, `cv()` lists, worded as the validator words them). Cross-row checks wait for the next save, and the side panel says so. Table- and column-level issues (unrecognized table or column, recommended columns with no values) are listed above the grid. The validator is not ported to TypeScript.
- **Vocabularies come from the API**: `cv()` → `/config/vocabularies/controlled`, or a plugin's list (`/config/vocabularies/plugins`, new: method codes with their definitions); `sv()` → suggested lists; a `type("x")` that names a vocabulary (MagIC `method_codes`) offers it as a suggestion. `in("samples.sample")` columns suggest the values already in that table's column. The in-cell pulldown filters as you type, and in a List column it completes the colon-separated value being typed. Method codes are one filterable list with definitions, not legacy's accordion grouped by type (no core special case).
- **One spare row** at the end of the last page instead of 100. Add row and the context menu insert more.
- Read-only columns that are empty are hidden with the other empty columns, and required columns always show. Columns stay visible once they hold a value during the session, even if it is cleared.
- **A Text mode** beside Grid keeps the raw-text editor as a fallback, sharing the same unsaved edits both ways (a text that does not parse stays in Text mode with the parse error). Revisions, restore, attachments and the admin Unpublish stay below the editor in the same modal, which now fills nearly the whole window. Closing it, or Cancel edits, with unsaved edits asks for confirmation.
- Colors use the theme tokens in both schemes: errors `bg-red-50`, edited cells a 2px inset `purple-500` ring, the selection `node-soft`, read-only cells `gray-50`. Tab badges are red-700 (errors), purple-700 (edited) and an outlined row count.
- Logged-out state: `ui top attached segment` (login/register IconButtons, vertical "OR" divider) + `ui bottom attached icon error message` (`:299-338`). Empty state: `ui fluid warning message` with `ui center aligned huge basic segment` "No Items to Display" (`:1146-1152`). Loading: `ui segment min-height:8em` + inverted dimmer (`:457-462`).

---

## 4. UPLOAD

`client/modules/magic/components/upload_contribution.jsx`, `styles/upload_contribution.less`

```
.upload-contribution
┌ ui top attached stackable THREE steps (w:calc(100%+2px)) ──────────────────────────────┐
│ [📂 Step 1. Select]   [📄 Step 2. Import]   [📄+ Step 3. Upload]                        │
│  active pointing▼       disabled/active        disabled/active                           │
└────────────────────────────────────────────────────────────────────────────────────────┘
┌ ui attached message upload-contribution-message (bg white) ────────────────────────────┐
│  ┌ upload-dropzone (react-dropzone; cursor:pointer) ─────────────────────────────────┐ │
│  │        📂 (huge purple)          |OR|          ⤢ (huge purple)                      │ │
│  │     Click and select                        Drag and drop files                     │ │
│  │      files to upload.                          here to upload.                       │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
│  ── ui divider ──                                                                         │
│  H4: If you don't have a file handy … upload an example file:                             │
│  ┌ ui FIVE stackable cards ───────────────────────────────────────────────────────────┐ │
│  │ [📄↑ Example MagIC Text / v3.0] [▦↑ Tab Delimited/Sites] [▦↑ Comma/Specimens] …     │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
│  ── ui divider ──  H4: Or first download…   ┌ ui FIVE stackable cards (download) ┐        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Steps bar**: `ui top attached stackable three steps` forced `width:calc(100%+2px)` (`:916-921`). Each step `pointing below step`; state class `active` or `disabled` (`:922-1022`). `.upload-contribution .ui.steps .step { min-height:8em }` (`upload_contribution.less:1-3`). Active pointing-below step draws a rotated 45° arrow beneath it (`site.overrides` `.ui.steps .active.step.pointing.below:before`, using `@activeBackground`/`@borderColor`, `@arrowSize`), offset `top:calc(100%+1px)` when attached; hidden on mobile. Step icon `i.icons` (font-size `@iconSize`, `margin:0 @iconDistance 0 0`). Content: `div.title` "Step N. …" + `div.description`. Step 1 toggles to an `<a>` "Step 1. Restart" once processing.
- **Message container**: `ui attached message upload-contribution-message`, forced `background:white` (`less:5-7`); wraps a `ui accordion` whose titles are `visibility:hidden; padding:0` (used only as a step switcher) (`less:9-12`).
- **Dropzone**: `react-dropzone` with class `upload-dropzone` (`:1033-1035`), inside a `ui basic segment`. Content is a `ui center aligned two column relaxed grid`: left column `i.huge.purple.folder open outline icon` + two `<h5>`; a `ui vertical divider` "OR"; right column `i.huge.purple.external icon` + two `<h5>` (`:1038-1051`). No explicit dashed border in JSX — it's the plain react-dropzone box; `.select-step-content .upload-dropzone { cursor:pointer }` (`less:32-34`). The visual "drop area" framing comes from the surrounding `ui basic segment` + centered icon/text grid (no border of its own).
- **Example-file card row**: `ui five stackable cards` (`:1059`) of `IconButton className="borderless card"`. Each: `i.icons` with a base icon (`file text outline`/`table`/`file excel outline`) + corner icon `up circle arrow corner purple icon` (upload) or `down circle arrow corner purple icon` (download) (`:1069-1234`); `div.title` two-line ("Example / MagIC Text") + `div.subtitle` ("Data Model v. 3.0"). Message accordion file-icons styled `font-size:4em; line-height:1; vertical-align:middle` (`less:18-26`).
- **Step 2. Import** (`:1240-1495`, `common/components/data_importer.jsx`): one item per file (name, size label, read/parse/import error count labels), an "Import File Type" dropdown (MagIC Text, Tab Delimited, Comma Delimited, Excel), then one DataImporter per table: a template dropdown ("Select to Load Template" / "Clear Import Settings", Rename and Delete buttons inside each menu item, Save / Save As New), a "Table Name" dropdown, a "Number of Header Rows" input, an errors accordion, a preview table (a checkbox per column and per row, the first header cell's checkbox skips the table, a searchable data-model column dropdown per column), "Preview More Rows / Preview Less Rows / Show All Rows", and "Importing *n* rows with *m* columns." MagIC Excel files (A1 `Group:`, A4 `Column:`) lose 3 rows and the first column; other spreadsheets' first header row is guessed (a row whose first cell + "s" names a table).
- **Step 3. Upload** (`:1500-1560`): an "Upload To" dropdown ("A New Private Contribution" or one of the user's private contributions) and a name input for a new one, the summarised contribution previewed as a search result card, then Upload.

**Deviations (upload parity, 2026-11-13):**
- The example files, the Excel template layout and the tables one upload may bring from a single sheet (MagIC: measurements, legacy's "more than one measurement tables" refusal) are the node YAML's `upload` section, so every node gets the same import step for its own data model. The two Excel examples are real `.xlsx` workbooks (legacy offered text files named `.xls`): a MagIC Excel template with Group/Name/Type/Column rows, and the sites table on `Sheet1`.
- Step 1 says "Restart" and goes back; Step 2 is reachable from Step 3 by clicking it. The file-type menu drops the inert "Laboratory Format" item. Comma-delimited files are read as RFC 4180 CSV (quoted cells may hold commas); legacy split on every comma.
- The import template, table and column pickers are native selects (type-ahead, no search box); Rename and Delete are buttons beside the template picker, shown once a template is loaded. Templates are kept per user **and node** in Postgres (legacy: per user, Mongo).
- A column mapped to a download-only data-model column (contribution_id, row_id …) is never imported and its checkbox is disabled; legacy left it checked and imported it.
- Values are normalised on the server after the import step, as legacy did before summarising: Integer `.0`, booleans (also `true`/`yes`), controlled-vocabulary case; a one-letter typo is corrected only for values of three or more characters and only when exactly one term is that close (legacy took the first term within one edit, so `x` became `b`), and List cells are corrected term by term.
- Step 3 lists the tables being uploaded with their row counts and, for an existing contribution, the rows each replaces and the tables kept, instead of the summarised search card. Only unpublished contributions the user can open are offered. In the existing contribution's `contribution` row, the workspace fields (labs, funding, supplement, description) and the reference survive where the uploaded row leaves them blank; legacy always overwrote them with the existing values. The upload is a new revision (history and restore keep the previous one), refused if the contribution changed after Step 3 read it. An in-preparation workspace card has an Add Data button (legacy "Add Data to This Contribution", MagIC #327) that opens `/upload?to=<id>` with that contribution chosen.
- The files as uploaded are kept as attachments of the new revision (Phase M keeps originals); legacy stored only the converted contribution.

---

## 5. HOME PAGE

`client/modules/magic/components/home.jsx`

```
ui grid divided → Grid.Row
┌ Grid.Column width={12} ───────────────────────────────────┐┌ Grid.Column width={4} ┐
│ ui THREE cards:                                            ││  <News /> column        │
│ [ 🗄🔍 Search Interface ] [ ▦＋ Upload Tool ] [ 📄☑ Private] ││                         │
│                                                            ││                         │
│ ui grid → sixteen wide column:  [ Poles / View  (tiny card)]││                         │
│ ══ H2 horizontal divider: MagIC Resources ══               ││                         │
│ ui NINE cards (borderless): Data Model | Method Codes | …  ││                         │
│ ══ H2 horizontal divider: Recent Contributions ══          ││                         │
│ SearchDividedList → 7 result list items                    ││                         │
│ [ small card: View More Contributions … ]                  ││                         │
└────────────────────────────────────────────────────────────┘└────────────────────────┘
```

- **Grid proportions**: `Grid divided` → `Grid.Row` → `Grid.Column width={12}` (main) + `Grid.Column width={4}` (News) — a **12/4 split of 16** with a divider between (`home.jsx:39-41, 269-271`).
- **Primary card row**: `ui three cards` (`:42`) = 3 equal-width cards. Each is an `IconButton className="card"` → rendered as `ui icon header basic fluid button <color> card er-icon-button`. Card look = default Semantic card (1px border `rgba(34,36,38,.15)` + shadow), but `er-icon-button` overrides: default `background:#f8f8f9`; hover `#f0f0f0`; active transparent (`icon_button.less:5-15`). Non-hover/active box-shadow removed for borderless variant only.
- **IconButton anatomy** (`icon_button.jsx`): `i.large icons` stacking a base `icon` + a `corner <x> icon`. First icon color `#555` (`icon_button.less:37-39`); corner icon `font-size:1.5em` (`icon_button.less:41-43`). `div.title` → becomes `ui header <color>` (margin-bottom 0.5rem if subtitle else 0, `icon_button.jsx:12-14`). `div.subtitle` → `ui sub header` `{textTransform:none; color:#555555; marginBottom:0}` (`icon_button.jsx:15`). Cards-in-cards padding `.cards > …button > * { padding:0.875em }` and top margin `0.875em` (`icon_button.less:29-35`).
- **Poles tiny card**: nested `ui grid` → `sixteen wide column` (full width) with tooltip; `IconButton className="tiny card"` (`:86-104`).
- **Resource cards**: `ui nine cards` inline `marginTop:0` of `borderless card` IconButtons, each with `small title` two-line label (`:111-245`).
- **Divider headers**: `h2.ui.horizontal.divider.header` (text centered with rule through it); first one inline `marginBottom:0` (`:105-109, 246`).
- **Recent contributions**: `SearchDividedList pageSize={7}` of `SearchSummariesListItem table="contribution"` (`:249-257`), then a `small card` "View More…" with `margin:0`.
- **News column** = `<News/>` component (`home_news`, `:270`).

### Measured metrics (home page, 2026-09-11, 1400×900 vs magic.earthref.org/magic)

- **Container**: `ui container` = 1127px at ≥1200px (933px ≥992, 723px ≥768,
  else 1em side margins); FIESTA renders the home page full width instead (see
  Container width above). `ui grid divided`: margin −1rem, row padding 1rem 0, twelve/four
  wide columns (75%/25%) with 1rem side padding; the news column's divider is a
  `−1px 0 0 0` box-shadow, and it opens with a `ui divider` (margin 1rem 0).
- **Primary cards** (`ui three cards`): wrapper margin −.875em −1em, cards
  margin .875em 1em, width calc(33.33% − 2em), 14px, padding .875em, bg
  #f8f8f9 + 1px inset node-colored shadow, radius .2857rem; 54px base icon
  (3× the 18px header) with a .45em corner icon, 16px below it the 18px/700
  title (line 23.14px, margin-bottom .5rem), then the 14px/1.2 #555 sub header.
  158px tall. Hover bg #f0f0f0.
- **Tiny card** ("Poles / View", plugin `homeCards`): full width, padding .786em,
  two 18px header lines, 68px tall, .875em below the cards.
- **Divider headers**: 24px/700 on a 24px line, margin calc(2rem − .1428em) 0
  1rem (first: bottom 0).
- **Resource cards** (`ui nine cards`): 10px cards, wrapper margin 0 −.5em
  −.875em, cards margin .875em .5em, width calc(11.11% − 1em) (84.7px),
  transparent, 32px icon, 5px gap, 10.71px/700 small header on 13.78px lines.
  82px tall.
- **View more**: full-width `small card` (15px), padding .786em, one 15px/700
  title line, 44px tall, 1em below the list.
- **News**: h3 18px/700 (margin calc(2rem − .1428em) 0 1rem), p 14px with
  1em bottom margin.
- **FIESTA deviations (2026-09-27):** news titles are left-aligned (legacy
  inherited the column's `text-align: justify`; the body stays justified); the
  nine resource cards are centred when a row is not full (legacy left-aligned).
  From 2026-09-28 the News divider header has no top margin at ≥1024px, where it
  opens its own column level with the main column; stacked below, it keeps it.
- **Portal home (FIESTA only, 2026-09-27):** where one origin serves every node
  (`fiesta-env.js` lists `nodes`), the build base (`http://localhost:8080/`) is a
  FIESTA home in the same grid: a node card (key, title, contribution count) in
  place of Search / Upload / Private, no Resources, the latest 7 contributions
  across all nodes as each node's own result item, and every node's news, each
  item under its node's key. Other paths outside a node still redirect to the
  default node.

---

### Key file:line index for the developer
- Search shell & inline styles: `search.jsx:625-668` (all `this.styles`), `:1280-1478` (render), `:3121-3311` (tabs/view).
- Result card: `search_summaries_list_item.jsx:682-1358`; cell widths at `:122,145,183,198,255,313,385,399,448,460,481,530,596,609,625,651,669`; `.less` for collapsed heights & hover button.
- Data model: `data_model.jsx:243-421`; `data_model_column.jsx:326-464`; `styles/data_model.less`.
- Private workspace: `private_contributions.jsx:340-1145`.
- Upload: `upload_contribution.jsx:914-1236`; `styles/upload_contribution.less`.
- Home: `home.jsx:20-276`.
- Global: `layout.jsx`, `page.jsx`, `icon_button.jsx`, `styles/layout.less`, `styles/page.less`, `styles/icon_button.less`, `semantic-ui/site/globals/site.variables` & `site.overrides`, `collections/menu.overrides`.

Note: there is no `client/style.css`; custom rules live in the `.less` files quoted above and in the `semantic-ui/site/**` theme stubs (most `.variables`/`.overrides` for segment/label/menu/step/accordion are empty pass-throughs to Semantic defaults, except the specific overrides quoted from `site.overrides` and `menu.overrides`).