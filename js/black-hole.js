/* A thin, optically thick disk around a Schwarzschild black hole.
 * Distances are in Schwarzschild radii (Rs = 1). The cartesian form of
 * the null-orbit equation is integrated with velocity Verlet:
 * d²r/dλ² = -3/2 |r × v|² r / |r|⁵.
 * This is a finite-step visual model, with an intentionally illustrated
 * emission palette; it is not a scientific radiative-transfer solver.
 */
(() => {
  'use strict';

  const vertexSource = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const sceneSource = `
    precision highp float;
    varying vec2 v_uv;
    uniform vec2 u_resolution;
    uniform vec4 u_crop;
    uniform vec2 u_pointer;
    uniform float u_time;
    #define PI 3.14159265359

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x),
                 mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
    }
    vec3 acceleration(vec3 p, float h2) {
      float r2 = dot(p, p);
      return -1.5 * h2 * p / (r2 * r2 * sqrt(r2));
    }
    vec3 diskEmission(vec3 p, vec3 ray) {
      float r = length(p.xz);
      float phi = atan(p.z, p.x);
      // Keplerian shear winds the features into fine, orbiting filaments.
      float phase = phi - u_time * 2.1 / pow(r, 1.5);
      // Periodic coordinates keep close-up filaments seamless across atan's wrap.
      vec2 orbit = vec2(cos(phase), sin(phase));
      float bands = noise(vec2(r * 9.0 + orbit.x * 1.2, orbit.y * 2.8));
      float detail = noise(vec2(r * 21.0 + orbit.x * 2.5, orbit.y * 6.0));
      float streakPhase = r * 27.0 + 3.0 * noise(vec2(r * 4.0 + orbit.x * 0.8, orbit.y * 4.0));
      float streak = sin(streakPhase);
      float ink = smoothstep(-0.50, 0.80, streak);
      #ifdef HAS_DERIVATIVES
        ink = mix(ink, 0.5, smoothstep(1.1, 3.0, fwidth(streakPhase)));
      #endif
      float texture = (0.44 + 0.65 * bands + 0.20 * detail) * (0.72 + 0.28 * ink);

      // Local orbital velocity; -ray is the emitted photon's direction.
      vec3 tangent = normalize(vec3(-p.z, 0.0, p.x));
      float beta = sqrt(0.5 / (r - 1.0));
      float doppler = sqrt(1.0 - beta * beta) /
        (1.0 - beta * dot(tangent, normalize(-ray)));
      float shift = doppler * sqrt(1.0 - 1.0 / r);
      float heat = pow(3.0 / r, 0.75) * pow(max(0.001, 1.0 - sqrt(3.0 / r)), 0.25);
      float observedHeat = heat * shift;

      // Stepped highlights and fine ink-like lanes give the light an anime finish.
      vec3 ember = vec3(0.94, 0.25, 0.075);
      vec3 gold = vec3(1.0, 0.66, 0.30);
      vec3 ivory = vec3(1.0, 0.93, 0.73);
      vec3 hot = vec3(0.88, 0.94, 1.0);
      vec3 color = mix(ember, gold, smoothstep(0.17, 0.33, observedHeat));
      color = mix(color, ivory, smoothstep(0.30, 0.49, observedHeat));
      color = mix(color, hot, smoothstep(0.52, 0.75, observedHeat) * 0.42);
      float innerEdge = smoothstep(3.0, 3.35, r);
      float outerEdge = 1.0 - smoothstep(8.0, 11.0, r);
      float energy = 2.25 * pow(3.0 / r, 1.6) * pow(shift, 3.0);
      return color * energy * texture * innerEdge * outerEdge;
    }
    vec3 distantStars(vec3 direction) {
      vec2 sky = vec2(atan(direction.z, direction.x), asin(clamp(direction.y, -1.0, 1.0)));
      vec2 grid = sky * 135.0;
      vec2 cell = floor(grid);
      float seed = hash(cell);
      vec2 center = vec2(hash(cell + 2.1), hash(cell + 7.8));
      float star = (1.0 - smoothstep(0.012, 0.075, length(fract(grid) - center))) * step(0.986, seed);
      return vec3(0.45, 0.53, 0.65) * star * 0.6;
    }
    void main() {
      float aspect = u_resolution.x / u_resolution.y;
      vec2 sceneUV = u_crop.xy + v_uv * u_crop.zw;
      vec2 screen = (sceneUV - vec2(0.50, 0.59)) * vec2(aspect, 1.0) * 2.0;
      screen -= u_pointer * vec2(0.012, 0.009);
      // Screen roll controls composition independently of the disk's 3D inclination.
      float screenRoll = 18.0 * PI / 180.0;
      screen = mat2(cos(screenRoll), -sin(screenRoll), sin(screenRoll), cos(screenRoll)) * screen;
      // Inclination is measured from the disk normal: 0° face-on, 90° edge-on.
      float diskInclination = 81.0 * PI / 180.0;
      float cameraDistance = 31.784430;
      vec3 origin = vec3(u_pointer.x * 0.8,
        cameraDistance * cos(diskInclination) + u_pointer.y * 0.55,
        cameraDistance * sin(diskInclination));
      vec3 forward = normalize(-origin);
      vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(right, forward);
      vec3 direction = normalize(forward * 2.08 + screen.x * right + screen.y * up);
      vec3 p = origin;
      vec3 v = direction;
      vec3 angular = cross(p, v);
      float h2 = dot(angular, angular);
      // These rays cannot reach the disk's outer radius, even after deflection.
      if (h2 > 140.0) {
        vec3 stars = distantStars(direction);
        gl_FragColor = vec4(stars, max(stars.r, max(stars.g, stars.b)));
        return;
      }
      vec3 emission = vec3(0.0);
      float alpha = 0.0;
      bool escaped = false;

      for (int i = 0; i < 180; i++) {
        float r = length(p);
        if (r < 1.015) { alpha = 1.0; break; }
        if (r > 42.0) { escaped = true; break; }
        float dt = clamp(r * 0.095, 0.055, 1.8);
        vec3 a = acceleration(p, h2);
        vec3 next = p + v * dt + 0.5 * a * dt * dt;
        vec3 nextV = v + 0.5 * (a + acceleration(next, h2)) * dt;

        if (p.y * next.y < 0.0) {
          float fraction = p.y / (p.y - next.y);
          vec3 hit = mix(p, next, fraction);
          float diskRadius = length(hit.xz);
          if (diskRadius > 3.0 && diskRadius < 11.0) {
            emission = diskEmission(hit, mix(v, nextV, fraction));
            alpha = 1.0 - smoothstep(9.0, 11.0, diskRadius);
            break;
          }
        }
        p = next;
        v = nextV;
      }
      if (escaped) {
        emission = distantStars(normalize(v));
        alpha = max(emission.r, max(emission.g, emission.b));
      }
      // Soft clipping preserves thin light lanes instead of flattening the disk.
      emission = 1.0 - exp(-emission * 1.65);
      gl_FragColor = vec4(emission, alpha);
    }
  `;

  const bloomSource = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_scene;
    uniform vec2 u_texel;
    void main() {
      vec3 light = vec3(0.0);
      float weights = 0.0;
      for (int i = -6; i <= 6; i++) {
        float x = float(i);
        float w = exp(-x * x / 16.0);
        vec3 c = texture2D(u_scene, v_uv + vec2(x * u_texel.x * 3.0, 0.0)).rgb;
        light += max(c - 0.22, 0.0) * w;
        weights += w;
      }
      gl_FragColor = vec4(light / weights, 1.0);
    }
  `;

  const compositeSource = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_scene;
    uniform sampler2D u_bloom;
    uniform vec2 u_texel;
    uniform vec4 u_crop;
    void main() {
      vec4 scene = texture2D(u_scene, v_uv);
      vec3 glow = vec3(0.0);
      float weights = 0.0;
      for (int i = -6; i <= 6; i++) {
        float y = float(i);
        float w = exp(-y * y / 16.0);
        glow += texture2D(u_bloom, v_uv + vec2(0.0, y * u_texel.y * 3.0)).rgb * w;
        weights += w;
      }
      glow = glow / weights * 0.7;
      vec3 color = 1.0 - (1.0 - scene.rgb) * exp(-glow * 1.8);
      float alpha = max(scene.a, max(glow.r, max(glow.g, glow.b)));
      vec2 sceneUV = u_crop.xy + v_uv * u_crop.zw;
      float fade = 1.0 - smoothstep(0.70, 1.0, length((sceneUV - 0.5) * 1.7));
      // Straight-alpha output; the light remains luminous over the star field.
      gl_FragColor = vec4(color / max(alpha, 0.001), alpha * fade);
    }
  `;

  class BlackHole {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' });
      this.ready = false;
      this.lost = false;
      this.quality = 1;
      this.frameTimes = [];
      this.lastSample = 0;
      this.resources = [];
      if (!this.gl) return;
      try { this.initialize(); } catch (error) { console.warn('Using the static black-hole illustration.', error); }
      canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        this.ready = false;
        this.lost = true;
        canvas.parentElement.classList.remove('is-ready');
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this.resources = [];
        this.lost = false;
        try { this.initialize(); this.onRestore?.(); }
        catch (error) { console.warn('The static illustration remains available.', error); }
      });
    }

    shader(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(log);
      }
      return shader;
    }

    program(fragment) {
      const gl = this.gl;
      const vertex = this.shader(gl.VERTEX_SHADER, vertexSource);
      const derivatives = gl.getExtension('OES_standard_derivatives');
      const prefix = derivatives ? '#extension GL_OES_standard_derivatives : enable\n#define HAS_DERIVATIVES\n' : '';
      const pixel = this.shader(gl.FRAGMENT_SHADER, prefix + fragment);
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, pixel);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(pixel);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      this.resources.push({ type: 'program', value: program });
      const uniforms = {};
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        uniforms[info.name] = gl.getUniformLocation(program, info.name);
      }
      return { value: program, position: gl.getAttribLocation(program, 'a_position'), uniforms };
    }

    target() {
      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const buffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      this.resources.push({ type: 'texture', value: texture }, { type: 'framebuffer', value: buffer });
      return { texture, buffer };
    }

    initialize() {
      const gl = this.gl;
      this.scene = this.program(sceneSource);
      this.bloom = this.program(bloomSource);
      this.composite = this.program(compositeSource);
      this.triangle = gl.createBuffer();
      this.resources.push({ type: 'buffer', value: this.triangle });
      gl.bindBuffer(gl.ARRAY_BUFFER, this.triangle);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      this.sceneTarget = this.target();
      this.bloomTarget = this.target();
      this.ready = true;
      this.resize();
    }

    resize() {
      if (!this.ready) return;
      const gl = this.gl;
      const figure = this.canvas.parentElement;
      const rect = figure.getBoundingClientRect();
      const hero = figure.closest('.hero').getBoundingClientRect();
      const left = Math.max(rect.left, hero.left);
      const top = Math.max(rect.top, hero.top);
      const visibleWidth = Math.max(1, Math.min(rect.right, hero.right) - left);
      const visibleHeight = Math.max(1, Math.min(rect.bottom, hero.bottom) - top);
      const offsetX = left - rect.left;
      const offsetY = top - rect.top;
      this.sceneWidth = rect.width;
      this.sceneHeight = rect.height;
      this.crop = [offsetX / rect.width, 1 - (offsetY + visibleHeight) / rect.height, visibleWidth / rect.width, visibleHeight / rect.height];
      // Render only the visible portion of the enlarged scene, keeping its
      // original camera coordinates without spending pixels outside the hero.
      Object.assign(this.canvas.style, {
        left: `${offsetX}px`, top: `${offsetY}px`,
        width: `${visibleWidth}px`, height: `${visibleHeight}px`,
      });
      const scale = Math.min(devicePixelRatio || 1, 1.35, 1440 / visibleWidth) * this.quality;
      this.width = Math.max(2, Math.round(visibleWidth * scale));
      this.height = Math.max(2, Math.round(visibleHeight * scale));
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      for (const [target, divisor] of [[this.sceneTarget, 1], [this.bloomTarget, 3]]) {
        target.width = Math.max(2, Math.round(this.width / divisor));
        target.height = Math.max(2, Math.round(this.height / divisor));
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, target.width, target.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.buffer);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          this.ready = false;
          this.canvas.parentElement.classList.remove('is-ready');
          return;
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    use(program, target) {
      const gl = this.gl;
      gl.useProgram(program.value);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.triangle);
      gl.enableVertexAttribArray(program.position);
      gl.vertexAttribPointer(program.position, 2, gl.FLOAT, false, 0, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target?.buffer || null);
      gl.viewport(0, 0, target?.width || this.width, target?.height || this.height);
    }

    texture(program, name, texture, index) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(program.uniforms[name], index);
    }

    render(time, x, y) {
      if (!this.ready || this.lost) return;
      const gl = this.gl;
      this.use(this.scene, this.sceneTarget);
      gl.uniform2f(this.scene.uniforms.u_resolution, this.sceneWidth, this.sceneHeight);
      gl.uniform4fv(this.scene.uniforms.u_crop, this.crop);
      gl.uniform2f(this.scene.uniforms.u_pointer, x, y);
      gl.uniform1f(this.scene.uniforms.u_time, time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      this.use(this.bloom, this.bloomTarget);
      this.texture(this.bloom, 'u_scene', this.sceneTarget.texture, 0);
      gl.uniform2f(this.bloom.uniforms.u_texel, 1 / this.width, 1 / this.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      this.use(this.composite, null);
      this.texture(this.composite, 'u_scene', this.sceneTarget.texture, 0);
      this.texture(this.composite, 'u_bloom', this.bloomTarget.texture, 1);
      gl.uniform2f(this.composite.uniforms.u_texel, 1 / this.width, 1 / this.height);
      gl.uniform4fv(this.composite.uniforms.u_crop, this.crop);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.canvas.parentElement.classList.add('is-ready');
    }

    sampleFrame(timestamp) {
      if (this.lastSample) this.frameTimes.push(timestamp - this.lastSample);
      this.lastSample = timestamp;
      if (this.frameTimes.length < 45) return;
      const average = this.frameTimes.reduce((sum, ms) => sum + ms, 0) / this.frameTimes.length;
      this.frameTimes = [];
      if (average > 48 && this.quality > 0.8) {
        this.quality = Math.max(0.8, this.quality * 0.9);
        this.resize();
      }
    }

    resetTiming() { this.lastSample = 0; this.frameTimes = []; }
  }
  window.BlackHole = BlackHole;
})();
