import type maplibregl from "maplibre-gl";
import { MERCATOR_LAT, type PolarCap, type PolarTiles, type Pole } from "./basemap";

// MapLibre's globe is drawn from Web Mercator tiles, which stop at ±85.05°;
// past that it stretches the tiles' edge rows out to the pole. This custom
// layer covers each polar cap it's given (POLAR_CAPS, or POLAR_LABELS over
// them) with meshes projected by
// MapLibre's own globe shader code, whose Mercator-to-sphere step has no
// latitude limit. A cap is drawn from one of:
// - a flat colour, on a latitude-longitude mesh;
// - polar stereographic tiles (see PolarTiles), each on its own mesh, at the
//   level whose texels best match the screen's pixels, as MapLibre picks its
//   own tiles. Their parts outside the cap are discarded.
// Both fade in before the cap's edge, as they come from a different source
// than the basemap's tiles and differ from them in shading and colour. The
// fade is about FADE_PIXELS wide on screen, within MIN_FADE_DEGREES and
// MAX_FADE_DEGREES: zoomed out, a fixed width in degrees would be a hard edge.

const COLUMNS = 180;
const ROWS = 16;
// Mercator y is infinite at the pole itself; this leaves a ~100 m hole.
const POLE_LAT = 89.999;
const POLES: Pole[] = ["north", "south"];
const EDGE = MERCATOR_LAT;
const FADE_PIXELS = 40;
const MIN_FADE_DEGREES = 1;
const MAX_FADE_DEGREES = 4;

const mercatorY = (lat: number) =>
  0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
const signed = (pole: Pole, lat: number) => (pole === "north" ? lat : -lat);

// Interleaved [mercator x, mercator y, u, v, |latitude|] vertices and triangle
// indices.
type MeshData = { vertices: Float32Array; indices: Uint16Array };
const gridIndices = (columns: number, rows: number) => {
  const indices: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const a = row * (columns + 1) + col;
      const b = a + columns + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return new Uint16Array(indices);
};

// A colour cap, from |latitude| from to the pole (untextured: u and v are 0).
const capMesh = (pole: Pole, from: number): MeshData => {
  const [edge, tip] = pole === "north" ? [from, POLE_LAT] : [-from, -POLE_LAT];
  const vertices: number[] = [];
  for (let row = 0; row <= ROWS; row++) {
    const lat = edge + ((tip - edge) * row) / ROWS;
    for (let col = 0; col <= COLUMNS; col++)
      vertices.push(col / COLUMNS, mercatorY(lat), 0, 0, Math.abs(lat));
  }
  return { vertices: new Float32Array(vertices), indices: gridIndices(COLUMNS, ROWS) };
};

// Ellipsoidal polar stereographic with scale factor k0 at the pole (Snyder,
// Map Projections: A Working Manual, ch. 21), in metres from the pole.
const E = 0.0818191908426;
const E2 = E * E;
const E4 = E2 * E2;
const E6 = E4 * E2;
const E8 = E4 * E4;
const RHO_SCALE = (2 * 6378137) / Math.sqrt((1 + E) ** (1 + E) * (1 - E) ** (1 - E));
// Distance from the pole of latitude ±lat.
const stereoRho = (tiles: PolarTiles, lat: number) => {
  const phi = (lat * Math.PI) / 180;
  const t =
    Math.tan(Math.PI / 4 - phi / 2) /
    ((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi))) ** (E / 2);
  return RHO_SCALE * tiles.k0 * t;
};
// [|latitude|, longitude] of the point dx east and dy north of the pole.
const stereoInverse = (tiles: PolarTiles, pole: Pole, dx: number, dy: number): [number, number] => {
  const chi = Math.PI / 2 - 2 * Math.atan(Math.hypot(dx, dy) / (RHO_SCALE * tiles.k0));
  const phi =
    chi +
    (E2 / 2 + (5 * E4) / 24 + E6 / 12 + (13 * E8) / 360) * Math.sin(2 * chi) +
    ((7 * E4) / 48 + (29 * E6) / 240 + (811 * E8) / 11520) * Math.sin(4 * chi) +
    ((7 * E6) / 120 + (81 * E8) / 1120) * Math.sin(6 * chi) +
    ((4279 * E8) / 161280) * Math.sin(8 * chi);
  const lon = tiles.lon0 + (Math.atan2(dx, pole === "north" ? -dy : dy) * 180) / Math.PI;
  return [(phi * 180) / Math.PI, lon];
};

