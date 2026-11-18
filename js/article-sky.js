/* The article page's sky: the home page's XYZ particle stars
 * (js/particle-sky.js), seen through the hero's camera without the black hole
 * and drifting at the hero's speed, over the still stars of js/star-sky.js.
 * The sky is fixed behind the page, so scrolling moves only the article. It pauses in a hidden tab, and under
 * reduced motion it holds the opening sky still.
 */
(() => {
  'use strict';

  const canvas = document.querySelector('.article-sky > canvas[data-particle-sky]');
  if (!canvas || !window.ParticleSky) return;

  const options = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' };
  const gl = canvas.getContext('webgl2', options) || canvas.getContext('webgl', options);
  if (!gl) { canvas.hidden = true; return; }

  const vertexSource = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;
  // The hero's sky for a ray that never bends (js/black-hole.js, minimalSky):
  // the same chart, tone and daylight negative, with the hero's focal length.
  const screenSource = `
    precision highp float;
    varying vec2 v_uv;
    uniform sampler2D u_starSky;
    uniform float u_starInset;
    uniform vec2 u_resolution;
    uniform float u_day;
    uniform float u_gain;
    #define PI 3.14159265359
    void main() {
      vec2 screen = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0) * 2.0;
      vec3 d = normalize(vec3(screen, -4.05));
      float horizontal = max(dot(d.xz, d.xz), 0.0001);
      float phi = atan(d.x, -d.z);
      float s = sin(phi * 0.5), c = cos(phi * 0.5);
      vec2 uv = vec2(atan(8.0 * s, c), atan(4.0 * d.y, sqrt(horizontal))) / PI + 0.5;
      uv = u_starInset + uv * (1.0 - 2.0 * u_starInset);
      vec3 radiance = 1.0 - exp(-texture2D(u_starSky, uv).rgb * 1.25);
      float peak = max(radiance.r, max(radiance.g, radiance.b));
      gl_FragColor = vec4(mix(radiance, peak - radiance, u_day), peak * u_gain);
    }
  `;

  // The few renderer services js/particle-sky.js asks of its owner.
  const owner = {
    gl,
    resources: [],
    nextWidth: 0,
    program(fragment, vertex = vertexSource) {
      const program = gl.createProgram();
      for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
        gl.deleteShader(shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      const uniforms = {};
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const { name } = gl.getActiveUniform(program, i);
        uniforms[name] = gl.getUniformLocation(program, name);
      }
      return { value: program, position: gl.getAttribLocation(program, 'a_position'), uniforms };
    },
    target() {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const buffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return { texture, buffer };
    },
  };

  let sky, screen, triangle;
  try {
    sky = new window.ParticleSky(owner);
    screen = owner.program(screenSource);
    triangle = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  } catch {
    canvas.hidden = true;
    return;
  }

  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  // The hero's clock starts at 12 and counts active seconds only.
  let elapsed = 12, activeSince = null, frame = 0, atlas = 0, lost = false;
  let cssWidth = 0, cssHeight = 0;
  const clock = () => elapsed + (activeSince === null ? 0 : (performance.now() - activeSince) / 1000);

  function fail() {
    lost = true;
    stop();
    canvas.hidden = true;
  }

  // The canvas size comes from the ResizeObserver, so frames read no layout.
  function resize() {
    if (!cssWidth || !cssHeight) return false;
    // The hero's pixel budget: high-DPI detail without an unbounded cost.
    const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3700000 / (cssWidth * cssHeight)));
    const width = Math.max(2, Math.round(cssWidth * scale)), height = Math.max(2, Math.round(cssHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    // As on the hero, narrow screens chart the sky at half the resolution.
    const wanted = width <= 900 ? 1024 : 2048;
    if (atlas !== wanted) {
      owner.nextWidth = width;
      if (sky.target) {
        gl.deleteTexture(sky.target.texture);
        gl.deleteFramebuffer(sky.target.buffer);
        if (sky.buffer) gl.deleteBuffer(sky.buffer);
      }
      try {
        sky.initialize();
      } catch {
        fail();
        return false;
      }
      atlas = wanted;
    }
    return true;
  }

  function draw() {
    if (lost || !resize()) return;
    sky.render(clock(), 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(screen.value);
    gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
    gl.enableVertexAttribArray(screen.position);
    gl.vertexAttribPointer(screen.position, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sky.target.texture);
    gl.uniform1i(screen.uniforms.u_starSky, 0);
    gl.uniform1f(screen.uniforms.u_starInset, sky.inset);
    gl.uniform2f(screen.uniforms.u_resolution, canvas.width, canvas.height);
    const day = document.documentElement.dataset.theme === 'light';
    gl.uniform1f(screen.uniforms.u_day, day ? 1 : 0);
    // By day the dark points read as dust under the text, so they show at
    // two fifths, as in the home page chapters.
    gl.uniform1f(screen.uniforms.u_gain, day ? 0.4 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(screen.position);
  }

  function tick() {
    frame = 0;
    draw();
    if (activeSince !== null) frame = requestAnimationFrame(tick);
  }

  function start() {
    if (lost || document.hidden || still.matches || activeSince !== null) return;
    activeSince = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    if (activeSince !== null) {
      elapsed = clock();
      activeSince = null;
    }
    cancelAnimationFrame(frame);
    frame = 0;
  }

  // A still frame repaints when something other than time changes it.
  function repaint() {
    if (activeSince === null) draw();
  }

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  still.addEventListener('change', () => {
    if (still.matches) { stop(); draw(); } else start();
  });
  window.addEventListener('site:theme', repaint);
  new ResizeObserver(([entry]) => {
    cssWidth = entry.contentRect.width;
    cssHeight = entry.contentRect.height;
    repaint();
  }).observe(canvas);
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); fail(); });
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', event => { if (event.persisted) start(); });

  const box = canvas.getBoundingClientRect();
  cssWidth = box.width;
  cssHeight = box.height;
  draw();
  start();
})();
