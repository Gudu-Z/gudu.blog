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
    uniform vec2 u_renderSize;
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
    float detailVisibility(vec2 uv, bool averageDetail) {
      // Refined ring samples resolve geometry only: its texture is subpixel.
      // No derivatives may run inside the adaptive sampling branch.
      if (averageDetail) return 0.0;
      #ifdef HAS_DERIVATIVES
        // Fade frequencies before a noise cell becomes smaller than a pixel.
        // This also follows the actual render resolution during quality scaling.
        float footprint = max(length(dFdx(uv)), length(dFdy(uv)));
        return 1.0 - smoothstep(0.35, 1.2, footprint);
      #else
        return 0.0;
      #endif
    }
    float filteredNoise(vec2 uv, bool averageDetail) {
      // Unresolved value noise converges to its mean instead of shimmering.
      return mix(0.5, noise(uv), detailVisibility(uv, averageDetail));
    }
    vec3 acceleration(vec3 p, float h2) {
      float r2 = dot(p, p);
      return -1.5 * h2 * p / (r2 * r2 * sqrt(r2));
    }
    vec3 diskEmission(vec3 p, vec3 ray, bool averageDetail) {
      float r = length(p.xz);
      float phi = atan(p.z, p.x);
      // Keplerian shear winds the features into fine, orbiting filaments.
      float phase = phi - u_time * 2.1 / pow(r, 1.5);
      // Periodic coordinates keep the flow seamless across atan's wrap.
      vec2 orbit = vec2(cos(phase), sin(phase));
      float flow = noise(vec2(r * 0.8 + orbit.x * 1.6, orbit.y * 2.0));
      float streamRadius = r + (flow - 0.5) * 0.32;
      float body = filteredNoise(vec2(streamRadius * 2.0 + orbit.x * 0.7, orbit.y * 3.0), averageDetail);
      float ribbons = filteredNoise(vec2(streamRadius * 6.5 + orbit.x * 1.3, orbit.y * 4.5), averageDetail);
      vec2 fineUV = vec2(streamRadius * 22.0 + orbit.x * 2.0, orbit.y * 12.0);
      float fine = noise(fineUV);
      // Independent angular patches vary the lengths of the fine highlights.
      vec2 patchUV = vec2(r * 1.2 + orbit.x * 5.0, orbit.y * 5.0);
      float patches = noise(patchUV);
      float filament = smoothstep(0.53, 0.76, fine) * smoothstep(0.25, 0.70, patches);
      // Filter the thresholded highlight too, not just its input noise.
      filament = mix(0.12, filament, detailVisibility(fineUV, averageDetail) * detailVisibility(patchUV, averageDetail));
      float texture = 0.46 + 0.36 * body + 0.38 * ribbons + 0.38 * filament;

      // Local orbital velocity; -ray is the emitted photon's direction.
      vec3 tangent = normalize(vec3(-p.z, 0.0, p.x));
      float beta = sqrt(0.5 / (r - 1.0));
      float doppler = sqrt(1.0 - beta * beta) /
        (1.0 - beta * dot(tangent, normalize(-ray)));
      float shift = doppler * sqrt(1.0 - 1.0 / r);
      float heat = pow(3.0 / r, 0.75) * pow(max(0.001, 1.0 - sqrt(3.0 / r)), 0.25);
      float observedHeat = heat * shift;

      // Warm body color, with cream reserved for the hotter fine highlights.
      vec3 ember = vec3(0.94, 0.25, 0.075);
      vec3 gold = vec3(1.0, 0.66, 0.30);
      vec3 ivory = vec3(1.0, 0.93, 0.73);
      vec3 color = mix(ember, gold, smoothstep(0.17, 0.33, observedHeat));
      color = mix(color, ivory, smoothstep(0.38, 0.68, observedHeat) * (0.30 + 0.60 * filament));
      float innerEdge = smoothstep(3.0, 3.35, r);
      float energy = 2.25 * pow(3.0 / r, 1.6) * pow(shift, 3.0);
      // A monotonic highlight shoulder retains Doppler asymmetry and texture
      // without allowing the approaching side to flatten into a white sheet.
      float intensity = energy * texture;
      float excess = max(intensity - 0.75, 0.0);
      intensity = min(intensity, 0.75) + excess / (1.0 + 1.10 * excess);
      return color * intensity * innerEdge;
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
    vec4 traceScene(vec2 screen, vec3 origin, vec3 forward, vec3 right, vec3 up, bool averageDetail, out bool directDisk) {
      directDisk = false;
      int crossings = 0;
      vec3 direction = normalize(forward * 2.08 + screen.x * right + screen.y * up);
      vec3 p = origin;
      vec3 v = direction;
      vec3 angular = cross(p, v);
      float h2 = dot(angular, angular);
      vec3 emission = vec3(0.0);
      float alpha = 0.0;
      float diskOpacity = 1.0;
      // These rays cannot reach the disk's outer radius, even after deflection.
      // Skip their tracing without returning before the shared derivative work.
      bool escaped = h2 > 140.0;
      bool diskFound = false;
      vec3 diskPoint = vec3(6.0, 0.0, 0.0);
      vec3 diskRay = vec3(0.0, 0.0, 1.0);

      for (int i = 0; i < 180; i++) {
        if (escaped) break;
        float r = length(p);
        if (r < 1.015) { alpha = 1.0; break; }
        if (r > 42.0) { escaped = true; break; }
        float dt = clamp(r * 0.095, 0.055, 1.8);
        vec3 a = acceleration(p, h2);
        vec3 next = p + v * dt + 0.5 * a * dt * dt;
        vec3 nextV = v + 0.5 * (a + acceleration(next, h2)) * dt;

        if (p.y * next.y < 0.0) {
          crossings++;
          float fraction = p.y / (p.y - next.y);
          vec3 hit = mix(p, next, fraction);
          float diskRadius = length(hit.xz);
          if (diskRadius > 3.0 && diskRadius < 11.0) {
            diskPoint = hit;
            diskRay = mix(v, nextV, fraction);
            diskFound = true;
            directDisk = crossings == 1;
            // Fade coverage rather than painting a dim opaque outer rim.
            diskOpacity = 1.0 - smoothstep(7.8, 10.8, diskRadius);
            alpha = diskOpacity;
            break;
          }
        }
        p = next;
        v = nextV;
      }
      // The base trace reaches this call in all pixels after the loop; adaptive
      // samples use averageDetail to avoid derivatives in divergent control flow.
      vec3 diskLight = diskEmission(diskPoint, diskRay, averageDetail);
      if (diskFound) emission = diskLight;
      if (escaped) {
        emission = distantStars(normalize(v));
        alpha = max(emission.r, max(emission.g, emission.b));
      }
      // Soft clipping preserves thin light lanes instead of flattening the disk.
      if (h2 <= 140.0) emission = 1.0 - exp(-emission * 1.65);
      emission *= diskOpacity;
      return vec4(emission, alpha);
    }
    void main() {
      float aspect = u_resolution.x / u_resolution.y;
      vec2 sceneUV = u_crop.xy + v_uv * u_crop.zw;
      vec2 screen = (sceneUV - vec2(0.50, 0.59)) * vec2(aspect, 1.0) * 2.0;
      screen -= u_pointer * vec2(0.012, 0.009);
      // Screen roll controls composition independently of the disk's 3D inclination.
      float screenRoll = 18.0 * PI / 180.0;
      mat2 roll = mat2(cos(screenRoll), -sin(screenRoll), sin(screenRoll), cos(screenRoll));
      screen = roll * screen;
      // Inclination is measured from the disk normal: 0° face-on, 90° edge-on.
      float diskInclination = 81.0 * PI / 180.0;
      float cameraDistance = 31.784430;
      vec3 origin = vec3(u_pointer.x * 0.8,
        cameraDistance * cos(diskInclination) + u_pointer.y * 0.55,
        cameraDistance * sin(diskInclination));
      vec3 forward = normalize(-origin);
      vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(right, forward);

      // The ordinary material pass remains unconditional for valid derivatives.
      bool directDisk;
      vec4 center = traceScene(screen, origin, forward, right, up, false, directDisk);
      vec2 pixel = 2.0 * u_crop.zw * vec2(aspect, 1.0) / u_renderSize;
      vec3 direction = normalize(forward * 2.08 + screen.x * right + screen.y * up);
      float impact = length(cross(origin, direction));
      float pixelImpact = length(origin) * max(pixel.x, pixel.y) / 2.08;
      // Use proximity to the critical orbit only to budget extra samples.
      // The visible ring, shadow and disk occlusion still come from traced rays.
      float refine = 1.0 - smoothstep(0.045 + 1.5 * pixelImpact,
        0.075 + 2.5 * pixelImpact, abs(impact - 2.6));
      // A first-crossing disk hit already hides the ring; keep its resolved
      // foreground texture instead of averaging it into a circular seam.
      if (refine > 0.0 && !directDisk) {
        vec4 resolved = vec4(0.0);
        // A fixed 4x4 grid estimates subpixel coverage without temporal ghosts.
        for (int y = 0; y < 4; y++) {
          for (int x = 0; x < 4; x++) {
            vec2 offset = (vec2(float(x), float(y)) + 0.5) / 4.0 - 0.5;
            bool sampleDirectDisk;
            resolved += traceScene(screen + roll * (offset * pixel), origin, forward, right, up, true, sampleDirectDisk);
          }
        }
        center = mix(center, resolved / 16.0, refine);
      }
      gl_FragColor = center;
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
        float brightness = max(c.r, max(c.g, c.b));
        // Bright filaments contribute glow; dim amber outskirts stay clear.
        light += c * smoothstep(0.34, 0.68, brightness) * 0.72 * w;
        weights += w;
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
    float luminance(vec3 color) {
      return dot(color, vec3(0.299, 0.587, 0.114));
    }
    vec4 antialiasedScene() {
      vec4 center = texture2D(u_scene, v_uv);
      float middle = luminance(center.rgb);
      float nw = luminance(texture2D(u_scene, v_uv + vec2(-1.0, -1.0) * u_texel).rgb);
      float ne = luminance(texture2D(u_scene, v_uv + vec2( 1.0, -1.0) * u_texel).rgb);
      float sw = luminance(texture2D(u_scene, v_uv + vec2(-1.0,  1.0) * u_texel).rgb);
      float se = luminance(texture2D(u_scene, v_uv + vec2( 1.0,  1.0) * u_texel).rgb);
      float darkest = min(middle, min(min(nw, ne), min(sw, se)));
      float brightest = max(middle, max(max(nw, ne), max(sw, se)));
      // Leave low-contrast flow detail alone; only smooth sharp pixel edges.
      if (brightest - darkest < max(0.035, brightest * 0.18)) return center;
      vec2 direction = vec2(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
      float reduce = max((nw + ne + sw + se) * 0.03125, 0.0078125);
      direction = clamp(direction / (min(abs(direction.x), abs(direction.y)) + reduce),
        vec2(-3.0), vec2(3.0)) * u_texel;
      vec4 inner = 0.5 * (texture2D(u_scene, v_uv - direction / 6.0) +
        texture2D(u_scene, v_uv + direction / 6.0));
      vec4 outer = inner * 0.5 + 0.25 * (texture2D(u_scene, v_uv - direction * 0.5) +
        texture2D(u_scene, v_uv + direction * 0.5));
      float smoothed = luminance(outer.rgb);
      return smoothed < darkest || smoothed > brightest ? inner : outer;
    }
    void main() {
      vec4 scene = antialiasedScene();
      vec3 glow = vec3(0.0);
      float weights = 0.0;
      for (int i = -6; i <= 6; i++) {
        float y = float(i);
        float w = exp(-y * y / 16.0);
        glow += texture2D(u_bloom, v_uv + vec2(0.0, y * u_texel.y * 3.0)).rgb * w;
        weights += w;
      }
      glow = glow / weights * 0.55;
      // Keep the shadow dark while letting the traced photon ring remain sharp.
      float shadow = scene.a * (1.0 - smoothstep(0.015, 0.075, max(scene.r, max(scene.g, scene.b))));
      glow *= 1.0 - shadow * 0.9;
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
      this.interactionPointer = { x: 0, y: 0 };
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

    getInteractionGeometry() {
      const rect = this.canvas.parentElement?.getBoundingClientRect();
      if (!rect?.width || !rect.height) return null;
      // The fallback was rendered with a centered camera, regardless of where
      // the pointer was when WebGL became unavailable.
      const pointer = this.ready && !this.lost ? this.interactionPointer : { x: 0, y: 0 };
      const inclination = 81 * Math.PI / 180;
      const distance = Math.hypot(pointer.x * 0.8,
        31.784430 * Math.cos(inclination) + pointer.y * 0.55,
        31.784430 * Math.sin(inclination));
      // Use an impact parameter just inside the critical orbit (~2.6 Rs),
      // keeping the luminous, subpixel-sampled photon ring out of the target.
      const radius = rect.height * 1.04 * 2.5 / Math.sqrt(distance * distance - 2.5 * 2.5);
      return {
        x: rect.left + rect.width * 0.5 + pointer.x * 0.006 * rect.height,
        y: rect.top + rect.height * 0.41 - pointer.y * 0.0045 * rect.height,
        radius,
        axisAngle: -108 * Math.PI / 180,
      };
    }

    hitTestShadow(clientX, clientY) {
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
      const geometry = this.getInteractionGeometry();
      if (!geometry || Math.hypot(clientX - geometry.x, clientY - geometry.y) > geometry.radius) return false;
      const figure = this.canvas.parentElement;
      const hero = figure.closest('.hero')?.getBoundingClientRect();
      if (hero && (clientX < hero.left || clientX > hero.right || clientY < hero.top || clientY > hero.bottom)) return false;
      const rect = figure.getBoundingClientRect();
      const pointer = this.ready && !this.lost ? this.interactionPointer : { x: 0, y: 0 };
      const inclination = 81 * Math.PI / 180;
      const roll = 18 * Math.PI / 180;
      let px = pointer.x * 0.8;
      let py = 31.784430 * Math.cos(inclination) + pointer.y * 0.55;
      let pz = 31.784430 * Math.sin(inclination);
      const distance = Math.hypot(px, py, pz);
      const fx = -px / distance, fy = -py / distance, fz = -pz / distance;
      const horizontal = Math.hypot(fx, fz);
      const rx = -fz / horizontal, rz = fx / horizontal;
      const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
      const sx = (clientX - geometry.x) * 2 / rect.height;
      const sy = (geometry.y - clientY) * 2 / rect.height;
      const screenX = Math.cos(roll) * sx + Math.sin(roll) * sy;
      const screenY = -Math.sin(roll) * sx + Math.cos(roll) * sy;
      let vx = fx * 2.08 + screenX * rx + screenY * ux;
      let vy = fy * 2.08 + screenY * uy;
      let vz = fz * 2.08 + screenX * rz + screenY * uz;
      const speed = Math.hypot(vx, vy, vz);
      vx /= speed; vy /= speed; vz /= speed;
      const hx = py * vz - pz * vy;
      const hy = pz * vx - px * vz;
      const hz = px * vy - py * vx;
      const h2 = hx * hx + hy * hy + hz * hz;

      // Trace only candidate clicks/pointer positions, without reading GPU
      // pixels. This mirrors traceScene: foreground and lensed disk crossings
      // must block interaction even when they overlap the projected shadow.
      for (let i = 0; i < 180; i++) {
        const r2 = px * px + py * py + pz * pz;
        const r = Math.sqrt(r2);
        if (r < 1.015) return true;
        if (r > 42) return false;
        const dt = Math.max(0.055, Math.min(1.8, r * 0.095));
        const acceleration = -1.5 * h2 / (r2 * r2 * r);
        const ax = acceleration * px, ay = acceleration * py, az = acceleration * pz;
        const nx = px + vx * dt + 0.5 * ax * dt * dt;
        const ny = py + vy * dt + 0.5 * ay * dt * dt;
        const nz = pz + vz * dt + 0.5 * az * dt * dt;
        const nextR2 = nx * nx + ny * ny + nz * nz;
        const nextAcceleration = -1.5 * h2 / (nextR2 * nextR2 * Math.sqrt(nextR2));
        const nextVx = vx + 0.5 * (ax + nextAcceleration * nx) * dt;
        const nextVy = vy + 0.5 * (ay + nextAcceleration * ny) * dt;
        const nextVz = vz + 0.5 * (az + nextAcceleration * nz) * dt;
        if (py * ny < 0) {
          const fraction = py / (py - ny);
          const diskRadius = Math.hypot(px + (nx - px) * fraction, pz + (nz - pz) * fraction);
          if (diskRadius > 3 && diskRadius < 11) return false;
        }
        px = nx; py = ny; pz = nz;
        vx = nextVx; vy = nextVy; vz = nextVz;
      }
      return false;
    }

    render(time, x, y) {
      this.interactionPointer.x = x;
      this.interactionPointer.y = y;
      if (!this.ready || this.lost) return;
      const gl = this.gl;
      this.use(this.scene, this.sceneTarget);
      gl.uniform2f(this.scene.uniforms.u_resolution, this.sceneWidth, this.sceneHeight);
      gl.uniform2f(this.scene.uniforms.u_renderSize, this.width, this.height);
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