// A tile's bounds in metres from the pole.
const tileBounds = (tiles: PolarTiles, level: number, row: number, col: number) => {
  const size = (256 * tiles.resolution) / 2 ** level;
  const left = tiles.origin[0] + col * size - tiles.falseEasting;
  const top = tiles.origin[1] - row * size - tiles.falseNorthing;
  return { size, left, top };
};

const TILE_GRID = 16;
const tileMesh = (
  tiles: PolarTiles,
  pole: Pole,
  level: number,
  row: number,
  col: number,
): MeshData => {
  const { size, left, top } = tileBounds(tiles, level, row, col);
  // Longitudes are kept within 180° of the tile's centre, so no triangle
  // wraps around the globe. (Level 0, centred on the pole, is never drawn.)
  const [, centerLon] = stereoInverse(tiles, pole, left + size / 2, top - size / 2);
  const vertices: number[] = [];
  for (let r = 0; r <= TILE_GRID; r++) {
    for (let c = 0; c <= TILE_GRID; c++) {
      const [u, v] = [c / TILE_GRID, r / TILE_GRID];
      const [dx, dy] = [left + u * size, top - v * size];
      const [lat, lon] = stereoInverse(tiles, pole, dx, dy);
      // The pole's longitude is arbitrary.
      const unwrapped =
        Math.hypot(dx, dy) < 1 ? centerLon : lon + 360 * Math.round((centerLon - lon) / 360);
      vertices.push(
        (unwrapped + 180) / 360,
        mercatorY(signed(pole, Math.min(lat, POLE_LAT))),
        u,
        v,
        lat,
      );
    }
  }
  return { vertices: new Float32Array(vertices), indices: gridIndices(TILE_GRID, TILE_GRID) };
};

type TileId = { level: number; row: number; col: number };
const tileKey = ({ level, row, col }: TileId) => `${level}/${row}/${col}`;
// Sample points along each side of a tile, for its size on screen.
const SAMPLES = 5;
// Screen pixels per texel past which a tile is replaced by its children.
const MAX_MAGNIFICATION = 1.5;

