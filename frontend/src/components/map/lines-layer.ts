import type maplibregl from "maplibre-gl";

// Lines drawn over the basemap on every view, including past Web Mercator's
// ±85.05°, where MapLibre's own line layers (from GeoJSON tiles) move them to
// its edge: paleomagnetic poles and their uncertainty ellipses crowd the
// geographic poles. Like the polar caps (see polar-caps.ts), each vertex goes
// through MapLibre's own projection code, whose Mercator-to-sphere step has no
// latitude limit and which clips the far side of the globe. Each segment is a
// quad widened across its direction on screen, with a pixel of antialiasing
// at its edges.

export type MapLine = {
  /** [lon, lat] vertices; a line may cross the antimeridian. */
  coords: [number, number][];
  color: string;
  /** In CSS pixels. */
  width?: number;
  opacity?: number;
};

// Mercator y is infinite at the pole itself.
const MAX_LAT = 89.99;
const mercatorX = (lon: number) => (lon + 180) / 360;
const mercatorY = (lat: number) => {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / (2 * Math.PI);
};

const parseColor = (color: string): [number, number, number] => {
  const hex = color.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex))
    return [0, 1, 2].map((i) => Number.parseInt(hex[i] + hex[i], 16) / 255) as [
      number,
      number,
      number,
    ];
  if (/^[0-9a-f]{6}/i.test(hex))
    return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
  const rgb = color.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const [r, g, b] = rgb[1].split(",").map((v) => Number(v) / 255);
    return [r, g, b];
  }
  return [0, 0, 0];
};

// Per vertex: start (2), end (2), corner (side ±1, which end 0|1) (2),
// premultiplied colour (4), width (1).
const STRIDE = 11;

const buildMesh = (lines: MapLine[]) => {
  let segments = 0;
  for (const line of lines) segments += Math.max(0, line.coords.length - 1);
  const vertices = new Float32Array(segments * 4 * STRIDE);
  const indices = new Uint32Array(segments * 6);
  let v = 0;
  let i = 0;
  let quad = 0;
  for (const line of lines) {
    const [r, g, b] = parseColor(line.color);
    const a = line.opacity ?? 1;
    const width = line.width ?? 2;
    // Continuous longitudes, so a segment across the antimeridian is short.
    let lon = line.coords[0]?.[0] ?? 0;
    let prev: [number, number] | null = null;
    for (const [rawLon, lat] of line.coords) {
      lon += ((((rawLon - lon) % 360) + 540) % 360) - 180;
      const point: [number, number] = [mercatorX(lon), mercatorY(lat)];
      if (prev) {
        for (const [side, end] of [
          [1, 0],
          [-1, 0],
          [1, 1],
          [-1, 1],
        ]) {
          vertices.set(
            [prev[0], prev[1], point[0], point[1], side, end, r * a, g * a, b * a, a, width],
            v,
          );
          v += STRIDE;
        }
        const base = quad * 4;
        indices.set([base, base + 1, base + 2, base + 1, base + 3, base + 2], i);
        i += 6;
        quad++;
      }
      prev = point;
    }
  }
  return { vertices, indices };
};

const VERTEX_SOURCE = `
in vec2 a_start;
in vec2 a_end;
in vec2 a_corner;
in vec4 a_color;
in float a_width;
uniform vec2 u_viewport;
uniform float u_pixel_ratio;
uniform float u_world_offset;
out vec4 v_color;
out float v_distance;
out float v_half_width;
void main() {
  vec4 start = projectTile(a_start + vec2(u_world_offset, 0.0));
  vec4 end = projectTile(a_end + vec2(u_world_offset, 0.0));
  vec4 position = a_corner.y > 0.5 ? end : start;
  vec2 direction = (end.xy / end.w - start.xy / start.w) * u_viewport;
  float len = length(direction);
  direction = len > 0.0 ? direction / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-direction.y, direction.x);
  v_half_width = a_width * u_pixel_ratio / 2.0;
  // Out to half the width and a pixel more, for the antialiased edge.
  v_distance = a_corner.x * (v_half_width + 1.0);
  position.xy += normal * v_distance * 2.0 / u_viewport * position.w;
  gl_Position = position;
  v_color = a_color;
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec4 v_color;
in float v_distance;
in float v_half_width;
out vec4 fragColor;
void main() {
  float alpha = clamp(v_half_width + 0.5 - abs(v_distance), 0.0, 1.0);
  if (alpha <= 0.0) discard;
  fragColor = v_color * alpha;
}`;

