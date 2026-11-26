/* Dense home-page stars. The catalogue and the subpixel disc masks are static
 * GPU data; a frame changes only the camera, orbit and lighting uniforms. */
(() => {
  'use strict';

  const vertex = `
    precision highp float;
    attribute vec4 a_star;       // CSS x, y, radius, depth
    attribute vec4 a_sprite;     // light, atlas tile origin, phases per axis
    attribute vec2 a_corner;     // quad corner in [0, 1]
    uniform vec2 u_stage, u_buffer;
    uniform float u_dpr, u_margin;
    uniform vec4 u_camera, u_previousCamera; // zoom, anchor x/y, drift seconds
    uniform vec2 u_pointer, u_previousPointer;
    uniform vec2 u_pan;          // CSS px the sky has turned down, now and before
    uniform float u_trails, u_amount, u_gain;
    uniform vec4 u_quiet;        // padded CSS bounds; inverted when absent
    varying vec3 v_tile;
    varying vec2 v_maskPixel, v_phase;
    varying vec2 v_local, v_direction; // device pixels in the trail's local axes
    varying float v_alpha, v_radius, v_length;

    vec2 position(vec4 camera, vec2 pointer, float pan, out vec2 cell) {
      float depth = a_star.w;
      float speed = u_stage.y * 0.0069 * mix(1.0, 0.3, (depth - 0.04) / 0.40);
      // A turning camera moves every star alike; the period brings new ones in.
      vec2 p = a_star.xy + vec2(-0.832, 0.555) * (speed * camera.w) + vec2(0.0, pan);
      vec2 period = 1.12 * u_stage;
      cell = floor((p + 0.06 * u_stage) / period);
      p -= cell * period;
      return p + (p - camera.yz) * ((camera.x - 1.0) * depth)
               + pointer * (vec2(7.0, 5.0) - vec2(30.0, 22.0) * depth);
    }

    void main() {
      vec2 cell, previousCell;
      vec2 p = position(u_camera, u_pointer, u_pan.x, cell);
      vec2 from = position(u_previousCamera, u_previousPointer, u_pan.y, previousCell);
      vec2 delta = p - from;
      float travel = length(delta);
      bool trail = u_trails > 0.0 && all(equal(cell, previousCell)) && travel > 1.2 && travel < 90.0;
      v_alpha = min(1.0, a_sprite.x * u_gain);
      if (u_amount < 1.0 && u_quiet.x <= u_quiet.z) {
        float outside = length(max(max(u_quiet.xy - p, p - u_quiet.zw), vec2(0.0)));
        v_alpha *= 1.0 - 0.85 * max(0.0, 1.0 - outside / 16.0) * (1.0 - u_amount);
      }
      v_alpha = floor(v_alpha * (trail ? 0.85 : 1.0) * 255.0 + 0.5) / 255.0;
      v_radius = a_star.z * u_dpr * (trail ? 0.85 : 1.0);
      v_length = trail ? travel * u_dpr : 0.0;
      vec2 direction = trail ? delta / travel : vec2(1.0, 0.0);
      v_direction = direction;
      vec2 normal = vec2(-direction.y, direction.x);
      float margin = v_radius + 1.5;
      v_local = mix(vec2(-margin), vec2(v_length + margin, margin), a_corner);
      vec2 pixel = (trail ? from : p) * u_dpr + direction * v_local.x + normal * v_local.y;
      vec2 original = a_star.xy * u_dpr;
      vec2 shift = p * u_dpr - original;
      v_tile = a_sprite.yzw;
      vec2 marginInTile = u_margin + mod(floor(original) - u_margin, 2.0);
      v_maskPixel = pixel - floor(original) - 2.0 * floor(shift * 0.5) + marginInTile;
      v_phase = mod(shift, 2.0) * (0.5 * v_tile.z);
      vec2 clip = pixel / u_buffer * vec2(2.0, -2.0) + vec2(-1.0, 1.0);
      if (p.x < -8.0 || p.y < -8.0 || p.x > u_stage.x + 8.0 || p.y > u_stage.y + 8.0)
        clip = vec2(2.0);
      gl_Position = vec4(clip, 0.0, 1.0);
    }`;

  const fragment = `
    precision highp float;
    uniform sampler2D u_atlas;
    uniform vec2 u_atlasSize;
    uniform float u_tileSize;
    uniform vec3 u_color;
    varying vec3 v_tile;
    varying vec2 v_maskPixel, v_phase, v_local, v_direction;
    varying float v_alpha, v_radius, v_length;

    float discMask(vec2 phase) {
      // The last phase wraps to the next two-pixel sampling pattern.
      vec2 pixel = v_maskPixel - 2.0 * floor(phase / v_tile.z);
      if (any(lessThan(pixel, vec2(0.0))) || any(greaterThanEqual(pixel, vec2(u_tileSize)))) return 0.0;
      vec2 tile = v_tile.xy + mod(phase, v_tile.z) * u_tileSize;
      return texture2D(u_atlas, (tile + pixel) / u_atlasSize).a;
    }
    float strokeSample(vec2 offset) {
      vec2 normal = vec2(-v_direction.y, v_direction.x);
      vec2 p = v_local + vec2(dot(offset, v_direction), dot(offset, normal));
      p.x -= clamp(p.x, 0.0, v_length);
      return clamp(0.5 + 8.0 * (v_radius - length(p)), 0.0, 1.0);
    }
    void main() {
      float coverage;
      if (v_length > 0.0) {
        // Resolve a round capsule on a rotated four-sample grid, as for a
        // multisampled Canvas stroke. Keep a narrow soft edge per sample.
        coverage = 0.25 * (strokeSample(vec2(-0.125, -0.375)) + strokeSample(vec2(0.375, -0.125))
                         + strokeSample(vec2(-0.375, 0.125)) + strokeSample(vec2(0.125, 0.375)));
      } else {
        vec2 phase = floor(v_phase), blend = fract(v_phase);
        coverage = mix(mix(discMask(phase), discMask(phase + vec2(1, 0)), blend.x),
                       mix(discMask(phase + vec2(0, 1)), discMask(phase + 1.0), blend.x), blend.y);
      }
      float alpha = v_alpha * coverage;
      gl_FragColor = vec4(u_color * alpha, alpha);
    }`;

  function programFor(gl) {
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(message);
    }
    return program;
  }

  // Some rasterizers quantize a curve differently at distant device coordinates.
  // Fill the catalogue phase of the atlas at the original viewport coordinates.
  // Disjoint groups let overlapping discs keep independent masks for later motion.
  function copyCatalogueMasks(atlas, masks, tile, w, h, dpr) {
    const source = document.createElement('canvas');
    source.width = w;
    source.height = h;
    const ctx = source.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'white';
    atlas.resetTransform();
    atlas.imageSmoothingEnabled = false;
    const groups = [];
    for (const mask of masks) {
      let group = groups.find(batch => batch.every(other =>
        Math.abs(mask.x - other.x) >= tile || Math.abs(mask.y - other.y) >= tile));
      if (!group) groups.push(group = []);
      group.push(mask);
    }
    for (const group of groups) {
      ctx.clearRect(0, 0, w / dpr, h / dpr);
      for (const { star } of group) {
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.radius, 0, 2 * Math.PI);
        ctx.fill();
      }
      for (const { x, y, left, top } of group) {
        // Keep the baked off-screen half of masks that straddle a stage edge.
        const sx = Math.max(0, x), sy = Math.max(0, y);
        const dw = Math.min(w, x + tile) - sx, dh = Math.min(h, y + tile) - sy;
        const dx = left + sx - x, dy = top + sy - y;
        atlas.clearRect(dx, dy, dw, dh);
        atlas.drawImage(source, sx, sy, dw, dh, dx, dy, dw, dh);
      }
    }
    source.width = source.height = 1;
  }

  class StarField {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
      if (!gl) throw new Error('Star field WebGL unavailable');
      this.gl = gl;
      const program = programFor(gl);
      gl.useProgram(program);
      this.u = {};
      for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
        const { name } = gl.getActiveUniform(program, i);
        this.u[name] = gl.getUniformLocation(program, name);
      }
      this.buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      for (const [name, size, offset] of [['a_star', 4, 0], ['a_sprite', 4, 16], ['a_corner', 2, 32]]) {
        const attribute = gl.getAttribLocation(program, name);
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute, size, gl.FLOAT, false, 40, offset);
      }
      this.texture = gl.createTexture();
      this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DITHER);
      this.tones = [false, true].map(day => {
        const { color, gain } = window.StarSky.tone({ day });
        return { color: color.split(',').map(channel => Number(channel) / 255), gain };
      });
    }

    get lost() { return this.gl.isContextLost(); }

    // Only at a handoff to 2D: freeze the GPU orbit in the shared CSS coordinate
    // system so that the existing ink/fallback draw loop can take over in place.
    static freezeCatalogue(stars, width, height, time) {
      if (!width || !height) return [];
      const wrap = (p, size) => p - Math.floor((p + 0.06 * size) / (1.12 * size)) * (1.12 * size);
      return stars.map(star => {
        const travel = time * 0.0069 * height * (1 - 0.7 * (star.depth - 0.04) / 0.40);
        return { ...star, x: wrap(star.x - 0.832 * travel, width), y: wrap(star.y + 0.555 * travel, height), lastX: NaN, lastY: NaN };
      });
    }

    resize(width, height, dpr, stars) {
      if (this.lost) return;
      if (this.width === width && this.height === height && this.dpr === dpr && this.stars === stars) return;
      this.width = width;
      this.height = height;
      this.dpr = dpr;
      this.stars = stars;
      this.resetHistory();
      if (!width || !height) return;
      const gl = this.gl, u = this.u;
      const w = Math.round(width * dpr), h = Math.round(height * dpr);
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(u.u_stage, width, height);
      gl.uniform2f(u.u_buffer, w, h);
      gl.uniform1f(u.u_dpr, dpr);

      // A browser's antialiasing of tiny arcs can differ visibly from an
      // ideal circle. Sample its native coverage at the catalogue's exact
      // subpixel phase plus fractional offsets, once per layout. Keep the
      // two-pixel MSAA sample pattern aligned with the original canvas. On the
      // GPU, interpolate neighbouring phases as each particle crosses a pixel.
      const margin = Math.ceil(1.55 * dpr + 0.5), tile = 2 * margin + 4;
      const columns = Math.max(1, Math.ceil(Math.sqrt(stars.length)));
      const maxPhases = Math.floor(this.maxTextureSize / (columns * tile));
      if (!maxPhases) throw new Error('Star disc atlas exceeds the WebGL texture limit');
      // Spend the finer phase samples on the most visible stars. Pack equal
      // sprite sizes together; the order of stars in the draw stays unchanged.
      const slots = stars.map(({ light }, index) => ({
        index, phases: Math.min(maxPhases, light > 0.5 ? 12 : light > 0.25 ? 8 : 4),
      })).sort((a, b) => b.phases - a.phases);
      const area = slots.reduce((sum, slot) => sum + (tile * slot.phases) ** 2, 0);
      const largest = tile * (slots[0]?.phases || 1);
      const rowWidth = Math.min(this.maxTextureSize, Math.ceil(Math.sqrt(area)) + largest);
      let left = 0, top = 0, rowHeight = 0, usedWidth = 0;
      for (const slot of slots) {
        const side = slot.phases * tile;
        if (left + side > rowWidth) { top += rowHeight; rowHeight = 0; left = 0; }
        slot.left = left;
        slot.top = top;
        left += side;
        rowHeight = Math.max(rowHeight, side);
        usedWidth = Math.max(usedWidth, left);
      }
      const atlas = document.createElement('canvas');
      atlas.width = Math.max(1, usedWidth);
      atlas.height = Math.max(1, top + rowHeight);
      const ctx = atlas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = 'white';
      const data = new Float32Array(stars.length * 6 * 10);
      const corners = [[0, 0], [1, 0], [0, 1], [0, 1], [1, 0], [1, 1]];
      const masks = [];
      for (const { index, phases, left, top } of slots) {
        const star = stars[index];
        const x = left + margin + (star.x * dpr - margin - 2 * Math.floor((star.x * dpr - margin) / 2));
        const y = top + margin + (star.y * dpr - margin - 2 * Math.floor((star.y * dpr - margin) / 2));
        const sx = 2 * Math.floor((star.x * dpr - margin) / 2);
        const sy = 2 * Math.floor((star.y * dpr - margin) / 2);
        if (sx < w && sy < h && sx + tile > 0 && sy + tile > 0) masks.push({ x: sx, y: sy, left, top, star });
        const pitch = tile + 2 / phases;
        for (let row = 0; row < phases; row++) {
          for (let col = 0; col < phases; col++) {
            ctx.beginPath();
            ctx.arc((x + col * pitch) / dpr, (y + row * pitch) / dpr, star.radius, 0, 2 * Math.PI);
            ctx.fill();
          }
        }
        for (let j = 0; j < 6; j++) {
          data.set([star.x, star.y, star.radius, star.depth, star.light, left, top, phases, ...corners[j]], (6 * index + j) * 10);
        }
      }
      copyCatalogueMasks(ctx, masks, tile, w, h, dpr);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, gl.ALPHA, gl.UNSIGNED_BYTE, atlas);
      gl.uniform2f(u.u_atlasSize, atlas.width, atlas.height);
      gl.uniform1f(u.u_tileSize, tile);
      gl.uniform1f(u.u_margin, margin);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    }

    resetHistory() { this.previous = null; }

    render(state) {
      if (this.lost || !this.width || !this.height || !this.stars) return false;
      const previous = this.previous || state;
      if (this.previous && Object.keys(state).every(key => previous[key] === state[key])) return true;
      const gl = this.gl, u = this.u;
      gl.uniform4f(u.u_camera, state.zoom, state.anchorX, state.anchorY, state.time);
      gl.uniform4f(u.u_previousCamera, previous.zoom, previous.anchorX, previous.anchorY, previous.time);
      gl.uniform2f(u.u_pointer, state.pointerX, state.pointerY);
      gl.uniform2f(u.u_previousPointer, previous.pointerX, previous.pointerY);
      gl.uniform2f(u.u_pan, state.pan || 0, previous.pan || 0);
      gl.uniform1f(u.u_trails, this.previous && state.introMoving ? 1 : 0);
      gl.uniform1f(u.u_amount, state.amount);
      const quiet = state.quiet;
      if (quiet) gl.uniform4f(u.u_quiet, quiet.left - 8, quiet.top - 6, quiet.left + quiet.width + 8, quiet.top + quiet.height + 6);
      else gl.uniform4f(u.u_quiet, 1, 1, 0, 0);
      const tone = this.tones[Number(state.day)];
      gl.uniform3fv(u.u_color, tone.color);
      gl.uniform1f(u.u_gain, tone.gain * state.fade);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, this.stars.length * 6);
      this.previous = { ...state };
      return true;
    }
  }

  window.StarField = StarField;
})();