// The tiles to draw: the ones on screen whose texels are no bigger than
// MAX_MAGNIFICATION pixels, or at maxLevel.
const selectTiles = (map: maplibregl.Map, tiles: PolarTiles, pole: Pole, edge: number) => {
  // The cap's radius.
  const reach = stereoRho(tiles, edge);
  const { width, height } = map.transform;
  const selected: TileId[] = [];
  const visit = (level: number, row: number, col: number) => {
    const { size, left, top } = tileBounds(tiles, level, row, col);
    // The part of the tile within the cap's bounding square.
    const [x0, x1] = [Math.max(left, -reach), Math.min(left + size, reach)];
    const [y0, y1] = [Math.max(top - size, -reach), Math.min(top, reach)];
    if (x0 >= x1 || y0 >= y1) return;
    if (Math.hypot(Math.min(Math.max(0, x0), x1), Math.min(Math.max(0, y0), y1)) > reach) return;
    const points: maplibregl.Point[][] = [];
    let visible = false;
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let j = 0; j < SAMPLES; j++) {
      points.push([]);
      for (let i = 0; i < SAMPLES; i++) {
        const [lat, lon] = stereoInverse(
          tiles,
          pole,
          x0 + ((x1 - x0) * i) / (SAMPLES - 1),
          y1 - ((y1 - y0) * j) / (SAMPLES - 1),
        );
        const lngLat = { lng: lon, lat: signed(pole, lat) } as maplibregl.LngLat;
        visible ||= !map.transform.isLocationOccluded(lngLat);
        const p = map.project(lngLat);
        points[j].push(p);
        [minX, minY, maxX, maxY] = [
          Math.min(minX, p.x),
          Math.min(minY, p.y),
          Math.max(maxX, p.x),
          Math.max(maxY, p.y),
        ];
      }
    }
    if (!visible || maxX < 0 || minX > width || maxY < 0 || minY > height) return;
    // Pixels per texel along the grid's longest row or column on screen.
    let magnification = 0;
    for (let j = 0; j < SAMPLES; j++) {
      let rowLength = 0;
      let colLength = 0;
      for (let i = 1; i < SAMPLES; i++) {
        rowLength += points[j][i].dist(points[j][i - 1]);
        colLength += points[i][j].dist(points[i - 1][j]);
      }
      magnification = Math.max(
        magnification,
        rowLength / ((256 * (x1 - x0)) / size),
        colLength / ((256 * (y1 - y0)) / size),
      );
    }
    if (level < tiles.maxLevel && magnification > MAX_MAGNIFICATION) {
      for (const r of [0, 1]) for (const c of [0, 1]) visit(level + 1, row * 2 + r, col * 2 + c);
    } else {
      selected.push({ level, row, col });
    }
  };
  const { size } = tileBounds(tiles, tiles.minLevel, 0, 0);
  const index = (metres: number) => Math.floor(metres / size);
  const [originX, originY] = tiles.origin;
  for (
    let row = index(originY - tiles.falseNorthing - reach);
    row <= index(originY - tiles.falseNorthing + reach);
    row++
  ) {
    for (
      let col = index(tiles.falseEasting - reach - originX);
      col <= index(tiles.falseEasting + reach - originX);
      col++
    ) {
      visit(tiles.minLevel, row, col);
    }
  }
  return selected;
};

const VERTEX_SOURCE = `
in vec2 a_pos;
in vec2 a_uv;
in float a_lat;
uniform vec3 u_uv_transform;
out vec2 v_uv;
out float v_lat;
void main() {
  v_uv = a_uv * u_uv_transform.x + u_uv_transform.yz;
  v_lat = a_lat;
  gl_Position = projectTile(a_pos);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D u_image;
// |Latitudes| over which the cap fades in; none if they are equal.
uniform vec2 u_fade;
// A mipmap bias for a blurred copy, and how much of it to blend in.
uniform vec2 u_generalise;
in vec2 v_uv;
in float v_lat;
out vec4 fragColor;
void main() {
  float alpha = u_fade.y > u_fade.x ? clamp((v_lat - u_fade.x) / (u_fade.y - u_fade.x), 0.0, 1.0) : 1.0;
  if (alpha <= 0.0) discard;
  vec4 texel = texture(u_image, v_uv);
  if (u_generalise.y > 0.0) texel = mix(texel, texture(u_image, v_uv, u_generalise.x), u_generalise.y);
  // Premultiplied, with the texture's own transparency (labels).
  fragColor = vec4(texel.rgb * texel.a * alpha, texel.a * alpha);
}`;

const compile = (gl: WebGL2RenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(`Polar cap shader: ${gl.getShaderInfoLog(shader)}`);
  return shader;
};

type Program = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };
type Mesh = { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; count: number };
type TileEntry = { image?: HTMLImageElement; texture?: WebGLTexture; mesh?: Mesh; frame: number };
type Fade = [number, number];
// A colour cap's textures are [map zoom, texture] steps, as PolarCap colors.
type ColorCap = { kind: "colors"; textures: [number, WebGLTexture][]; mesh: Mesh };
type TileCap = { kind: "tiles"; tiles: PolarTiles; entries: Map<string, TileEntry> };
type Cap = ColorCap | TileCap;
// Tiles kept per pole (~350 KB of texture each, with mipmaps) before the
// least recently drawn are dropped, apart from the minLevel ones.
const MAX_TILES = 120;

