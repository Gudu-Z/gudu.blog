/* Matte ink droplets projected from the same 3D camera as the black-hole disk. */
(() => {
  'use strict';

  const vertexSource = `
    precision highp float;
    attribute vec3 a_position;
    attribute float a_seed;
    uniform float u_time;
    uniform vec2 u_pointer;
    uniform float u_aspect;
    uniform vec4 u_crop;
    uniform float u_pointScale;
    uniform vec2 u_pointSizeRange;
    varying float v_seed;
    varying float v_alpha;
    varying float v_size;
    float random(float seed) { return fract(sin(seed * 127.1 + 43.7) * 43758.5453); }
    void main() {
      float angle = (u_time - 12.0) * 0.12;
      float c = cos(angle), s = sin(angle);
      // Increasing atan(z, x) follows the disk material's phi - time * 0.12.
      vec3 point = vec3(c * a_position.x - s * a_position.z,
        a_position.y, s * a_position.x + c * a_position.z);
      float inclination = radians(83.0 + u_pointer.y * 3.8);
      float azimuth = 0.0;
      float distance = 31.784430;
      vec3 origin = distance * vec3(sin(azimuth) * sin(inclination),
        cos(inclination), cos(azimuth) * sin(inclination));
      vec3 forward = normalize(-origin);
      vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(right, forward);
      vec3 relative = point - origin;
      float depth = dot(relative, forward);
      vec2 projected = vec2(dot(relative, right), dot(relative, up)) * (3.7 / max(depth, 0.01));
      float roll = radians(18.0 + u_pointer.x * 1.4);
      // Invert the ray shader's screen rotation, then its offset and UV crop.
      vec2 screen = vec2(cos(roll) * projected.x - sin(roll) * projected.y,
        sin(roll) * projected.x + cos(roll) * projected.y);
      screen += vec2(0.06, -0.01) + u_pointer * vec2(0.012, 0.009);
      vec2 sceneUV = 0.5 + screen / vec2(u_aspect, 1.0) * 0.5;
      vec2 targetUV = (sceneUV - u_crop.xy) / u_crop.zw;
      gl_Position = depth > 0.01 ? vec4(targetUV * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);

      float sizeSeed = random(a_seed + 2.1);
      float smallSize = 1.10 + 0.85 * random(a_seed + 4.9);
      float baseSize = mix(smallSize, 2.5 + sizeSeed * 0.7, step(0.94, sizeSeed));
      float perspective = clamp(sqrt(distance / max(depth, 0.01)), 0.8, 1.3);
      float requestedSize = min(baseSize * perspective, 3.6) * u_pointScale;
      gl_PointSize = clamp(requestedSize, u_pointSizeRange.x, u_pointSizeRange.y);
      v_size = gl_PointSize;
      v_seed = a_seed;
      v_alpha = (0.42 + 0.44 * random(a_seed + 8.3))
        * min(1.0, requestedSize * requestedSize / (gl_PointSize * gl_PointSize));
    }
  `;

  const fragmentSource = `
    precision highp float;
    uniform sampler2D u_scene;
    uniform vec2 u_resolution;
    varying float v_seed;
    varying float v_alpha;
    varying float v_size;
    float random(float seed) { return fract(sin(seed * 127.1 + 43.7) * 43758.5453); }
    void main() {
      float sceneAlpha = texture2D(u_scene, gl_FragCoord.xy / u_resolution).a;
      float visibility = 1.0 - smoothstep(0.03, 0.22, sceneAlpha);
      if (visibility <= 0.0) discard;
      vec2 point = (gl_PointCoord - 0.5) * 2.0;
      float slant = random(v_seed + 12.4) * 6.28318530718;
      point = mat2(cos(slant), sin(slant), -sin(slant), cos(slant)) * point;
      point *= vec2(0.90, 1.10);
      float radius = length(point);
      // A small irregular edge produces a drop of pigment, without rays or glow.
      float edge = 0.78 + 0.045 * sin(atan(point.y, point.x) * 3.0 + v_seed * 19.0);
      float feather = min(0.55, 0.9 / max(v_size, 1.0));
      float coverage = 1.0 - smoothstep(edge - feather, edge + feather, radius);
      float alpha = coverage * visibility * v_alpha;
      if (alpha < 0.002) discard;
      vec3 pigment = mix(vec3(0.46, 0.43, 0.37), vec3(0.88, 0.84, 0.74), random(v_seed + 17.2));
      gl_FragColor = vec4(pigment * alpha, alpha);
    }
  `;

  function makeProgram(gl) {
    const shaders = [];
    let program = null;
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Cannot create the ink splatter shader.');
        shaders.push(shader);
        gl.shaderSource(shader, window.BlackHole.shaderSource(gl, type, source));
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      }
      program = gl.createProgram();
      if (!program) throw new Error('Cannot create the ink splatter program.');
      for (const shader of shaders) gl.attachShader(program, shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      return program;
    } catch (error) {
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  function pointData(count) {
    let seed = 0x4d3a2917;
    const random = () => {
      seed |= 0;
      seed = seed + 0x6d2b79f5 | 0;
      let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
      value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    const centers = [0.35, 2.90, 4.65];
    const spreads = [0.24, 0.34, 0.20];
    const points = new Float32Array(count * 4);
    for (let index = 0; index < count; index++) {
      const selection = random();
      const cluster = selection < 0.48 ? 0 : selection < 0.83 ? 1 : 2;
      const angle = centers[cluster] + (random() + random() + random() - 1.5) * 2 * spreads[cluster];
      const radius = 9.5 + 3.8 * Math.sqrt(random());
      points.set([
        Math.cos(angle) * radius,
        (random() + random() - 1) * 1.4,
        Math.sin(angle) * radius,
        random(),
      ], index * 4);
    }
    return points;
  }

  class InkSplatter {
    constructor(gl) {
      this.gl = gl;
      this.ready = false;
      this.count = 384;
      this.program = null;
      this.buffer = null;
      this.target = null;
      if (!gl || gl.isContextLost()) return;
      const previousBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
      try {
        this.program = makeProgram(gl);
        this.position = gl.getAttribLocation(this.program, 'a_position');
        this.seed = gl.getAttribLocation(this.program, 'a_seed');
        this.uniforms = Object.fromEntries(['u_time', 'u_pointer', 'u_aspect', 'u_crop',
          'u_pointScale', 'u_pointSizeRange', 'u_scene', 'u_resolution']
          .map(name => [name, gl.getUniformLocation(this.program, name)]));
        this.pointSizeRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
        this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        this.buffer = gl.createBuffer();
        this.target = { texture: gl.createTexture(), buffer: gl.createFramebuffer(), width: 0, height: 0 };
        if (!this.buffer || !this.target.texture || !this.target.buffer) throw new Error('Cannot allocate ink splatter resources.');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, pointData(this.count), gl.STATIC_DRAW);
        this.resize(1, 1);
      } catch (error) {
        this.dispose();
        console.warn('Ink splatter is unavailable.', error);
      } finally {
        gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer);
      }
    }

    resize(width, height) {
      const gl = this.gl;
      if (!this.program || !this.target || gl.isContextLost()) return false;
      width = Math.max(1, Math.min(this.maxTextureSize, Math.floor(Number(width) || 1)));
      height = Math.max(1, Math.min(this.maxTextureSize, Math.floor(Number(height) || 1)));
      if (this.ready && this.target.width === width && this.target.height === height) return true;
      const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const texture = gl.getParameter(gl.TEXTURE_BINDING_2D);
      try {
        gl.bindTexture(gl.TEXTURE_2D, this.target.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.buffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target.texture, 0);
        this.ready = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        this.target.width = width;
        this.target.height = height;
      } finally {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      }
      return this.ready;
    }

    render({ time = 12, x = 0, y = 0, width, height, sceneWidth, sceneHeight, crop = [0, 0, 1, 1], sceneTexture }) {
      const gl = this.gl;
      if (!this.program || !sceneTexture || gl.isContextLost() || !(sceneWidth > 0 && sceneHeight > 0)
        || !(crop[2] > 0 && crop[3] > 0) || !this.resize(width, height)) return null;
      const state = {
        framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
        viewport: gl.getParameter(gl.VIEWPORT),
        program: gl.getParameter(gl.CURRENT_PROGRAM),
        buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
        activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
        colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
        clearColor: gl.getParameter(gl.COLOR_CLEAR_VALUE),
        blend: [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA,
          gl.BLEND_EQUATION_RGB, gl.BLEND_EQUATION_ALPHA].map(parameter => gl.getParameter(parameter)),
        capabilities: [gl.BLEND, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.STENCIL_TEST].map(capability => [capability, gl.isEnabled(capability)]),
        attributes: [this.position, this.seed].map(index => ({
          index,
          enabled: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_ENABLED),
          buffer: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),
          size: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_SIZE),
          type: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_TYPE),
          normalized: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED),
          stride: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_STRIDE),
          offset: gl.getVertexAttribOffset(index, gl.VERTEX_ATTRIB_ARRAY_POINTER),
        })),
      };
      gl.activeTexture(gl.TEXTURE0);
      const texture = gl.getParameter(gl.TEXTURE_BINDING_2D);
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.buffer);
        gl.viewport(0, 0, this.target.width, this.target.height);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.colorMask(true, true, true, true);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.position);
        gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(this.seed);
        gl.vertexAttribPointer(this.seed, 1, gl.FLOAT, false, 16, 12);
        gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
        gl.uniform1i(this.uniforms.u_scene, 0);
        gl.uniform1f(this.uniforms.u_time, time);
        gl.uniform2f(this.uniforms.u_pointer, x, y);
        gl.uniform1f(this.uniforms.u_aspect, sceneWidth / sceneHeight);
        gl.uniform4fv(this.uniforms.u_crop, crop);
        gl.uniform2f(this.uniforms.u_resolution, this.target.width, this.target.height);
        gl.uniform1f(this.uniforms.u_pointScale, this.target.width / (sceneWidth * crop[2]));
        gl.uniform2fv(this.uniforms.u_pointSizeRange, this.pointSizeRange);
        gl.drawArrays(gl.POINTS, 0, this.count);
      } finally {
        for (const attribute of state.attributes) {
          if (attribute.buffer) {
            gl.bindBuffer(gl.ARRAY_BUFFER, attribute.buffer);
            gl.vertexAttribPointer(attribute.index, attribute.size, attribute.type, attribute.normalized, attribute.stride, attribute.offset);
          }
          if (attribute.enabled) gl.enableVertexAttribArray(attribute.index);
          else gl.disableVertexAttribArray(attribute.index);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.activeTexture(state.activeTexture);
        gl.useProgram(state.program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
        gl.viewport(...state.viewport);
        gl.colorMask(...state.colorMask);
        gl.clearColor(...state.clearColor);
        gl.blendFuncSeparate(...state.blend.slice(0, 4));
        gl.blendEquationSeparate(...state.blend.slice(4));
        for (const [capability, enabled] of state.capabilities) {
          if (enabled) gl.enable(capability);
          else gl.disable(capability);
        }
      }
      return this.target;
    }

    dispose() {
      const gl = this.gl;
      if (gl) {
        if (this.buffer) gl.deleteBuffer(this.buffer);
        if (this.target?.texture) gl.deleteTexture(this.target.texture);
        if (this.target?.buffer) gl.deleteFramebuffer(this.target.buffer);
        if (this.program) gl.deleteProgram(this.program);
      }
      this.ready = false;
      this.buffer = this.program = this.target = null;
    }
  }

  window.InkSplatter = InkSplatter;
})();
