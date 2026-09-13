# Legacy MagIC poles globe view — implementation spec

Source: `MagIC/client/modules/magic/components/search_poles_view.jsx`. The
rebuild's poles view should match this. Backend already provides everything:
`GET /v2/{node}/plugins/poles/base-texture` (earth relief JPEG),
`GET /v2/{node}/plugins/poles/plate-boundaries` (GeoJSON), `GET /v2/{node}/search/poles`
(pole docs), and `config.plugins.poles` (colors, columns, filters, flags).

## ECharts-GL globe option (both globes share this)

```js
{
  backgroundColor: "#FFF",
  globe: {
    baseTexture: nodeUrl("/plugins/poles/base-texture"),   // when has_base_texture
    shading: "lambert",
    viewControl: { autoRotate: false, distance: 200, rotateSensitivity: 2, zoomSensitivity: 2 },
    light: { ambient: { intensity: 1 }, main: { intensity: 0 } },  // flat, evenly lit
  },
  series: [platesLines3D, ellipsesLines3D, polesScatter3D],
}
```

No environment/starfield, no height/displacement. Distance clamp [1, 1000].

## Layout

- Outer: `flex column, height 100%`.
- **Row 1 — detail card bar** (~194.5px): white, `padding 10px, flex, align center, gap 10px, border-bottom 1px #D4D4D5`. Contents: circular `chevron-left` button (disabled at first pole) · the selected pole's result-item card (`flex:1`) · circular `chevron-right` button (disabled at last). Prev/next change the selected pole.
- **Row 2 — flex row**: globes area (`flex:1`) + a fixed **180px side panel**.
  - **Globes**: two `<ReactECharts>`. Layout flips on aspect: if available height ≥ width → stacked (column, each full width × half height, first has `border-bottom 1px #D4D4D5`); else side-by-side (row, each half width × full height, first has `border-right 1px #D4D4D5`). Left globe shows the view; **right globe shows the antipode** (not a copy).
  - **Side panel** (180px, sections each `padding 0.25em 1em 0.5em`, `border-bottom 1px #D4D4D5`, `<h5>` headings `rgba(0,0,0,.87)`):
    1. "Displayed Poles" — max-count number input (default 100).
    2. "Uncertainty Ellipses" — Show/Hide toggle (default show).
    3. "Color Legend" — vertical 14×150px gradient bar `linear-gradient(to bottom, #ff0000, #ffff00)` with 5 age labels (max/75/50/25/min via age formatting), plus a black "Unknown Age" swatch and a purple "Selected Pole" swatch.

## Series

**Plate boundaries** (`lines3D`, `polyline:true`, `coordinateSystem:"globe"`, `zlevel:-10`): each ring → coords `[lon,lat,0]`, `lineStyle {color:"#990000", opacity:0.8, width:2}`. Split rings at the date line (adjacent-vertex jump > 180°) so segments don't wrap across the globe.

**Uncertainty ellipses** (`lines3D`, `polyline:true`, `zlevel:-9`), only when the toggle is on and `alpha95 > 0`: one ring per pole, `lineStyle {color: selected ? "#800080" : ageColor, width:2, opacity:0.8}`.

**Poles** (`scatter3D`, `zlevel:-8`): one point per pole, `value:[lon,lat,0,contributionId,poleId]`, `symbol:"circle"`, `symbolSize:12`, `itemStyle.color: selected ? "#800080" : ageColor`, `emphasis.itemStyle.color:"#800080"`, `label.show:false`.

## a95 uncertainty ellipse (verbatim math)

```js
function generateUncertaintyEllipse(poleLat, poleLon, alpha95) {
  const φ = poleLat*Math.PI/180, λ = poleLon*Math.PI/180, r = alpha95*Math.PI/180;
  const n = Math.max(12, Math.round(10 + 50*alpha95));   // legacy: 10 + 50*alpha95
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = 2*Math.PI*i/n;
    const lat = Math.asin(Math.sin(φ)*Math.cos(r) + Math.cos(φ)*Math.sin(r)*Math.cos(t));
    const lon = λ + Math.atan2(Math.sin(t)*Math.sin(r)*Math.cos(φ),
                               Math.cos(r) - Math.sin(φ)*Math.sin(lat));
    pts.push([lon*180/Math.PI, lat*180/Math.PI, 0]);      // [lon,lat,0] for the globe
  }
  pts.push(pts[0]);                                        // close the ring
  return pts;
}
```

## Age coloring (young→old = yellow→red)

```js
// minAge/maxAge over all displayed poles
function ageColor(age) {
  if (age == null || isNaN(age)) return "#000";           // unknown
  const t = ageRange > 0 ? (age - minAge)/ageRange : 0.5;
  return `rgb(255, ${Math.round(255*(1-t))}, 0)`;          // young→yellow, old→red
}
```
Age per pole: `summary.poles.age` (numeric block the backend emits). Selected pole overrides to `#800080`.
Age label formatting: ≥1e9 → "{n} Ga" (2dp), ≥1e6 → "Ma" (1dp), ≥1e3 → "Ka" (0dp), else years.

## Camera sync (antipodal)

```js
const wrap180 = a => ((a+180)%360)-180;
const antipodalView = ({alpha,beta,distance}) => ({alpha: wrap180(alpha+180), beta: -beta, distance});
const antipodalCoord = ([lon,lat]) => [wrap180(lon+180), -lat];
```
Bind the left globe's `globeroam` (and raw `getZr()` mousedown/move/up + wheel, since roam may omit distance) → read `{alpha,beta,distance}` from the globe model → apply `antipodalView` to the right globe via `dispatchAction({type:"globeChangeView", componentIndex:0, alpha, beta, distance})`. Mirror right→left. Guard with an `updating` ref to avoid feedback loops. Reconcile distance for ~300ms after the last event.

Clicking a globe point selects that pole (`value[4]`); selection centers it on the left globe (`viewControl.targetCoord = [lon,lat]`) and its antipode on the right, and recolors it purple.
