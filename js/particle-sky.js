/* Real XYZ stars, projected into a directional radiance atlas before tracing
 * the black hole. The atlas concentrates resolution toward the camera while
 * retaining the whole sky for strongly deflected rays. No second animation loop.
 */
(() => {
  'use strict';

  const vertex = `
    precision highp float;
    attribute vec3 a_position;
    attribute vec4 a_style;
    attribute float a_wrap;
    uniform vec3 u_observer;
    uniform vec2 u_sweep;
    uniform vec2 u_chart;
    uniform float u_maxPoint;
    varying vec2 v_coreSigma;
    varying vec3 v_coreLight;
    varying float v_size;
    #define PI 3.14159265359
    void main() {
      vec3 p = a_position - u_observer;
      // An orbiting observer also turns, which carries each star across the
      // view by its depth's share: far stars sweep past, near ones lag.
      p.xy -= u_sweep * abs(a_position.z);
      // Recycle individual stars in a large volume, fading to zero on both
      // sides of each boundary. Time itself never resets or jumps backward.
      p.xy = mod(p.xy + 1600.0, 3200.0) - 1600.0;
      float edge = 1.0 - smoothstep(1380.0, 1600.0, max(abs(p.x), abs(p.y)));
      float distance = max(length(p), 0.001);
      vec3 d = p / distance;
      float horizontal = max(length(d.xz), 0.0001);
      float phi = atan(d.x, -d.z);
      float s = sin(phi * 0.5), c = cos(phi * 0.5);
      // Same foveated angular chart and Jacobian as minimalSky().
      vec2 uv = vec2(atan(8.0 * s, c), atan(4.0 * d.y, horizontal)) / PI + 0.5;
      vec2 jacobian = vec2(4.0 / (c*c + 64.0*s*s) / horizontal,
        4.0 / (horizontal*horizontal + 16.0*d.y*d.y)) / PI;
      uv.x += a_wrap;
      float interior = 1.0 - 2.0 * u_chart.y;
      uv = u_chart.y + uv * interior;
      vec2 rawSigma = a_style.x / distance * jacobian * u_chart.x * interior;
      // Concentrate the same starlight into a small core. Keep the pixel
      // reconstruction variance: subpixel stars still cross texels smoothly.
      v_coreSigma = sqrt(rawSigma * rawSigma * 0.36 + 0.30);
      v_size = min(u_maxPoint, ceil(6.0 * max(v_coreSigma.x, v_coreSigma.y)));
      gl_PointSize = min(u_maxPoint, max(v_size, 2.0));
      v_size = gl_PointSize;
      float energy = rawSigma.x * rawSigma.y;
      float visibility = edge * smoothstep(80.0, 140.0, distance)
        * (1.0 - smoothstep(0.985, 0.999, abs(d.y)));
      // Match the restrained cool-white points from the October 4 sky.
      // No second halo or warm haze, while depth still controls projection.
      vec3 tint = vec3(193.0, 204.0, 223.0) / 255.0;
      vec3 light = tint * a_style.y * energy * visibility;
      v_coreLight = light / (v_coreSigma.x * v_coreSigma.y);
      gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    }
  `;
  const fragment = `
    precision highp float;
    varying vec2 v_coreSigma;
    varying vec3 v_coreLight;
    varying float v_size;
    void main() {
      vec2 offset = (gl_PointCoord - 0.5) * v_size;
      vec2 core = offset / v_coreSigma;
      float nucleus = exp(-0.5 * dot(core, core));
      // The filtered core fades before the point boundary. No hard threshold
      // can blink on/off as a subpixel star drifts between atlas texels.
      nucleus *= 1.0 - smoothstep(2.3, 3.0, max(abs(core.x), abs(core.y)));
      gl_FragColor = vec4(v_coreLight * nucleus, 0.0);
    }
  `;

  // The orbit's centre lies this far ahead of the observer, nearer than any
  // star, so every star moves the same way and the farthest move fastest.
  const ORBIT_CENTRE = 100;
  // Scales the fill population so that, star for star, it shows about as many
  // stars at each brightness as the still stars of js/star-sky.js did.
  const FILL_GAIN = 7;

  class ParticleSky {
    // `fill`: how many stars of the dense, faint population to add (see fill()).
    // `orbit`: circle a point just ahead instead of translating (see render()).
    constructor(owner, { fill = 0, orbit = false } = {}) {
      this.owner = owner;
      this.gl = owner.gl;
      this.fillCount = fill;
      this.orbit = orbit;
      this.program = owner.program(fragment, vertex);
    }

    static geometry(count = 24000) {
      let state = 0x47ad9b31;
      const random = () => {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        return (state >>> 0) / 4294967296;
      };
      // Position, physical radius, luminosity, colour, reserved, seam copy.
      const data = new Float32Array(count * 3 * 8);
      for (let i = 0; i < count; i++) {
        // Fill the entire periodic XY cell, including its corners: a sphere
        // would leave the forward sky empty as the observer travelled into
        // those corners. Z remains continuous on either side of the camera.
        const x = (random() * 2 - 1) * 1600;
        const y = (random() * 2 - 1) * 1600;
        const z = (random() < 0.5 ? -1 : 1) * (120 + 1380 * random());
        const bright = random();
        const radius = 0.14 + 0.16 * bright * bright;
        // Stable broad clusters leave dark breathing room; there is no band.
        const group = 0.5 + 0.5 * Math.sin(x * 0.006 + Math.sin(z * 0.005)) * Math.cos(y * 0.007);
        const luminosity = (0.3 + 1.7 * bright * bright) * (0.22 + 0.78 * group);
        const warmth = random();
        for (let wrap = -1; wrap <= 1; wrap++) {
          data.set([x, y, z, radius, luminosity, warmth, 0, wrap], (i * 3 + wrap + 1) * 8);
        }
      }
      return data;
    }

    // The dense, faint stars that make up most of the sky, as the 2D still
    // stars of js/star-sky.js once did: mostly far away, and as bright on
    // screen as those were whatever their depth (their luminosity grows with
    // the square of their distance). Their clusters follow the same pattern.
    // Stars ahead never reach the chart's seam behind the observer, so only
    // those behind carry seam copies.
    static fill(count) {
      let state = 0x2f6b3c95;
      const random = () => {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        return (state >>> 0) / 4294967296;
      };
      const stars = [];
      for (let i = 0; i < count; i++) {
        const x = (random() * 2 - 1) * 1600;
        const y = (random() * 2 - 1) * 1600;
        const z = (random() < 0.5 ? -1 : 1) * (120 + 1380 * random());
        const bright = random();
        // A long tail of brightness: mostly faint stars and a few bright ones,
        // the brightest a little larger, so their light spreads instead of
        // clipping in the 8-bit atlas (larger still, they read as smudges by day).
        const radius = 0.14 + 0.16 * bright ** 2 + 0.45 * bright ** 8;
        const group = 0.5 + 0.5 * Math.sin(x * 0.006 + Math.sin(z * 0.005)) * Math.cos(y * 0.007);
        const shown = (0.05 + bright ** 5) * (0.25 + 0.75 * group);
        const luminosity = FILL_GAIN * shown * (z / 1000) ** 2 / (radius / 0.3) ** 2;
        stars.push([x, y, z, radius, luminosity, random(), 0]);
      }
      const vertices = stars.reduce((sum, star) => sum + (star[2] < 0 ? 1 : 3), 0);
      const data = new Float32Array(vertices * 8);
      let offset = 0;
      for (const star of stars) {
        for (const wrap of star[2] < 0 ? [0] : [-1, 0, 1]) {
          data.set([...star, wrap], offset);
          offset += 8;
        }
      }
      return data;
    }

    initialize() {
      const gl = this.gl;
      const resolution = this.owner.nextWidth <= 900 ? 1024 : 2048;
      const limit = Math.min(resolution, gl.getParameter(gl.MAX_TEXTURE_SIZE));
      this.size = 2 ** Math.floor(Math.log2(limit));
      this.inset = 32 / this.size;
      this.maxPoint = Math.min(48, gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1]);
      this.target = this.owner.target();
      gl.bindTexture(gl.TEXTURE_2D, this.target.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.size, this.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      // Lensing stretches stars mostly along one axis. Filter that footprint
      // without needlessly blurring the perpendicular, narrow stellar core.
      const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
      if (anisotropy) gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(4, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      gl.generateMipmap(gl.TEXTURE_2D);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('Particle sky framebuffer unavailable.');
      }
      const stars = ParticleSky.geometry();
      const fill = this.fillCount ? ParticleSky.fill(this.fillCount) : new Float32Array(0);
      const data = new Float32Array(stars.length + fill.length);
      data.set(stars);
      data.set(fill, stars.length);
      this.count = data.length / 8;
      this.buffer = gl.createBuffer();
      this.owner.resources.push({ type: 'buffer', value: this.buffer });
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      this.styleAttribute = gl.getAttribLocation(this.program.value, 'a_style');
      this.wrapAttribute = gl.getAttribLocation(this.program.value, 'a_wrap');
    }

    render(time, x, y) {
      const gl = this.gl, program = this.program, uniforms = program.uniforms;
      gl.useProgram(program.value);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.buffer);
      gl.viewport(0, 0, this.size, this.size);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      for (const [attribute, size, offset] of [[program.position, 3, 0], [this.styleAttribute, 4, 12], [this.wrapAttribute, 1, 28]]) {
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute, size, gl.FLOAT, false, 32, offset);
      }
      // Translating one observer produces continuous perspective and depth-
      // dependent drift. Pointer displacement never changes orbital time.
      // Whole-volume translations are equivalent under per-star wrapping;
      // bound the uniform to retain subpixel precision during long visits.
      const travel = (time - 12) * 1.50;
      if (this.orbit) {
        // Orbiting a point ORBIT_CENTRE ahead: the observer slides and turns
        // to keep facing it, so a star at depth z drifts by (z / centre - 1)
        // times the slide. The farthest stars sweep past at the turn's own
        // rate, about a fifth of a degree a second, and the nearest at a third of that.
        const slide = travel * 0.25;
        gl.uniform3f(uniforms.u_observer, -(slide * 0.75) % 3200 + x * 2.1, -(slide * 0.50) % 3200 + y * 1.5, 0);
        gl.uniform2f(uniforms.u_sweep, slide * 0.75 / ORBIT_CENTRE, slide * 0.50 / ORBIT_CENTRE);
      } else {
        gl.uniform3f(uniforms.u_observer, (travel * 0.75) % 3200 + x * 2.1,
          (travel * 0.50) % 3200 + y * 1.5, 0);
        gl.uniform2f(uniforms.u_sweep, 0, 0);
      }
      gl.uniform2f(uniforms.u_chart, this.size, this.inset);
      gl.uniform1f(uniforms.u_maxPoint, this.maxPoint);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, this.count);
      gl.disable(gl.BLEND);
      gl.disableVertexAttribArray(program.position);
      gl.disableVertexAttribArray(this.styleAttribute);
      gl.disableVertexAttribArray(this.wrapAttribute);
      gl.bindTexture(gl.TEXTURE_2D, this.target.texture);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }
  window.ParticleSky = ParticleSky;
})();