const ATTRIBUTES: [string, number, number][] = [
  ["a_start", 2, 0],
  ["a_end", 2, 2],
  ["a_corner", 2, 4],
  ["a_color", 4, 6],
  ["a_width", 1, 10],
];

const compile = (gl: WebGL2RenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(`Lines shader: ${gl.getShaderInfoLog(shader)}`);
  return shader;
};

type Program = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };
type Mesh = { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; count: number };

export type LinesLayer = maplibregl.CustomLayerInterface & { setLines: (lines: MapLine[]) => void };

/** A custom layer drawing `MapLine`s; `flat` repeats them on the Mercator
 * map's world copies either side. */
export const createLinesLayer = (id: string, flat: boolean): LinesLayer => {
  let map: maplibregl.Map | null = null;
  let gl: WebGL2RenderingContext | null = null;
  const programs = new Map<string, Program>();
  let lines: MapLine[] = [];
  let dirty = true;
  let mesh: Mesh | null = null;

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
    ATTRIBUTES.forEach(([name], index) => {
      gl!.bindAttribLocation(program, index, name);
    });
    gl.linkProgram(program);
    const uniforms = Object.fromEntries(
      [
        "u_projection_matrix",
        "u_projection_fallback_matrix",
        "u_projection_tile_mercator_coords",
        "u_projection_clipping_plane",
        "u_projection_transition",
        "u_viewport",
        "u_pixel_ratio",
        "u_world_offset",
      ].map((name) => [name, gl!.getUniformLocation(program, name)]),
    );
    const entry = { program, uniforms };
    programs.set(shaderData.variantName, entry);
    return entry;
  };

  const deleteMesh = () => {
    if (!mesh || !gl) return;
    gl.deleteVertexArray(mesh.vao);
    for (const buffer of mesh.buffers) gl.deleteBuffer(buffer);
    mesh = null;
  };

  const createMesh = () => {
    const context = gl!;
    const { vertices, indices } = buildMesh(lines);
    if (!indices.length) return null;
    const vao = context.createVertexArray()!;
    context.bindVertexArray(vao);
    const vertexBuffer = context.createBuffer()!;
    context.bindBuffer(context.ARRAY_BUFFER, vertexBuffer);
    context.bufferData(context.ARRAY_BUFFER, vertices, context.STATIC_DRAW);
    ATTRIBUTES.forEach(([, size, offset], index) => {
      context.enableVertexAttribArray(index);
      context.vertexAttribPointer(index, size, context.FLOAT, false, STRIDE * 4, offset * 4);
    });
    const indexBuffer = context.createBuffer()!;
    context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, indexBuffer);
    context.bufferData(context.ELEMENT_ARRAY_BUFFER, indices, context.STATIC_DRAW);
    context.bindVertexArray(null);
    return { vao, buffers: [vertexBuffer, indexBuffer], count: indices.length };
  };

  return {
    id,
    type: "custom",
    renderingMode: "2d",
    setLines(next) {
      lines = next;
      dirty = true;
      map?.triggerRepaint();
    },
    // GL objects are created and changed only in render(): MapLibre caches GL
    // state and resets its cache just around that call.
    onAdd(m, context) {
      // MapLibre 5 renders with WebGL2; the lines are skipped otherwise.
      if (
        typeof WebGL2RenderingContext === "undefined" ||
        !(context instanceof WebGL2RenderingContext)
      )
        return;
      map = m;
      gl = context;
    },
    render(_context, args) {
      if (!gl || !map) return;
      if (dirty) {
        deleteMesh();
        mesh = createMesh();
        dirty = false;
      }
      if (!mesh) return;
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
      gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(u.u_pixel_ratio, map.getPixelRatio());
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.DEPTH_TEST);
      // Premultiplied, as MapLibre blends.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(mesh.vao);
      for (const offset of flat ? [-1, 0, 1] : [0]) {
        gl.uniform1f(u.u_world_offset, offset);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);
    },
    onRemove() {
      deleteMesh();
      for (const { program } of programs.values()) gl?.deleteProgram(program);
      programs.clear();
      gl = null;
      map = null;
    },
  };
};