export type PolarCapsLayer = maplibregl.CustomLayerInterface & {
  setVisible: (visible: boolean) => void;
};

export const createPolarCapsLayer = (
  id: string,
  config: Partial<Record<Pole, PolarCap>>,
): PolarCapsLayer => {
  const poles = POLES.filter((pole) => config[pole]);
  let visible = true;
  let map: maplibregl.Map | null = null;
  let gl: WebGL2RenderingContext | null = null;
  const programs = new Map<string, Program>();
  const caps: Partial<Record<Pole, Cap>> = {};
  let frame = 0;

  const getProgram = (shaderData: maplibregl.CustomRenderMethodInput["shaderData"]) => {
    const cached = programs.get(shaderData.variantName);
    if (cached || !gl) return cached;
    const vertexSource = `#version 300 es
${shaderData.vertexShaderPrelude}
${shaderData.define}
${VERTEX_SOURCE}`;
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE));
    gl.bindAttribLocation(program, 0, "a_pos");
    gl.bindAttribLocation(program, 1, "a_uv");
    gl.bindAttribLocation(program, 2, "a_lat");
    gl.linkProgram(program);
    const uniforms = Object.fromEntries(
      [
        "u_projection_matrix",
        "u_projection_fallback_matrix",
        "u_projection_tile_mercator_coords",
        "u_projection_clipping_plane",
        "u_projection_transition",
        "u_image",
        "u_uv_transform",
        "u_fade",
        "u_generalise",
      ].map((name) => [name, gl!.getUniformLocation(program, name)]),
    );
    const entry = { program, uniforms };
    programs.set(shaderData.variantName, entry);
    return entry;
  };

  const createMesh = ({ vertices, indices }: MeshData): Mesh => {
    const context = gl!;
    const vao = context.createVertexArray()!;
    context.bindVertexArray(vao);
    const vertexBuffer = context.createBuffer()!;
    context.bindBuffer(context.ARRAY_BUFFER, vertexBuffer);
    context.bufferData(context.ARRAY_BUFFER, vertices, context.STATIC_DRAW);
    context.enableVertexAttribArray(0);
    context.vertexAttribPointer(0, 2, context.FLOAT, false, 20, 0);
    context.enableVertexAttribArray(1);
    context.vertexAttribPointer(1, 2, context.FLOAT, false, 20, 8);
    context.enableVertexAttribArray(2);
    context.vertexAttribPointer(2, 1, context.FLOAT, false, 20, 16);
    const indexBuffer = context.createBuffer()!;
    context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, indexBuffer);
    context.bufferData(context.ELEMENT_ARRAY_BUFFER, indices, context.STATIC_DRAW);
    context.bindVertexArray(null);
    return { vao, buffers: [vertexBuffer, indexBuffer], count: indices.length };
  };

  const deleteMesh = (mesh: Mesh) => {
    gl?.deleteVertexArray(mesh.vao);
    for (const buffer of mesh.buffers) gl?.deleteBuffer(buffer);
  };

  const createTexture = (source: TexImageSource) => {
    const context = gl!;
    const texture = context.createTexture()!;
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, texture);
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
    context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    context.texImage2D(
      context.TEXTURE_2D,
      0,
      context.RGBA,
      context.RGBA,
      context.UNSIGNED_BYTE,
      source,
    );
    context.generateMipmap(context.TEXTURE_2D);
    context.texParameteri(
      context.TEXTURE_2D,
      context.TEXTURE_MIN_FILTER,
      context.LINEAR_MIPMAP_LINEAR,
    );
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    // The caps are seen at grazing angles, where plain mipmapping blurs.
    const anisotropic = context.getExtension("EXT_texture_filter_anisotropic");
    if (anisotropic) {
      context.texParameterf(
        context.TEXTURE_2D,
        anisotropic.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, context.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT)),
      );
    }
    return texture;
  };

  // One pixel of a colour, as a texture.
  const colorTexture = (color: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return createTexture(canvas);
  };

  const createCap = (pole: Pole): Cap => {
    const cap = config[pole]!;
    if ("tiles" in cap) return { kind: "tiles", tiles: cap.tiles, entries: new Map() };
    return {
      kind: "colors",
      textures: cap.colors.map(([zoom, color]): [number, WebGLTexture] => [
        zoom,
        colorTexture(color),
      ]),
      mesh: createMesh(capMesh(pole, EDGE - MAX_FADE_DEGREES)),
    };
  };

  const deleteEntry = (entry: TileEntry) => {
    if (entry.texture) gl?.deleteTexture(entry.texture);
    if (entry.mesh) deleteMesh(entry.mesh);
  };

  const deleteCap = (cap: Cap | undefined) => {
    if (cap?.kind === "colors") {
      for (const [, texture] of cap.textures) gl?.deleteTexture(texture);
      deleteMesh(cap.mesh);
    } else if (cap) {
      cap.entries.forEach(deleteEntry);
    }
  };

  const requestTile = (cap: TileCap, tile: TileId) => {
    const key = tileKey(tile);
    const existing = cap.entries.get(key);
    if (existing) return existing;
    const entry: TileEntry = { frame };
    // A failed tile is left without an image, and drawn from its ancestor.
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      entry.image = image;
      map?.triggerRepaint();
    };
    image.src = cap.tiles.url
      .replace("{z}", String(tile.level))
      .replace("{y}", String(tile.row))
      .replace("{x}", String(tile.col));
    cap.entries.set(key, entry);
    return entry;
  };

  // Screen pixels per degree of latitude at the cap's edge, along the
  // meridian facing the camera.
  const pixelsPerDegree = (pole: Pole) => {
    const { lng } = map!.getCenter();
    return map!
      .project([lng, signed(pole, EDGE)])
      .dist(map!.project([lng, signed(pole, EDGE - 1)]));
  };
  // The |latitudes| a cap fades in over.
  const fadeRange = (pole: Pole): Fade => [
    EDGE -
      Math.min(Math.max(FADE_PIXELS / pixelsPerDegree(pole), MIN_FADE_DEGREES), MAX_FADE_DEGREES),
    EDGE,
  ];

  // Draws each tile with its own texture once loaded, and until then with
  // the part of its nearest loaded ancestor that it covers.
  const drawTiles = (pole: Pole, cap: TileCap, uniforms: Program["uniforms"]) => {
    const context = gl!;
    const { tiles } = cap;
    // A sharp edge is a fade too narrow to see.
    const fade: Fade = tiles.sharpEdge ? [EDGE - 1e-4, EDGE] : fadeRange(pole);
    context.uniform2f(uniforms.u_fade, ...fade);
    const { generalise } = tiles;
    if (generalise) {
      const [full, none] = generalise.pixelsPerDegree;
      const share = Math.min(Math.max((none - pixelsPerDegree(pole)) / (none - full), 0), 1);
      context.uniform2f(uniforms.u_generalise, generalise.bias, generalise.weight * share);
    } else {
      context.uniform2f(uniforms.u_generalise, 0, 0);
    }
    selectTiles(map!, tiles, pole, fade[0]).forEach((tile) => {
      const entry = requestTile(cap, tile);
      entry.mesh ||= createMesh(tileMesh(tiles, pole, tile.level, tile.row, tile.col));
      for (let level = tile.level; level >= tiles.minLevel; level--) {
        const shift = tile.level - level;
        const ancestor = { level, row: tile.row >> shift, col: tile.col >> shift };
        // The top-level ancestor is always requested, as the fallback.
        const source =
          level === tile.level
            ? entry
            : level === tiles.minLevel
              ? requestTile(cap, ancestor)
              : cap.entries.get(tileKey(ancestor));
        if (!source) continue;
        source.frame = frame;
        if (source.image && !source.texture) source.texture = createTexture(source.image);
        if (!source.texture) continue;
        const scale = 1 / 2 ** shift;
        context.uniform3f(
          uniforms.u_uv_transform,
          scale,
          (tile.col - (ancestor.col << shift)) * scale,
          (tile.row - (ancestor.row << shift)) * scale,
        );
        context.bindTexture(context.TEXTURE_2D, source.texture);
        context.bindVertexArray(entry.mesh.vao);
        context.drawElements(context.TRIANGLES, entry.mesh.count, context.UNSIGNED_SHORT, 0);
        break;
      }
      entry.frame = frame;
    });
    if (cap.entries.size > MAX_TILES) {
      [...cap.entries.entries()]
        .filter(([key, entry]) => entry.frame < frame && !key.startsWith(`${tiles.minLevel}/`))
        .sort(([, a], [, b]) => a.frame - b.frame)
        .slice(0, cap.entries.size - MAX_TILES)
        .forEach(([key, entry]) => {
          deleteEntry(entry);
          cap.entries.delete(key);
        });
    }
  };

  const drawColors = (pole: Pole, cap: ColorCap, uniforms: Program["uniforms"]) => {
    const context = gl!;
    context.uniform3f(uniforms.u_uv_transform, 1, 0, 0);
    context.uniform2f(uniforms.u_fade, ...fadeRange(pole));
    context.uniform2f(uniforms.u_generalise, 0, 0);
    const zoom = map!.getZoom();
    const [, texture] = cap.textures.filter(([from]) => from <= zoom).pop() ?? cap.textures[0];
    context.bindTexture(context.TEXTURE_2D, texture);
    context.bindVertexArray(cap.mesh.vao);
    context.drawElements(context.TRIANGLES, cap.mesh.count, context.UNSIGNED_SHORT, 0);
  };

  return {
    id,
    type: "custom",
    renderingMode: "2d",
    // GL objects are created and changed only in render(): MapLibre caches GL
    // state and resets its cache just around that call.
    onAdd(m, context) {
      // MapLibre 5 renders with WebGL2; the caps are skipped otherwise.
      if (
        typeof WebGL2RenderingContext === "undefined" ||
        !(context instanceof WebGL2RenderingContext)
      )
        return;
      map = m;
      gl = context;
    },
    render(_context, args) {
      if (!gl || !map || !visible) return;
      frame++;
      poles.forEach((pole) => {
        caps[pole] ||= createCap(pole);
      });
      const program = getProgram(args.shaderData);
      if (!program) return;
      const { uniforms: u } = program;
      const data = args.defaultProjectionData;
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
      gl.useProgram(program.program);
      gl.uniformMatrix4fv(u.u_projection_matrix, false, data.mainMatrix as Float32Array);
      gl.uniformMatrix4fv(
        u.u_projection_fallback_matrix,
        false,
        data.fallbackMatrix as Float32Array,
      );
      gl.uniform4f(u.u_projection_tile_mercator_coords, ...data.tileMercatorCoords);
      gl.uniform4f(u.u_projection_clipping_plane, ...data.clippingPlane);
      gl.uniform1f(u.u_projection_transition, data.projectionTransition);
      gl.uniform1i(u.u_image, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.disable(gl.CULL_FACE);
      // Premultiplied, as MapLibre blends.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      poles.forEach((pole) => {
        const cap = caps[pole]!;
        if (cap.kind === "tiles") drawTiles(pole, cap, u);
        else drawColors(pole, cap, u);
      });
      gl.bindVertexArray(null);
    },
    onRemove() {
      if (!gl) return;
      POLES.forEach((pole) => {
        deleteCap(caps[pole]);
        delete caps[pole];
      });
      for (const { program } of programs.values()) gl?.deleteProgram(program);
      programs.clear();
      gl = null;
      map = null;
    },
    setVisible(next) {
      visible = next;
      map?.triggerRepaint();
    },
  };
};
