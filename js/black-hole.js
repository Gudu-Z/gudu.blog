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
    uniform vec4 u_quiet;
    uniform float u_time;
    uniform float u_ink;
    uniform float u_chapter;
    uniform sampler2D u_inkAtlas;
    uniform sampler2D u_inkLight;
    uniform sampler2D u_starSky;
    uniform float u_starInset;
    #define PI 3.14159265359

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    // Integral of a periodic pulse over a pixel's 1D footprint, including
    // multiple lanes. Its mean remains duty, at every resolution.
    float laneIntegral(float x, float duty) {
      return floor(x) * duty + clamp(fract(x) - 0.5 + duty * 0.5, 0.0, duty);
    }
    float filteredLane(float phase, float duty, vec2 gradient) {
      float width = max(dot(abs(gradient), vec2(1.0)), 0.015);
      float coverage = (laneIntegral(phase + width * 0.5, duty)
        - laneIntegral(phase - width * 0.5, duty)) / width;
      // Filter each harmonic against both screen axes. A pulse's base
      // frequency alone misses the fine edges that alias before the lanes do.
      float frequency = max(abs(gradient.x), abs(gradient.y));
      float filtered = max(smoothstep(0.04, 0.08, frequency), smoothstep(0.5, 1.0, frequency / duty));
      if (filtered == 0.0) return coverage;
      // A positive, normalized Fejer kernel avoids negative Fourier ringing.
      // Clipping that ringing would recreate the frequencies just removed.
      float bandwidth = min(17.0, 0.48 / max(frequency, 0.0001));
      float bandLimited = duty;
      for (int harmonic = 1; harmonic <= 16; harmonic++) {
        float n = float(harmonic);
        if (n >= bandwidth) break;
        float weight = exp(-2.0 * PI * PI * 0.0625 * n * n * dot(gradient, gradient))
          * max(0.0, 1.0 - n / bandwidth);
        bandLimited += 2.0 * sin(PI * n * duty) / (PI * n)
          * cos(2.0 * PI * n * (fract(phase) - 0.5)) * weight;
      }
      // Blend by both spacing and actual strand width. Widely spaced lines
      // can still be narrower than a pixel; resolved strands keep their profile.
      return mix(coverage, bandLimited, filtered);
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
      float filament = filteredLane(streakPhase / (2.0 * PI), laneWidth * 2.0,
        streakGradient / (2.0 * PI));
      // Broad, slowly travelling illumination reveals depth without grain.
      float flowPhase = phase * 3.0 + r * 0.85;
      // Analytic gradients include orbital shear at long running times and
      // remain continuous through atan's wrap and multiple sine periods.
      vec2 flowGradient = phaseGradient * 3.0 + radialGradient * 0.85;
      float flowFilter = exp(-0.5 * dot(flowGradient, flowGradient));
      float flow = 0.76 + 0.24 * sin(flowPhase) * flowFilter;

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
      // The outer falloff belongs to surface coverage (traceLayers), rather
      // than darkening an opaque annulus that would mask the background.
      // Compress the Doppler contrast for balanced left/right readability.
      float balancedShift = mix(1.0, clamp(shift, 0.55, 1.65), 0.27);
      float energy = 2.5 * pow(3.0 / r, 1.18) * balancedShift;
      // A soft outer lip joins the disk through a wider, dimmer light shoulder.
      // Keep the near edge subdued so it does not read as a separate outline.
      // Both profiles preserve energy as their pixel footprint changes.
      float rimWidth = 0.070;
      float filteredWidth = sqrt(rimWidth * rimWidth + radialFootprint * radialFootprint / 12.0);
      float rim = exp(-0.5 * pow((r - 10.38) / filteredWidth, 2.0)) * rimWidth / filteredWidth;
      float shoulderWidth = 0.28;
      float filteredShoulder = sqrt(shoulderWidth * shoulderWidth + radialFootprint * radialFootprint / 12.0);
      float shoulder = exp(-0.5 * pow((r - 10.15) / filteredShoulder, 2.0)) * shoulderWidth / filteredShoulder;
      float edgeFacing = 0.72 - 0.22 * sin(phi);
      vec3 edgeLight = mix(pearl, white, 0.35) * (rim * 0.40 + shoulder * 0.15) * edgeFacing;
      // A small material-light lift keeps the distant disk readable. Apply it
      // before tone mapping and lane filtering so narrow strands stay stable.
      float chapterLight = mix(1.0, 1.18, u_chapter);
      energy *= chapterLight;
      edgeLight *= chapterLight;
      // Keep the disk luminous after removing the false brightness introduced
      // by tone-mapping an already averaged stripe. Endpoints retain soft highlights.
      const float diskExposure = 1.42;
      vec3 baseLight = (color * energy * (0.055 + 0.12 * bundles) * flow * innerEdge + edgeLight) * diskExposure;
      vec3 strandLight = color * energy * (0.28 + 1.15 * bundles) * flow * innerEdge * diskExposure;
      // Integrate displayed radiance: applying the nonlinear tone curve AFTER
      // averaging narrow stripes recreates harmonics and changes their mean.
      vec3 baseColor = 1.0 - exp(-baseLight * 1.45);
      vec3 strandColor = 1.0 - exp(-(baseLight + strandLight) * 1.45);
      return mix(baseColor, strandColor, filament);
    }
    float pigmentNoise(vec2 p) {
      vec2 cell = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), f.x),
        mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0)), f.x), f.y);
    }
    vec4 inkEmission(vec3 p, vec3 pointDx, vec3 pointDy, float order, vec3 ray) {
      float r = length(p.xz);
      float phi = atan(p.z, p.x);
      // A complete polar material sampled at real ray/surface intersections.
      // All illustrated image orders share a continuous angular coordinate.
      // A constant angular velocity keeps flowing indefinitely without winding
      // the brush fibres into subpixel radial shear. One orbit takes 52.36 s.
      float turn = (u_time - 12.0) * 0.12 / (2.0 * PI);
      vec2 uv = vec2(phi / (2.0 * PI) + 0.5 - turn, (r - 1.85) / 10.15);
      vec2 dr = vec2(dot(p.xz, pointDx.xz), dot(p.xz, pointDy.xz)) / r;
      vec2 dp = vec2(p.x * pointDx.z - p.z * pointDx.x,
        p.x * pointDy.z - p.z * pointDy.x) / (r * r * 2.0 * PI);
      vec4 pigment = vec4(0.5);
      vec3 movingLight = vec3(0.5), fixedLight = vec3(0.5);
      #ifdef HAS_TEXTURE_LOD
        // Explicit chart derivatives stay continuous across atan's seam and
        // remain defined at ray-march / material branch boundaries.
        pigment = texture2DGradEXT(u_inkAtlas, uv, vec2(dp.x, dr.x / 10.15), vec2(dp.y, dr.y / 10.15));
        movingLight = texture2DGradEXT(u_inkLight, uv, vec2(dp.x, dr.x / 10.15), vec2(dp.y, dr.y / 10.15)).rgb;
        fixedLight = texture2DGradEXT(u_inkLight, vec2(uv.x + turn, uv.y),
          vec2(dp.x, dr.x / 10.15), vec2(dp.y, dr.y / 10.15)).rgb;
      #endif
      vec3 rawPigment = pigment.rgb;
      // Advect pigment detail through a stationary illumination field. Correct
      // each image order before blending so their light levels never mix.
      pigment.rgb *= max(fixedLight, vec3(0.02)) / max(movingLight, vec3(0.02));
      // The illustration gives its lensed arc a distinct brush treatment.
      // Preserve each painted treatment on the same rotating polar surface.
      float arcBlend = smoothstep(-0.22, 0.22, dot(normalize(p), normalize(ray)));
      float painted = order < 1.5 ? mix(pigment.r, pigment.g, arcBlend) : pigment.b;
      float rawPainted = order < 1.5 ? mix(rawPigment.r, rawPigment.g, arcBlend) : rawPigment.b;
      float brushAngle = phi - (u_time - 12.0) * 0.12;
      vec2 materialPoint = r * vec2(cos(brushAngle), sin(brushAngle));
      float coarse = pigmentNoise(materialPoint * 3.2);
      float footprint = max(length(pointDx.xz), length(pointDy.xz));
      float fine = mix(0.5, pigmentNoise(materialPoint * 21.0), exp(-footprint * footprint * 440.0));
      // Pigment breaks on the paper in irregular islands, while broad strokes
      // remain continuous. This grain follows the orbit instead of boiling.
      float dry = smoothstep(0.27, 0.61, coarse * 0.65 + fine * 0.35);
      float density = clamp(painted * mix(0.95, 1.04, dry), 0.0, 0.99);
      vec3 color = vec3(1.06, 1.0, 0.88) * density * mix(1.0, 1.18, u_chapter);
      // Discontinuous dry-brush ends belong to the rotating material itself.
      // Lighting changes the ink's color, never its holes or silhouette.
      float edgeRadius = 11.1 + (rawPainted - 0.5) * 0.6 + (coarse - 0.5) * 1.1
        + 0.30 * sin(brushAngle * 3.0) + 0.16 * sin(brushAngle * 7.0 + 1.1);
      float edgeWidth = max(0.08, dot(abs(dr), vec2(1.0)) * 0.65);
      float outline = 1.0 - smoothstep(edgeRadius - edgeWidth, edgeRadius + edgeWidth, r);
      float wash = (1.0 - smoothstep(10.7, 11.95, r)) * 0.18;
      float coverage = max(outline, wash)
        * mix(1.0, smoothstep(0.016, 0.07, rawPainted), smoothstep(7.5, 9.5, r))
        * (1.0 - smoothstep(11.5, 12.0, r));
      return vec4(color * coverage, coverage);
    }
    float inkHeight(vec3 p) {
      float r = length(p.xz);
      float phase = atan(p.z, p.x) - (u_time - 12.0) * 0.12;
      return (0.075 * sin(phase * 3.0 + r * 0.65)
        + 0.035 * sin(phase * 7.0 - r)) * smoothstep(3.0, 7.0, r);
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
    // Every star comes from the XYZ particle pass. Explicit chart derivatives
    // keep lensed/minified stars filtered even across the longitude seam.
    vec3 minimalSky(vec3 ray, vec3 rayDx, vec3 rayDy) {
      vec3 d = normalize(ray);
      float horizontal = max(dot(d.xz, d.xz), 0.0001);
      float phi = atan(d.x, -d.z);
      float s = sin(phi * 0.5), c = cos(phi * 0.5);
      vec2 uv = vec2(atan(8.0 * s, c), atan(4.0 * d.y, sqrt(horizontal))) / PI + 0.5;
      vec2 jacobian = vec2(4.0 / (c*c + 64.0*s*s),
        4.0 / (horizontal + 16.0*d.y*d.y)) / PI;
      vec2 dx = vec2((-d.z * rayDx.x + d.x * rayDx.z) / horizontal,
        rayDx.y / sqrt(horizontal)) * jacobian;
      vec2 dy = vec2((-d.z * rayDy.x + d.x * rayDy.z) / horizontal,
        rayDy.y / sqrt(horizontal)) * jacobian;
      float interior = 1.0 - 2.0 * u_starInset;
      uv = u_starInset + uv * interior;
      dx *= interior; dy *= interior;
      #ifdef HAS_TEXTURE_LOD
        vec3 light = texture2DGradEXT(u_starSky, uv, dx, dy).rgb;
      #else
        // Called from a uniform theme branch, so implicit derivatives
        // remain defined. The padded longitude seam keeps filtering local.
        vec3 light = texture2D(u_starSky, uv).rgb;
      #endif
      // Leave genuine dark space between the compact stellar cores.
      return light;
    }
    struct RayHit {
      vec3 point;
      vec3 ray;
      float alpha;
      float material;
      float order;
    };
    RayHit orientSky(RayHit hit, vec3 origin, vec3 direction, vec3 right, vec3 up, vec3 forward, float roll) {
      if (u_ink < 0.5 && hit.material < -0.5) {
        // Use the escaped light direction at every impact parameter. Blending
        // it back to the camera ray would compress images and magnification.
        vec3 backgroundRay = normalize(hit.ray);
        vec3 local = vec3(dot(backgroundRay, right), dot(backgroundRay, up), -dot(backgroundRay, forward));
        local.xy = mat2(cos(roll), sin(roll), -sin(roll), cos(roll)) * local.xy;
        // The XYZ particle observer uses this unrolled local camera frame.
        hit.ray = normalize(local);
      }
      return hit;
    }
    RayHit traceLayers(vec3 origin, vec3 direction, float skipLayers) {
      RayHit hit;
      hit.point = vec3(6.0, 0.0, 0.0);
      hit.ray = direction;
      hit.alpha = 0.0;
      hit.material = 0.0;
      hit.order = 0.0;
      float crossings = 0.0;
      vec3 p = origin, v = direction;
      vec3 angular = cross(p, v);
      float h2 = dot(angular, angular);
      // The ink illustration keeps its existing distant-background shortcut.
      // Minimal sky rays must all bend: a radius cutoff creates a visible seam.
      if (u_ink > 0.5 && h2 > 210.0) {
        hit.material = -1.0;
      }
      else {
        for (int i = 0; i < 180; i++) {
          float r = length(p);
          if (r < 1.015) { hit.alpha = 1.0; break; }
          if (r > 42.0) {
            hit.material = -1.0;
            hit.ray = normalize(v);
            break;
          }
          float dt = clamp(r * 0.095, 0.055, 1.8);
          vec3 a = acceleration(p, h2);
          vec3 next = p + v * dt + 0.5 * a * dt * dt;
          vec3 nextV = v + 0.5 * (a + acceleration(next, h2)) * dt;
          float planeFrom = p.y, planeTo = next.y;
          if (u_ink > 0.5 && (abs(p.y) < 0.25 || abs(next.y) < 0.25 || p.y * next.y < 0.0)) {
            planeFrom -= inkHeight(p);
            planeTo -= inkHeight(next);
          }
          if (planeFrom * planeTo < 0.0) {
            hit.order = crossings;
            crossings += 1.0;
            float fraction = planeFrom / (planeFrom - planeTo);
            vec3 crossing = mix(p, next, fraction);
            float diskRadius = length(crossing.xz);
            if (diskRadius > mix(3.0, 1.85, u_ink) && diskRadius < mix(11.0, 12.0, u_ink)) {
              if (skipLayers > 0.5) { skipLayers -= 1.0; }
              else {
                hit.point = crossing;
                hit.ray = mix(v, nextV, fraction);
                // Separate the front disk from its outgoing, bent images. A
                // plane-crossing count alone merges the front and vaulted arc.
                hit.order = min(2.0, hit.order + step(0.0, dot(crossing, hit.ray)));
                hit.material = 1.0;
                hit.alpha = 1.0 - smoothstep(mix(9.8, 10.65, u_ink), 11.0, diskRadius);
                break;
              }
            }
          }
          p = next;
          v = nextV;
        }
      }
      return hit;
    }
    RayHit traceRay(vec3 origin, vec3 direction) {
      return traceLayers(origin, direction, 0.0);
    }
    vec3 surfaceDifferential(vec3 origin, vec3 direction, vec3 point) {
      // At an occlusion edge adjacent fragments can hit different image
      // orders. Match their physical surface before choosing the mip level;
      // otherwise a one-pixel seam samples an unrelated, heavily blurred texel.
      RayHit neighbour = traceRay(origin, direction);
      vec3 delta = neighbour.point - point;
      if (dot(delta, delta) > 0.09) {
        RayHit behind = traceLayers(origin, direction, 1.0);
        vec3 other = behind.point - point;
        if (behind.material > 0.5 && dot(other, other) < dot(delta, delta)) delta = other;
      }
      return delta;
    }
    vec4 shadeHit(RayHit hit, vec3 pointDx, vec3 pointDy, vec4 skyLight) {
      vec3 emission = vec3(0.0);
      float alpha = hit.alpha;
      if (u_ink > 0.5 && hit.material > 0.5) return inkEmission(hit.point, pointDx, pointDy, hit.order, hit.ray);
      if (hit.material > 0.5) return vec4(diskEmission(hit.point, hit.ray, pointDx, pointDy) * alpha, alpha);
      if (hit.material < -0.5) {
        if (u_ink < 0.5) return skyLight;
        emission = distantStars(hit.ray);
        alpha = max(emission.r, max(emission.g, emission.b));
      }
      emission = 1.0 - exp(-emission * 1.45);
      return vec4(emission * alpha, alpha);
    }
    void main() {
      float aspect = u_resolution.x / u_resolution.y;
      vec2 sceneUV = u_crop.xy + v_uv * u_crop.zw;
      vec2 cameraPointer = u_pointer * (1.0 - u_chapter);
      // Move the existing camera composition into the visible stage's centre.
      // The virtual figure rectangle stays fixed throughout the transition.
      vec2 screenOrigin = mix(vec2(0.50), u_crop.xy + u_crop.zw * 0.5, u_chapter);
      vec2 screen = (sceneUV - screenOrigin) * vec2(aspect, 1.0) * 2.0;
      screen -= vec2(0.06, -0.01) * u_ink * (1.0 - u_chapter);
      screen -= cameraPointer * vec2(0.012, 0.009);
      // Screen roll controls composition independently of the disk's 3D inclination.
      float screenRoll = (18.0 * (1.0 - u_chapter) + cameraPointer.x * 1.4) * PI / 180.0;
      screen = mat2(cos(screenRoll), -sin(screenRoll), sin(screenRoll), cos(screenRoll)) * screen;
      // Inclination is measured from the disk normal: 0° face-on, 90° edge-on.
      float diskInclination = (mix(81.0, 83.0, u_ink) + cameraPointer.y * 3.8) * PI / 180.0;
      float cameraDistance = 31.784430;
      // Ink parallax uses pitch, screen roll and pan. Orbiting the camera
      // around the disk normal would add apparent speed to its painted flow.
      float azimuth = cameraPointer.x * 0.10 * (1.0 - u_ink);
      vec3 origin = cameraDistance * vec3(sin(azimuth) * sin(diskInclination),
        cos(diskInclination), cos(azimuth) * sin(diskInclination));
      vec3 forward = normalize(-origin);
      vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(right, forward);
      float focal = mix(4.05, 3.70, u_ink) * mix(1.0, 0.34, u_chapter);
      vec3 direction = normalize(forward * focal + screen.x * right + screen.y * up);
      RayHit hit = traceRay(origin, direction);
      hit = orientSky(hit, origin, direction, right, up, forward, screenRoll);
      vec3 pointDx = vec3(0.0), pointDy = vec3(0.0);
      vec3 skyDx = vec3(0.0), skyDy = vec3(0.0);
      vec2 screenDx = vec2(0.0), screenDy = vec2(0.0);
      #ifdef HAS_DERIVATIVES
        // Every fragment reconverges here. Never evaluate derivatives inside
        // a ray-march or a material branch with different per-pixel control flow.
        pointDx = dFdx(hit.point);
        pointDy = dFdy(hit.point);
        screenDx = dFdx(screen);
        screenDy = dFdy(screen);
        skyDx = dFdx(hit.ray);
        skyDy = dFdy(hit.ray);
      #endif
      vec3 rayDx = normalize(forward * focal + (screen.x + screenDx.x) * right + (screen.y + screenDx.y) * up);
      vec3 rayDy = normalize(forward * focal + (screen.x + screenDy.x) * right + (screen.y + screenDy.y) * up);
      if (hit.material > 0.5) {
        // Ordinary pixels retain hardware derivatives; only discontinuities
        // need neighbouring rays, so surface filtering stays cheap and stable.
        if (dot(pointDx, pointDx) > 0.09) pointDx = surfaceDifferential(origin, rayDx, hit.point);
        if (dot(pointDy, pointDy) > 0.09) pointDy = surfaceDifferential(origin, rayDy, hit.point);
      }
      vec4 light = shadeHit(hit, pointDx, pointDy, vec4(0.0));
      // Both the minimal rim and transparent brush ends reveal the next
      // physical surface, rather than cutting a black band out of the rear arc.
      bool throughDisk = hit.material > 0.5 && light.a < 0.999;
      RayHit beneath = hit;
      if (throughDisk) beneath = orientSky(traceLayers(origin, direction, 1.0), origin, direction, right, up, forward, screenRoll);
      vec3 beneathDx = vec3(0.0), beneathDy = vec3(0.0);
      vec3 beneathSkyDx = vec3(0.0), beneathSkyDy = vec3(0.0);
      #ifdef HAS_DERIVATIVES
        beneathDx = dFdx(beneath.point);
        beneathDy = dFdy(beneath.point);
        beneathSkyDx = dFdx(beneath.ray);
        beneathSkyDy = dFdy(beneath.ray);
      #endif
      if (throughDisk && beneath.material > 0.5) {
        if (dot(beneathDx, beneathDx) > 0.09) beneathDx = surfaceDifferential(origin, rayDx, beneath.point);
        if (dot(beneathDy, beneathDy) > 0.09) beneathDy = surfaceDifferential(origin, rayDy, beneath.point);
      }
      // Filter the sky once per pixel. The four subrays below resolve surface
      // coverage; they share this already filtered sky radiance. Keeping the
      // star field outside shadeHit also avoids duplicating its shader code
      // at every surface/subray call site on WebGL 1 drivers.
      vec4 skyLight = vec4(0.0);
      bool primarySky = hit.material < -0.5;
      if (u_ink < 0.5) {
        vec3 radiance = minimalSky(primarySky ? hit.ray : beneath.ray,
          primarySky ? skyDx : beneathSkyDx, primarySky ? skyDy : beneathSkyDy);
        vec2 quiet = (v_uv - u_quiet.xy) / max(u_quiet.zw, vec2(0.001));
        float room = u_quiet.z > 0.0 ? mix(0.14, 1.0, smoothstep(0.55, 1.25, length(quiet))) : 1.0;
        room = mix(room, 1.0, u_chapter);
        radiance = (1.0 - exp(-radiance * 1.25)) * room;
        // Already premultiplied: do not square dim starlight by multiplying
        // it by its own opacity for a second time.
        skyLight = vec4(radiance, max(radiance.r, max(radiance.g, radiance.b)));
        if (primarySky) light = skyLight;
      }
      if (throughDisk) light += shadeHit(beneath, beneathDx, beneathDy, skyLight) * (1.0 - light.a);
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
          vec3 subRay = normalize(forward * focal + subScreen.x * right + subScreen.y * up);
          RayHit subHit = traceRay(origin, subRay);
          subHit = orientSky(subHit, origin, subRay, right, up, forward, screenRoll);
          vec3 subDx = pointDx, subDy = pointDy;
          vec3 subRayDx = normalize(forward * focal + (subScreen.x + screenDx.x) * right + (subScreen.y + screenDx.y) * up);
          vec3 subRayDy = normalize(forward * focal + (subScreen.x + screenDy.x) * right + (subScreen.y + screenDy.y) * up);
          // A subpixel ray can land on a different lensed image than its
          // centre ray. Reusing that centre's footprint leaves the newly
          // visible strands unfiltered at the shadow and overlap boundaries.
          if (u_ink < 0.5 && subHit.material > 0.5
              && (hit.material < 0.5 || distance(subHit.point, hit.point) > 0.3)) {
            subDx = surfaceDifferential(origin, subRayDx, subHit.point);
            subDy = surfaceDifferential(origin, subRayDy, subHit.point);
          }
          vec4 subLight = shadeHit(subHit, subDx, subDy, skyLight);
          if (subHit.material > 0.5 && subLight.a < 0.999) {
            RayHit subBeneath = traceLayers(origin, subRay, 1.0);
            subBeneath = orientSky(subBeneath, origin, subRay, right, up, forward, screenRoll);
            vec3 subBeneathDx = beneathDx, subBeneathDy = beneathDy;
            if (u_ink < 0.5 && subBeneath.material > 0.5
                && (beneath.material < 0.5 || distance(subBeneath.point, beneath.point) > 0.3)) {
              subBeneathDx = surfaceDifferential(origin, subRayDx, subBeneath.point);
              subBeneathDy = surfaceDifferential(origin, subRayDy, subBeneath.point);
            }
            subLight += shadeHit(subBeneath, subBeneathDx, subBeneathDy, skyLight) * (1.0 - subLight.a);
          }
          samples += subLight;
        }
        light = mix(light, samples * 0.25, edgeAA);
      }
      // Internal targets contain premultiplied light. The final pass converts
      // to straight alpha exactly once for the transparent WebGL canvas.
      if (u_ink < 0.5 && hit.material > -0.5) {
        float fade = 1.0 - smoothstep(0.70, 1.0, length((sceneUV - 0.5) * 1.7));
        fade = mix(fade, 1.0, u_chapter);
        // Fade foreground coverage into the escaped sky, rather than fading
        // the already composited background and leaving a dark outer seam.
        light = light * fade + skyLight * (1.0 - fade);
      }
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
          vec4 sampleLight = texture2D(u_scene, v_uv + vec2(x, float(j)) * u_texel);
          float peak = max(sampleLight.r, max(sampleLight.g, sampleLight.b));
          // Escaped sky stores alpha = peak radiance, while foreground
          // coverage exceeds its emitted light. Use that excess only here,
          // leaving the scene's premultiplied coverage entirely untouched.
          float foreground = smoothstep(0.001, 0.008, sampleLight.a - peak);
          // Saturated opaque disk strands can have almost no excess. Keep
          // their bloom: the normalized RGB8 sky, including ambient light,
          // stays below 0.74 after its 1.25-exposure tone map.
          foreground = max(foreground, smoothstep(0.78, 0.94, sampleLight.a));
          light += max(sampleLight.rgb - 0.22, 0.0) * foreground * w;
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
    uniform sampler2D u_splatter;
    uniform float u_hasSplatter;
    uniform vec2 u_texel;
    uniform vec4 u_crop;
    uniform float u_ink;
    uniform float u_chapter;
    uniform float u_softGlow;
    uniform float u_entranceGlow;
    void main() {
      vec4 scene = texture2D(u_scene, v_uv);
      if (u_ink > 0.5) {
        if (u_hasSplatter > 0.5) {
          vec4 splatter = texture2D(u_splatter, v_uv);
          scene += splatter * (1.0 - scene.a);
        }
        vec2 sceneUV = u_crop.xy + v_uv * u_crop.zw;
        vec2 border = min(sceneUV, 1.0 - sceneUV);
        float fade = smoothstep(0.0, 0.035, min(border.x, border.y));
        fade = mix(fade, 1.0, u_chapter);
        float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        gl_FragColor = vec4(scene.rgb * (0.94 + grain * 0.12) / max(scene.a, 0.001), scene.a * fade);
        return;
      }
      vec3 glow = vec3(0.0);
      float weights = 0.0;
      for (int i = -6; i <= 6; i++) {
        float y = float(i);
        float w = exp(-y * y / 16.0);
        glow += texture2D(u_bloom, v_uv + vec2(0.0, y * u_texel.y * 2.0)).rgb * w;
        weights += w;
      }
      vec2 sceneUV = u_crop.xy + v_uv * u_crop.zw;
      float fade = 1.0 - smoothstep(0.70, 1.0, length((sceneUV - 0.5) * 1.7));
      fade = mix(fade, 1.0, u_chapter);
      glow = glow / weights * mix(0.30, 0.42, u_chapter) * fade;
      #ifdef HAS_TEXTURE_LOD
        if (u_softGlow > 0.5 && u_chapter > 0.0) {
          // Coarse levels come from the already filtered, disk-only bloom.
          // Nine overlapping samples spread its actual light, without
          // amplifying the star atlas or adding another full-screen pass.
          vec3 halo = vec3(0.0);
          float haloWeights = 0.0;
          for (int x = -1; x <= 1; x++) {
            for (int y = -1; y <= 1; y++) {
              vec2 offset = vec2(float(x), float(y));
              float weight = exp(-dot(offset, offset) * 0.65);
              halo += texture2DLodEXT(u_bloom, v_uv + offset * u_texel * 12.0, 3.0).rgb * weight;
              haloWeights += weight;
            }
          }
          vec2 centerUV = mix((vec2(0.5) - u_crop.xy) / u_crop.zw, vec2(0.5), u_chapter);
          vec2 local = (v_uv - centerUV) * vec2(u_texel.y / u_texel.x, 1.0);
          float localFade = 1.0 - smoothstep(0.34, 0.65, length(local));
          glow += halo / haloWeights * (0.85 * u_chapter * localFade);
        }
      #endif
      // The entrance accent only amplifies light extracted from the disk.
      // The scene, star field and camera keep their ordinary chapter values.
      glow *= 1.0 + 0.30 * u_entranceGlow;
      vec3 color = 1.0 - (1.0 - scene.rgb) * exp(-glow * 1.2);
      float alpha = max(scene.a, max(color.r, max(color.g, color.b)));
      // Straight-alpha output; the light remains luminous over the star field.
      gl_FragColor = vec4(color / max(alpha, 0.001), alpha);
    }
  `;

  class BlackHole {
    constructor(canvas, { style = 'minimal' } = {}) {
      this.canvas = canvas;
      this.chapter = 0;
      this.setStyle(style);
      const options = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' };
      this.gl = canvas.getContext('webgl2', options) || canvas.getContext('webgl', options);
      this.webgl2 = typeof this.gl?.fenceSync === 'function';
      this.ready = false;
      this.lost = false;
      this.quality = 1;
      this.frameInterval = 1000 / 30;
      this.adaptAfter = 0;
      this.headroomSince = null;
      this.frameTimes = [];
      this.lastSample = 0;
      this.resources = [];
      this.generation = 0;
      this.disposed = false;
      this.compileWait = null;
      this.gpuQuery = null;
      this.gpuSync = null;
      this.gpuPendingSince = this.gpuWaitMs = 0;
      this.gpuFrameStartedAt = 0;
      this.gpuLastPollAt = 0;
      this.gpuTimingValid = false;
      this.gpuTimes = [];
      this.gpuUpperTimes = [];
      if (!this.gl) return;
      this.initialize().catch(error => console.warn('Using the static black-hole illustration.', error));
      this.handleContextLost = event => {
        if (this.disposed) return;
        event.preventDefault();
        this.ready = false;
        this.lost = true;
        this.cancelCompileWait();
        this.gpuQuery = null;
        this.gpuSync = null;
        canvas.parentElement.classList.remove('is-ready');
      };
      this.handleContextRestored = () => {
        if (this.disposed) return;
        this.resources = [];
        this.lost = false;
        this.initialize().catch(error => console.warn('The static illustration remains available.', error));
      };
      canvas.addEventListener('webglcontextlost', this.handleContextLost);
      canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    }

    static shaderSource(gl, type, source) {
      if (typeof gl.fenceSync === 'function') {
        const fragment = type === gl.FRAGMENT_SHADER;
        const converted = source
          .replace(/^\s*#(?:version|extension)[^\n]*$/gm, '')
          .replace(/\battribute\b/g, 'in')
          .replace(/\bvarying\b/g, fragment ? 'in' : 'out')
          .replace(/\btexture2DGradEXT\b/g, 'textureGrad')
          .replace(/\btexture2DLodEXT\b/g, 'textureLod')
          .replace(/\btexture2D\b/g, 'texture')
          .replace(/\bgl_FragColor\b/g, 'fragmentColor');
        return '#version 300 es\n#define HAS_DERIVATIVES\n#define HAS_TEXTURE_LOD\n'
          + (fragment ? 'out highp vec4 fragmentColor;\n' : '') + converted;
      }
      if (type !== gl.FRAGMENT_SHADER) return source;
      const derivatives = gl.getExtension('OES_standard_derivatives');
      const lod = gl.getExtension('EXT_shader_texture_lod');
      return (derivatives ? '#extension GL_OES_standard_derivatives : enable\n#define HAS_DERIVATIVES\n' : '')
        + (lod ? '#extension GL_EXT_shader_texture_lod : enable\n#define HAS_TEXTURE_LOD\n' : '') + source;
    }

    shader(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, BlackHole.shaderSource(gl, type, source));
      gl.compileShader(shader);
      // Querying COMPILE_STATUS here synchronously waits for the driver.
      // Validate the linked program after the non-blocking completion poll.
      return shader;
    }

    program(fragment, vertices = vertexSource) {
      const gl = this.gl;
      const vertex = this.shader(gl.VERTEX_SHADER, vertices);
      const pixel = this.shader(gl.FRAGMENT_SHADER, fragment);
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, pixel);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(pixel);
      this.resources.push({ type: 'program', value: program });
      return { value: program, position: -1, uniforms: {} };
    }

    async finishPrograms(programs, generation) {
      const gl = this.gl;
      const parallel = gl.getExtension('KHR_parallel_shader_compile');
      if (parallel) {
        while (!this.disposed && !this.lost && generation === this.generation
          && programs.some(program => !gl.getProgramParameter(program.value, parallel.COMPLETION_STATUS_KHR))) {
          await new Promise(resolve => {
            const timer = setTimeout(() => { this.compileWait = null; resolve(); }, 32);
            this.compileWait = { timer, resolve };
          });
        }
      }
      if (this.disposed || this.lost || generation !== this.generation) return false;
      for (const program of programs) {
        if (!gl.getProgramParameter(program.value, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program.value));
        const count = gl.getProgramParameter(program.value, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
          const info = gl.getActiveUniform(program.value, i);
          program.uniforms[info.name] = gl.getUniformLocation(program.value, info.name);
        }
        program.position = gl.getAttribLocation(program.value, 'a_position');
      }
      return true;
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

    async initialize() {
      if (this.disposed) return;
      const gl = this.gl;
      this.cancelCompileWait();
      this.ready = false;
      this.initialized = false;
      this.inkTexture = this.inkLightTexture = null;
      this.inkSplatter = null;
      this.particleSky = null;
      this.scene = this.bloom = this.composite = null;
      this.sceneTarget = this.bloomTarget = null;
      this.generation++;
      this.themePrograms = new Map();
      this.themeBuild = Promise.resolve();
      this.styleRequest = 0;
      this.inkLoaded = false;
      this.inkLoading = false;
      this.inkPromise = null;
      // WebGL 2 uses a completion fence, without asking the driver to gather
      // elapsed-time/timestamp queries for every rendered frame.
      const timerQuery = this.webgl2 ? null : gl.getExtension('EXT_disjoint_timer_query');
      this.timerQuery = timerQuery?.createQueryEXT ? timerQuery : null;
      this.gpuQuery = null;
      this.gpuSync = null;
      this.gpuPendingSince = this.gpuWaitMs = 0;
      this.gpuLastPollAt = 0;
      this.resetTiming();
      this.resizePending = false;
      this.maxTexture = 0;
      // A fixed-width approximation cannot safely filter the lensed filaments.
      // Older devices without derivatives use the matching rendered fallback.
      if (!this.webgl2 && !gl.getExtension('OES_standard_derivatives')) return;
      const generation = this.generation;
      if (!await this.prepareTheme(this.style, generation)
          || this.disposed || this.lost || generation !== this.generation) return;
      this.triangle = gl.createBuffer();
      this.resources.push({ type: 'buffer', value: this.triangle });
      gl.bindBuffer(gl.ARRAY_BUFFER, this.triangle);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      this.sceneTarget = this.target();
      this.bloomTarget = this.target();
      for (const name of ['inkTexture', 'inkLightTexture']) {
        this[name] = gl.createTexture();
        this.resources.push({ type: 'texture', value: this[name] });
        gl.bindTexture(gl.TEXTURE_2D, this[name]);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([8, 8, 8, 255]));
      }
      this.initialized = true;
      await this.activateStyle();
    }

    prepareTheme(style, generation) {
      const cached = this.themePrograms.get(style);
      if (cached) return cached;
      // A compile-time constant lets the driver discard the other theme's
      // ray/material paths. A uniform kept both enormous paths live, causing
      // multi-second cold compilation before the first frame could be drawn.
      // Serialize lazy builds so rapid theme changes never overlap the one
      // cancellable KHR_parallel_shader_compile completion poll.
      const prepared = this.themeBuild.catch(() => {}).then(async () => {
        if (this.disposed || this.lost || generation !== this.generation) return null;
        const specialize = source => source.replace('uniform float u_ink;',
          `const float u_ink = ${style === 'ink' ? '1.0' : '0.0'};`);
        const theme = {
          scene: this.program(specialize(sceneSource)),
          composite: this.program(specialize(compositeSource)),
          bloom: null,
          particleSky: null,
        };
        const programs = [theme.scene, theme.composite];
        if (style !== 'ink') {
          theme.bloom = this.program(bloomSource);
          theme.particleSky = new window.ParticleSky(this);
          programs.push(theme.bloom, theme.particleSky.program);
        }
        return await this.finishPrograms(programs, generation) ? theme : null;
      });
      this.themePrograms.set(style, prepared);
      this.themeBuild = prepared;
      return prepared;
    }

    async activateStyle() {
      this.resetTiming();
      const style = this.style, generation = this.generation;
      const request = ++this.styleRequest;
      this.ready = false;
      this.canvas.parentElement.classList.remove('is-ready');
      const current = () => !this.disposed && !this.lost
        && generation === this.generation && request === this.styleRequest && style === this.style;
      const theme = await this.prepareTheme(style, generation);
      if (!theme || !current()) return;
      if (style === 'ink' && !await this.loadInk()) return;
      if (!current()) return;
      this.scene = theme.scene;
      this.composite = theme.composite;
      this.bloom = theme.bloom;
      this.particleSky = theme.particleSky;
      // The atlas uses the actual requested viewport. Allocate its geometry
      // only on first minimal activation, never for an ink-only visit.
      this.ready = true;
      this.resize();
      this.ready = false;
      if (this.particleSky && !this.particleSky.target) this.particleSky.initialize();
      this.ready = true;
      this.onRestore?.();
    }

    loadInk() {
      if (this.inkLoaded) return Promise.resolve(true);
      if (this.inkPromise) return this.inkPromise;
      if (!this.inkTexture || (!this.webgl2 && !this.gl.getExtension('EXT_shader_texture_lod'))) return Promise.resolve(false);
      this.inkLoading = true;
      const generation = this.generation;
      const readImage = name => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Ink ${name} unavailable.`));
        image.src = `./assets/black-hole-ink-${name}.png?v=20261015-ink-light`;
      });
      this.inkPromise = Promise.all([readImage('material'), readImage('light')]).then(images => {
        if (this.disposed || this.lost || generation !== this.generation) return false;
        const gl = this.gl;
        try {
          // Brush detail and fixed illumination have the same periodic chart.
          gl.activeTexture(gl.TEXTURE0);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          // The grazing disk is highly anisotropic. Isotropic mipmaps would
          // erase the thin radial brush fibres along with angular aliasing.
          const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
          for (const [index, texture] of [this.inkTexture, this.inkLightTexture].entries()) {
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, images[index]);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            if (anisotropy) gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
              Math.min(8, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
          }
          const uploadError = gl.getError();
          if (uploadError !== gl.NO_ERROR) throw new Error(`Ink texture upload failed (${uploadError}).`);
          if (window.InkSplatter) this.inkSplatter = new window.InkSplatter(gl);
          this.inkLoaded = true;
          this.inkLoading = false;
          return true;
        } catch (error) {
          this.inkLoading = false;
          console.warn('Using the ink illustration fallback.', error);
          return false;
        } finally {
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        }
      }).catch(error => {
        if (this.disposed || this.lost || generation !== this.generation) return false;
        this.inkLoading = false;
        console.warn('Using the ink illustration fallback.', error);
        return false;
      }).finally(() => {
        if (generation === this.generation) this.inkPromise = null;
      });
      return this.inkPromise;
    }

    resize() {
      if (!this.ready || this.disposed || this.lost) return;
      const gl = this.gl;
      const figure = this.canvas.parentElement;
      const rect = figure.getBoundingClientRect();
      const stage = figure.closest('.hero-stage');
      const heroElement = stage || figure.closest('.hero');
      const hero = heroElement.getBoundingClientRect();
      const fullSky = Boolean(stage) || this.style !== 'ink';
      const left = fullSky ? hero.left : Math.max(rect.left, hero.left);
      const top = fullSky ? hero.top : Math.max(rect.top, hero.top);
      const visibleWidth = fullSky ? hero.width : Math.max(1, Math.min(rect.right, hero.right) - left);
      const visibleHeight = fullSky ? hero.height : Math.max(1, Math.min(rect.bottom, hero.bottom) - top);
      const offsetX = left - rect.left;
      const offsetY = top - rect.top;
      this.sceneWidth = rect.width;
      this.sceneHeight = rect.height;
      this.crop = [offsetX / rect.width, 1 - (offsetY + visibleHeight) / rect.height, visibleWidth / rect.width, visibleHeight / rect.height];
      const heading = heroElement.querySelector('.hero-heading')?.getBoundingClientRect();
      this.quiet = heading ? [
        (heading.left + heading.width * 0.5 - left) / visibleWidth,
        1 - (heading.top + heading.height * 0.45 - top) / visibleHeight,
        (heading.width * 0.65 + 30) / visibleWidth,
        (heading.height * 0.65 + 30) / visibleHeight,
      ] : [0, 0, 0, 0];
      // A fixed stage holds both themes through chapter transitions. Negative
      // crop coordinates extend the canvas without moving the virtual camera.
      // Older hero-only layouts retain their original ink clipping.
      Object.assign(this.canvas.style, {
        left: `${offsetX}px`, top: `${offsetY}px`,
        width: `${visibleWidth}px`, height: `${visibleHeight}px`,
      });
      // Cover native 1080p/1440p and useful high-DPI detail. The completion
      // fence still bounds queued work; sustained load lowers cadence first.
      const maxTexture = this.maxTexture ||= gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const pixelBudget = this.webgl2 ? 3700000 : this.timerQuery ? 1800000 : 900000;
      const scale = Math.min(devicePixelRatio || 1, this.webgl2 ? 2 : 1.5,
        (this.webgl2 ? 3200 : 2400) / visibleWidth,
        maxTexture / visibleWidth, maxTexture / visibleHeight,
        Math.sqrt(pixelBudget / (visibleWidth * visibleHeight))) * this.quality;
      this.nextWidth = Math.max(2, Math.round(visibleWidth * scale));
      this.nextHeight = Math.max(2, Math.round(visibleHeight * scale));
      this.resizePending = this.width !== this.nextWidth || this.height !== this.nextHeight
        || !this.sceneTarget.width;
    }

    allocateTargets() {
      if (!this.resizePending) return;
      const gl = this.gl;
      this.width = this.nextWidth;
      this.height = this.nextHeight;
      // Changing canvas dimensions clears the displayed buffer. Do it only
      // inside render(), directly before drawing its replacement in this task.
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
          this.initialized = false;
          this.canvas.parentElement.classList.remove('is-ready');
          return;
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.inkSplatter?.resize(this.width, this.height);
      this.resizePending = false;
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
      // Skip samplers removed by specialization; some drivers retain them.
      if (program.uniforms[name] == null) return;
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(program.uniforms[name], index);
    }

    render(time, x, y, chapter = this.chapter, entranceGlow = 0) {
      this.chapter = Math.max(0, Math.min(1, Number(chapter) || 0));
      entranceGlow = Math.max(0, Math.min(1, Number(entranceGlow) || 0));
      if (!this.ready || this.lost || this.disposed) return false;
      // Completion-capable contexts keep at most one frame in flight. Poll
      // without waiting; preserve the last presented frame while GPU is busy.
      if (!this.gpuAvailable()) return false;
      const frameStartedAt = performance.now();
      this.allocateTargets();
      if (!this.ready) return false;
      const gl = this.gl;
      if (this.timerQuery) {
        this.gpuQuery = this.timerQuery.createQueryEXT();
        this.timerQuery.beginQueryEXT(this.timerQuery.TIME_ELAPSED_EXT, this.gpuQuery);
        this.gpuTimingValid = true;
      }
      if (this.style !== 'ink') this.particleSky.render(time, x * (1 - this.chapter), y * (1 - this.chapter));
      this.use(this.scene, this.sceneTarget);
      gl.uniform2f(this.scene.uniforms.u_resolution, this.sceneWidth, this.sceneHeight);
      gl.uniform4fv(this.scene.uniforms.u_crop, this.crop);
      gl.uniform2f(this.scene.uniforms.u_pointer, x, y);
      gl.uniform4fv(this.scene.uniforms.u_quiet, this.quiet);
      gl.uniform1f(this.scene.uniforms.u_time, time);
      gl.uniform1f(this.scene.uniforms.u_chapter, this.chapter);
      // ANGLE can retain samplers from an unreachable theme branch. Bind all
      // reflected samplers explicitly so none keeps unit 0's previous scene
      // attachment, which would form a feedback loop on the next draw.
      this.texture(this.scene, 'u_inkAtlas', this.inkTexture, 0);
      this.texture(this.scene, 'u_inkLight', this.inkLightTexture, 1);
      this.texture(this.scene, 'u_starSky', this.particleSky?.target.texture || this.inkTexture, 2);
      if (this.particleSky) gl.uniform1f(this.scene.uniforms.u_starInset, this.particleSky.inset);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const hasSoftGlow = this.style !== 'ink' && this.webgl2 && this.chapter > 0;
      if (this.style !== 'ink') {
        this.use(this.bloom, this.bloomTarget);
        this.texture(this.bloom, 'u_scene', this.sceneTarget.texture, 0);
        gl.uniform2f(this.bloom.uniforms.u_texel, 1 / this.width, 1 / this.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        // WebGL 2 supports mipmaps for these viewport-sized, NPOT targets.
        // Their generation is inside the existing completion/timing budget.
        gl.bindTexture(gl.TEXTURE_2D, this.bloomTarget.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, hasSoftGlow ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        if (hasSoftGlow) gl.generateMipmap(gl.TEXTURE_2D);
      }

      const splatter = this.style === 'ink' ? this.inkSplatter?.render({
        time, x, y, chapter: this.chapter, width: this.width, height: this.height,
        sceneWidth: this.sceneWidth, sceneHeight: this.sceneHeight,
        crop: this.crop, sceneTexture: this.sceneTarget.texture,
      }) : null;
      this.use(this.composite, null);
      this.texture(this.composite, 'u_scene', this.sceneTarget.texture, 0);
      this.texture(this.composite, 'u_bloom', this.bloomTarget.texture, 1);
      this.texture(this.composite, 'u_splatter', splatter?.texture || this.inkTexture, 2);
      gl.uniform1f(this.composite.uniforms.u_hasSplatter, splatter ? 1 : 0);
      gl.uniform2f(this.composite.uniforms.u_texel, 1 / this.width, 1 / this.height);
      gl.uniform4fv(this.composite.uniforms.u_crop, this.crop);
      gl.uniform1f(this.composite.uniforms.u_chapter, this.chapter);
      gl.uniform1f(this.composite.uniforms.u_softGlow, hasSoftGlow ? 1 : 0);
      gl.uniform1f(this.composite.uniforms.u_entranceGlow, entranceGlow);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (this.gpuQuery) this.timerQuery.endQueryEXT(this.timerQuery.TIME_ELAPSED_EXT);
      if (this.webgl2) {
        this.gpuSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!this.gpuSync) return this.gpuFailed();
        this.gpuPendingSince = performance.now();
        this.gpuFrameStartedAt = frameStartedAt;
        this.gpuLastPollAt = this.gpuPendingSince;
        this.gpuTimingValid = true;
        this.gpuWaitMs = 0;
        // Submit the fence without waiting. Completion is polled on a later
        // animation tick, with a zero timeout, before another frame is queued.
        gl.flush();
      }
      this.canvas.parentElement.classList.add('is-ready');
      return true;
    }

    gpuAvailable() {
      if (this.webgl2) {
        if (!this.gpuSync) return true;
        const gl = this.gl;
        const now = performance.now();
        // A suspended tab or a very delayed callback cannot establish a
        // useful completion bound. Keep the fence, discard only its timing.
        if (now - this.gpuLastPollAt > 250) this.resetTiming();
        this.gpuLastPollAt = now;
        const status = gl.clientWaitSync(this.gpuSync, 0, 0);
        const completedAt = performance.now();
        if (status === gl.TIMEOUT_EXPIRED) {
          this.gpuWaitMs = Math.max(this.gpuWaitMs, now - this.gpuPendingSince);
          return false;
        }
        gl.deleteSync(this.gpuSync);
        this.gpuSync = null;
        if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return this.gpuFailed();
        if (this.gpuTimingValid) this.recordGpuCost(this.gpuWaitMs, completedAt - this.gpuFrameStartedAt);
        return true;
      }
      if (!this.gpuQuery) return true;
      const ext = this.timerQuery;
      // A GPU clock reset invalidates outstanding timings; an invalid query
      // need not become available, so discard it before polling completion.
      if (this.gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        ext.deleteQueryEXT(this.gpuQuery);
        this.gpuQuery = null;
        this.gpuTimes = [];
        this.gpuUpperTimes = [];
        this.headroomSince = null;
        return true;
      }
      if (!ext.getQueryObjectEXT(this.gpuQuery, ext.QUERY_RESULT_AVAILABLE_EXT)) return false;
      const milliseconds = ext.getQueryObjectEXT(this.gpuQuery, ext.QUERY_RESULT_EXT) / 1000000;
      if (this.gpuTimingValid) this.recordGpuCost(milliseconds);
      ext.deleteQueryEXT(this.gpuQuery);
      this.gpuQuery = null;
      return true;
    }

    gpuFailed() {
      this.ready = this.initialized = false;
      this.canvas.parentElement.classList.remove('is-ready');
      return false;
    }

    pollGpu() {
      if (!this.ready || this.lost || this.disposed) return false;
      return this.gpuAvailable();
    }

    recordGpuCost(lower, upper = lower) {
      this.gpuTimes.push(lower);
      this.gpuUpperTimes.push(upper);
      if (this.gpuTimes.length >= 8) {
        const median = values => {
          const sorted = values.sort((a, b) => a - b);
          return (sorted[3] + sorted[4]) * 0.5;
        };
        // Incomplete polls prove a lower bound; completion proves an upper
        // bound. Never interpret a first completed poll as zero-cost work.
        const cost = median(this.gpuTimes), ceiling = median(this.gpuUpperTimes);
        this.gpuTimes = [];
        this.gpuUpperTimes = [];
        const now = performance.now();
        if (cost > this.frameInterval * 0.8) {
          this.headroomSince = null;
          if (now < this.adaptAfter) return;
          if (this.frameInterval < 49) this.frameInterval = 50;
          else if (this.frameInterval < 66) this.frameInterval = 1000 / 15;
          else if (this.quality > 0.7) {
            this.quality = Math.max(0.7, this.quality * 0.9);
            this.resize();
          }
          this.adaptAfter = now + 2000;
          return;
        }
        // Recover detail before frame rate. Predict the next resolution's
        // area cost, and require sustained headroom with a separate threshold.
        const nextQuality = Math.min(1, this.quality + 0.05);
        const nextInterval = this.frameInterval > 50 ? 50 : 1000 / 30;
        const predicted = ceiling * (nextQuality / this.quality) ** 2;
        const canRecover = this.quality < 1
          ? predicted <= this.frameInterval * 0.65
          : this.frameInterval > nextInterval && ceiling <= nextInterval * 0.65;
        if (!canRecover || now < this.adaptAfter) { this.headroomSince = null; return; }
        if (this.headroomSince === null) this.headroomSince = now;
        if (now - this.headroomSince < 5000) return;
        if (this.quality < 1) { this.quality = nextQuality; this.resize(); }
        else this.frameInterval = nextInterval;
        this.adaptAfter = now + 2000;
        this.headroomSince = null;
      }
    }

    sampleFrame(timestamp) {
      if (this.webgl2 || this.timerQuery) return;
      if (this.lastSample) this.frameTimes.push(timestamp - this.lastSample);
      this.lastSample = timestamp;
      if (this.frameTimes.length < 45) return;
      const average = this.frameTimes.reduce((sum, ms) => sum + ms, 0) / this.frameTimes.length;
      this.frameTimes = [];
      if (average > this.frameInterval * 1.6) {
        // Without a completion/timing facility, on-time JS submissions do
        // not prove GPU headroom. Use slow cadence only for conservative load
        // reduction, not automatic upscaling on this legacy fallback.
        for (let i = 0; i < 8; i++) this.recordGpuCost(average, Infinity);
      }
    }

    cancelCompileWait() {
      if (!this.compileWait) return;
      clearTimeout(this.compileWait.timer);
      this.compileWait.resolve();
      this.compileWait = null;
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.ready = this.initialized = false;
      this.generation++;
      this.onRestore = null;
      this.cancelCompileWait();
      this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
      this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
      const gl = this.gl;
      if (gl && !this.lost) {
        if (this.gpuSync) gl.deleteSync(this.gpuSync);
        if (this.gpuQuery) this.timerQuery.deleteQueryEXT(this.gpuQuery);
        this.inkSplatter?.dispose();
        const remove = { program: 'deleteProgram', texture: 'deleteTexture', framebuffer: 'deleteFramebuffer', buffer: 'deleteBuffer' };
        for (const { type, value } of this.resources) gl[remove[type]](value);
        // Delete handles without a synchronous finish/readback/context-loss.
        // Forced loseContext() can block the Intel/ANGLE driver for seconds;
        // let the browser retire the context as the document is discarded.
      }
      this.resources = [];
      this.gpuQuery = this.gpuSync = this.inkSplatter = null;
      this.particleSky = null;
      this.themePrograms?.clear();
    }

    resetTiming() {
      this.lastSample = 0;
      this.frameTimes = [];
      this.gpuTimes = [];
      this.gpuUpperTimes = [];
      this.headroomSince = null;
      this.gpuTimingValid = false;
    }
    setStyle(style) {
      const next = style === 'ink' ? 'ink' : 'minimal';
      if (next === this.style && this.ready) return;
      this.style = next;
      if (!this.initialized || this.lost || this.disposed) return;
      this.activateStyle().catch(error => console.warn('Using the requested black-hole illustration.', error));
    }
  }
  window.BlackHole = BlackHole;
})();
