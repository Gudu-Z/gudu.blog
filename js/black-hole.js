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
    // Integral of a periodic pulse over a pixel's 1D footprint, including
    // multiple lanes. Its mean remains duty, at every resolution.
    float laneIntegral(float x, float duty) {
      return floor(x) * duty + clamp(fract(x) - 0.5 + duty * 0.5, 0.0, duty);
    }
    float filteredLane(float phase, float duty, float footprint) {
      float width = max(footprint, 0.015);
      float coverage = (laneIntegral(phase + width * 0.5, duty)
        - laneIntegral(phase - width * 0.5, duty)) / width;
      // Remove unresolved contrast before the Nyquist limit, rather than
      // letting aliased beats change brightness as the camera moves.
      return mix(clamp(coverage, 0.0, 1.0), duty, smoothstep(0.30, 0.75, width));
    }
    vec3 acceleration(vec3 p, float h2) {
      float r2 = dot(p, p);
      return -1.5 * h2 * p / (r2 * r2 * sqrt(r2));
    }
    vec3 diskEmission(vec3 p, vec3 ray, vec3 pointDx, vec3 pointDy) {
      float r = length(p.xz);
      float phi = atan(p.z, p.x);
      vec2 radialGradient = vec2(dot(p.xz, pointDx.xz), dot(p.xz, pointDy.xz)) / r;
      vec2 angularGradient = vec2(p.x * pointDx.z - p.z * pointDx.x,
        p.x * pointDy.z - p.z * pointDy.x) / (r * r);
      float radialFootprint = max(dot(abs(radialGradient), vec2(1.0)), 0.0001);
      // Continuous orbital filaments, grouped by radius with breathing room
      // between bundles. Periodic angular coordinates avoid a texture seam.
      float phase = phi - u_time * 3.2 / pow(r, 1.5);
      vec2 phaseGradient = angularGradient + (4.8 * u_time / pow(r, 2.5)) * radialGradient;
      float bundles = 0.5 + 0.5 * cos(r * 2.35)
        * exp(-0.5 * pow(radialFootprint * 2.35, 2.0));
      // Shear eventually compresses the small orbital ripples below a pixel.
      // Filter those ripples BEFORE they warp the main radial bands, otherwise
      // a long-running animation can turn stable strands into checkerboard noise.
      float warpPhase = phase * 2.0 + r * 1.4;
      vec2 warpGradient = phaseGradient * 2.0 + radialGradient * 1.4;
      float warpFilter = exp(-0.5 * dot(warpGradient, warpGradient));
      float phaseFilter = exp(-0.5 * dot(phaseGradient, phaseGradient));
      float streakPhase = r * 25.0 + 6.2 * sin(r * 2.35) + 0.9 * sin(r * 5.0)
        + 0.65 * sin(warpPhase) * warpFilter + 0.25 * sin(phase) * phaseFilter;
      float laneWidth = mix(0.018, 0.065, bundles);
      vec2 streakGradient = (25.0 + 14.57 * cos(r * 2.35) + 4.5 * cos(r * 5.0)) * radialGradient
        + 0.65 * cos(warpPhase) * warpFilter * warpGradient
        + 0.25 * cos(phase) * phaseFilter * phaseGradient;
      float footprint = dot(abs(streakGradient), vec2(1.0)) / (2.0 * PI);
      float filament = filteredLane(streakPhase / (2.0 * PI), laneWidth * 2.0, footprint);
      // Broad, slowly travelling illumination reveals depth without grain.
      float flowPhase = phase * 3.0 + r * 0.85;
      // Analytic gradients include orbital shear at long running times and
      // remain continuous through atan's wrap and multiple sine periods.
      vec2 flowGradient = phaseGradient * 3.0 + radialGradient * 0.85;
      float flowFilter = exp(-0.5 * dot(flowGradient, flowGradient));
      float flow = 0.76 + 0.24 * sin(flowPhase) * flowFilter;
      float texture = (0.055 + 0.12 * bundles + filament * (0.28 + 1.15 * bundles)) * flow;

      // Local orbital velocity; -ray is the emitted photon's direction.
      vec3 tangent = normalize(vec3(-p.z, 0.0, p.x));
      float beta = sqrt(0.5 / (r - 1.0));
      float doppler = sqrt(1.0 - beta * beta) /
        (1.0 - beta * dot(tangent, normalize(-ray)));
      float shift = doppler * sqrt(1.0 - 1.0 / r);
      float heat = pow(3.0 / r, 0.75) * pow(max(0.001, 1.0 - sqrt(3.0 / r)), 0.25);
      float observedHeat = heat * shift;

      // Warm white carries the light, with pale amber only in cooler lanes.
      vec3 amber = vec3(1.0, 0.77, 0.48);
      vec3 pearl = vec3(1.0, 0.92, 0.79);
      vec3 white = vec3(1.0, 0.98, 0.93);
      vec3 color = mix(amber, pearl, smoothstep(0.12, 0.32, observedHeat));
      color = mix(color, white, smoothstep(0.30, 0.58, observedHeat));
      float innerEdge = smoothstep(3.0, 3.35, r);
      float outerEdge = 1.0 - smoothstep(9.3, 10.7, r);
      // Compress the Doppler contrast for balanced left/right readability.
      float balancedShift = mix(1.0, clamp(shift, 0.55, 1.65), 0.27);
      float energy = 2.5 * pow(3.0 / r, 1.18) * balancedShift;
      // A soft outer lip joins the disk through a wider, dimmer light shoulder.
      // Keep the near edge subdued so it does not read as a separate outline.
      // Both profiles preserve energy as their pixel footprint changes.
      float rimWidth = 0.055;
      float filteredWidth = sqrt(rimWidth * rimWidth + radialFootprint * radialFootprint / 12.0);
      float rim = exp(-0.5 * pow((r - 10.38) / filteredWidth, 2.0)) * rimWidth / filteredWidth;
      float shoulderWidth = 0.28;
      float filteredShoulder = sqrt(shoulderWidth * shoulderWidth + radialFootprint * radialFootprint / 12.0);
      float shoulder = exp(-0.5 * pow((r - 10.15) / filteredShoulder, 2.0)) * shoulderWidth / filteredShoulder;
      float edgeFacing = 0.72 - 0.22 * sin(phi);
      vec3 edgeLight = mix(pearl, white, 0.35) * (rim * 0.34 + shoulder * 0.12) * edgeFacing;
      return color * energy * texture * innerEdge * outerEdge + edgeLight;
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
    struct RayHit {
      vec3 point;
      vec3 ray;
      float alpha;
      float material;
    };
    RayHit traceRay(vec3 origin, vec3 direction) {
      RayHit hit;
      hit.point = vec3(6.0, 0.0, 0.0);
      hit.ray = direction;
      hit.alpha = 0.0;
      hit.material = 0.0;
      vec3 p = origin, v = direction;
      vec3 angular = cross(p, v);
      float h2 = dot(angular, angular);
      if (h2 > 140.0) hit.material = -1.0;
      else {
        for (int i = 0; i < 180; i++) {
          float r = length(p);
          if (r < 1.015) { hit.alpha = 1.0; break; }
          if (r > 42.0) { hit.material = -1.0; hit.ray = normalize(v); break; }
          float dt = clamp(r * 0.095, 0.055, 1.8);
          vec3 a = acceleration(p, h2);
          vec3 next = p + v * dt + 0.5 * a * dt * dt;
          vec3 nextV = v + 0.5 * (a + acceleration(next, h2)) * dt;
          if (p.y * next.y < 0.0) {
            float fraction = p.y / (p.y - next.y);
            vec3 crossing = mix(p, next, fraction);
            float diskRadius = length(crossing.xz);
            if (diskRadius > 3.0 && diskRadius < 11.0) {
              hit.point = crossing;
              hit.ray = mix(v, nextV, fraction);
              hit.material = 1.0;
              hit.alpha = 1.0 - smoothstep(10.65, 11.0, diskRadius);
              break;
            }
          }
          p = next;
          v = nextV;
        }
      }
      return hit;
    }
    vec4 shadeHit(RayHit hit, vec3 pointDx, vec3 pointDy) {
      vec3 emission = vec3(0.0);
      float alpha = hit.alpha;
      if (hit.material > 0.5) emission = diskEmission(hit.point, hit.ray, pointDx, pointDy);
      if (hit.material < -0.5) {
        emission = distantStars(hit.ray);
        alpha = max(emission.r, max(emission.g, emission.b));
      }
      emission = 1.0 - exp(-emission * 1.45);
      return vec4(emission * alpha, alpha);
    }
    void main() {
      float aspect = u_resolution.x / u_resolution.y;
      vec2 sceneUV = u_crop.xy + v_uv * u_crop.zw;
      vec2 screen = (sceneUV - vec2(0.50)) * vec2(aspect, 1.0) * 2.0;
      screen -= u_pointer * vec2(0.012, 0.009);
      // Screen roll controls composition independently of the disk's 3D inclination.
      float screenRoll = (18.0 + u_pointer.x * 1.4) * PI / 180.0;
      screen = mat2(cos(screenRoll), -sin(screenRoll), sin(screenRoll), cos(screenRoll)) * screen;
      // Inclination is measured from the disk normal: 0° face-on, 90° edge-on.
      float diskInclination = (81.0 + u_pointer.y * 3.8) * PI / 180.0;
      float cameraDistance = 31.784430;
      float azimuth = u_pointer.x * 0.10;
      vec3 origin = cameraDistance * vec3(sin(azimuth) * sin(diskInclination),
        cos(diskInclination), cos(azimuth) * sin(diskInclination));
      vec3 forward = normalize(-origin);
      vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(right, forward);
      vec3 direction = normalize(forward * 4.05 + screen.x * right + screen.y * up);
      RayHit hit = traceRay(origin, direction);
      vec3 pointDx = vec3(0.0), pointDy = vec3(0.0);
      vec2 screenDx = vec2(0.0), screenDy = vec2(0.0);
      #ifdef HAS_DERIVATIVES
        // Every fragment reconverges here. Never evaluate derivatives inside
        // a ray-march or a material branch with different per-pixel control flow.
        pointDx = dFdx(hit.point);
        pointDy = dFdy(hit.point);
        screenDx = dFdx(screen);
        screenDy = dFdy(screen);
      #endif
      vec4 light = shadeHit(hit, pointDx, pointDy);
      vec3 angular = cross(origin, direction);
      float h2 = dot(angular, angular);
      // Only the critical-curve neighbourhood needs geometry supersampling.
      // Four rotated subpixel rays smooth the thin higher-order silhouettes;
      // the rest of the disk keeps its analytically filtered, distinct strands.
      float edgeAA = smoothstep(5.5, 5.9, h2) * (1.0 - smoothstep(8.1, 8.5, h2));
      if (edgeAA > 0.0) {
        vec4 samples = vec4(0.0);
        for (int sampleIndex = 0; sampleIndex < 4; sampleIndex++) {
          vec2 offset = vec2(-0.375, -0.125);
          if (sampleIndex == 1) offset = vec2(0.125, -0.375);
          if (sampleIndex == 2) offset = vec2(0.375, 0.125);
          if (sampleIndex == 3) offset = vec2(-0.125, 0.375);
          vec2 subScreen = screen + screenDx * offset.x + screenDy * offset.y;
          vec3 subRay = normalize(forward * 4.05 + subScreen.x * right + subScreen.y * up);
          samples += shadeHit(traceRay(origin, subRay), pointDx, pointDy);
        }
        light = mix(light, samples * 0.25, edgeAA);
      }
      // Internal targets contain premultiplied light. The final pass converts
      // to straight alpha exactly once for the transparent WebGL canvas.
      gl_FragColor = light;
    }
  `;

  const bloomSource = `
    precision highp float;
    varying vec2 v_uv;
    uniform sampler2D u_scene;
    uniform vec2 u_texel;
    void main() {
      vec3 light = vec3(0.0);
      float weights = 0.0;
      // Low-pass both axes BEFORE reducing the bloom resolution. A sparse
      // row of samples would turn the fine filaments into false light bands.
      for (int i = -4; i <= 4; i++) {
        float x = float(i);
        float w = exp(-x * x / 8.0);
        for (int j = -1; j <= 1; j++) {
          vec3 c = texture2D(u_scene, v_uv + vec2(x, float(j)) * u_texel).rgb;
          light += max(c - 0.22, 0.0) * w;
          weights += w;
        }
      }
      gl_FragColor = vec4(light / weights, 1.0);
    }
  `;

  const compositeSource = `
    precision highp float;
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
        glow += texture2D(u_bloom, v_uv + vec2(0.0, y * u_texel.y * 2.0)).rgb * w;
        weights += w;
      }
      glow = glow / weights * 0.30;
      vec3 color = 1.0 - (1.0 - scene.rgb) * exp(-glow * 1.2);
      float alpha = max(scene.a, max(color.r, max(color.g, color.b)));
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
      // A fixed-width approximation cannot safely filter the lensed filaments.
      // Older devices without derivatives use the matching rendered fallback.
      if (!gl.getExtension('OES_standard_derivatives')) return;
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
      // Avoid stretching a 1440px buffer across a wide screen. Keep a bounded
      // pixel budget, with the procedural filter handling any adaptive scale.
      const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const scale = Math.min(devicePixelRatio || 1, 1.5, 2400 / visibleWidth,
        maxTexture / visibleWidth, maxTexture / visibleHeight,
        Math.sqrt(3600000 / (visibleWidth * visibleHeight))) * this.quality;
      this.width = Math.max(2, Math.round(visibleWidth * scale));
      this.height = Math.max(2, Math.round(visibleHeight * scale));
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      for (const [target, divisor] of [[this.sceneTarget, 1], [this.bloomTarget, 2]]) {
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
