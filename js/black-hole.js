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
    uniform float u_ink;
    uniform sampler2D u_inkAtlas;
    uniform sampler2D u_inkLight;
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
      float bandLimited = duty;
      for (int harmonic = 1; harmonic <= 8; harmonic++) {
        float n = float(harmonic);
        float weight = exp(-2.0 * PI * PI * 0.1444 * n * n * dot(gradient, gradient))
          * (1.0 - smoothstep(0.38, 0.5, n * frequency));
        bandLimited += 2.0 * sin(PI * n * duty) / (PI * n)
          * cos(2.0 * PI * n * (fract(phase) - 0.5)) * weight;
      }
      // Wide, resolved strands keep their original profile. Only compressed
      // strands use the band-limited profile instead of flickering between pixels.
      return mix(clamp(coverage, 0.0, 1.0), clamp(bandLimited, 0.0, 1.0),
        smoothstep(0.04, 0.08, frequency));
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
      // Lift the minimalist disk before tone mapping, so dim strands become
      // clearer while the brightest lanes keep their smooth highlight rolloff.
      const float diskExposure = 1.22;
      return (color * energy * texture * innerEdge + edgeLight) * diskExposure;
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
      vec3 color = vec3(1.06, 1.0, 0.88) * density;
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
    struct RayHit {
      vec3 point;
      vec3 ray;
      float alpha;
      float material;
      float order;
    };
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
      if (h2 > mix(140.0, 210.0, u_ink)) hit.material = -1.0;
      else {
        for (int i = 0; i < 180; i++) {
          float r = length(p);
          if (r < 1.015) { hit.alpha = 1.0; break; }
          if (r > 42.0) { hit.material = -1.0; hit.ray = normalize(v); break; }
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
    vec4 shadeHit(RayHit hit, vec3 pointDx, vec3 pointDy) {
      vec3 emission = vec3(0.0);
      float alpha = hit.alpha;
      if (u_ink > 0.5 && hit.material > 0.5) return inkEmission(hit.point, pointDx, pointDy, hit.order, hit.ray);
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
      vec2 cameraPointer = u_pointer;
      vec2 screen = (sceneUV - vec2(0.50)) * vec2(aspect, 1.0) * 2.0;
      screen -= vec2(0.06, -0.01) * u_ink;
      screen -= cameraPointer * vec2(0.012, 0.009);
      // Screen roll controls composition independently of the disk's 3D inclination.
      float screenRoll = (18.0 + cameraPointer.x * 1.4) * PI / 180.0;
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
      float focal = mix(4.05, 3.70, u_ink);
      vec3 direction = normalize(forward * focal + screen.x * right + screen.y * up);
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
      vec3 rayDx = normalize(forward * focal + (screen.x + screenDx.x) * right + (screen.y + screenDx.y) * up);
      vec3 rayDy = normalize(forward * focal + (screen.x + screenDy.x) * right + (screen.y + screenDy.y) * up);
      if (hit.material > 0.5) {
        // Ordinary pixels retain hardware derivatives; only discontinuities
        // need neighbouring rays, so surface filtering stays cheap and stable.
        if (dot(pointDx, pointDx) > 0.09) pointDx = surfaceDifferential(origin, rayDx, hit.point);
        if (dot(pointDy, pointDy) > 0.09) pointDy = surfaceDifferential(origin, rayDy, hit.point);
      }
      vec4 light = shadeHit(hit, pointDx, pointDy);
      // Both the minimal rim and transparent brush ends reveal the next
      // physical surface, rather than cutting a black band out of the rear arc.
      bool throughDisk = hit.material > 0.5 && light.a < 0.999;
      RayHit beneath = hit;
      if (throughDisk) beneath = traceLayers(origin, direction, 1.0);
      vec3 beneathDx = vec3(0.0), beneathDy = vec3(0.0);
      #ifdef HAS_DERIVATIVES
        beneathDx = dFdx(beneath.point);
        beneathDy = dFdy(beneath.point);
      #endif
      if (throughDisk && beneath.material > 0.5) {
        if (dot(beneathDx, beneathDx) > 0.09) beneathDx = surfaceDifferential(origin, rayDx, beneath.point);
        if (dot(beneathDy, beneathDy) > 0.09) beneathDy = surfaceDifferential(origin, rayDy, beneath.point);
      }
      if (throughDisk) light += shadeHit(beneath, beneathDx, beneathDy) * (1.0 - light.a);
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
          vec4 subLight = shadeHit(subHit, subDx, subDy);
          if (subHit.material > 0.5 && subLight.a < 0.999) {
            RayHit subBeneath = traceLayers(origin, subRay, 1.0);
            vec3 subBeneathDx = beneathDx, subBeneathDy = beneathDy;
            if (u_ink < 0.5 && subBeneath.material > 0.5
                && (beneath.material < 0.5 || distance(subBeneath.point, beneath.point) > 0.3)) {
              subBeneathDx = surfaceDifferential(origin, subRayDx, subBeneath.point);
              subBeneathDy = surfaceDifferential(origin, subRayDy, subBeneath.point);
            }
            subLight += shadeHit(subBeneath, subBeneathDx, subBeneathDy) * (1.0 - subLight.a);
          }
          samples += subLight;
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
    uniform sampler2D u_splatter;
    uniform float u_hasSplatter;
    uniform vec2 u_texel;
    uniform vec4 u_crop;
    uniform float u_ink;
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
    constructor(canvas, { style = 'minimal' } = {}) {
      this.canvas = canvas;
      this.setStyle(style);
      this.gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' });
      this.ready = false;
      this.lost = false;
      this.quality = 1;
      this.frameTimes = [];
      this.lastSample = 0;
      this.resources = [];
      this.generation = 0;
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
      const lod = gl.getExtension('EXT_shader_texture_lod');
      const prefix = (derivatives ? '#extension GL_OES_standard_derivatives : enable\n#define HAS_DERIVATIVES\n' : '')
        + (lod ? '#extension GL_EXT_shader_texture_lod : enable\n#define HAS_TEXTURE_LOD\n' : '');
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
      this.ready = false;
      this.initialized = false;
      this.inkTexture = this.inkLightTexture = null;
      this.inkSplatter = null;
      this.sceneTarget = this.bloomTarget = null;
      this.generation++;
      this.inkLoaded = false;
      this.inkLoading = false;
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
      this.ready = true;
      this.resize();
      this.initialized = this.ready;
      if (!this.initialized) return;
      if (this.style === 'ink') { this.ready = false; this.loadInk(); }
    }

    loadInk() {
      if (this.inkLoading || this.inkLoaded || !this.inkTexture || !this.gl.getExtension('EXT_shader_texture_lod')) return;
      this.inkLoading = true;
      const generation = this.generation;
      const readImage = name => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Ink ${name} unavailable.`));
        image.src = `./assets/black-hole-ink-${name}.png?v=20261015-ink-light`;
      });
      Promise.all([readImage('material'), readImage('light')]).then(images => {
        if (this.lost || generation !== this.generation) return;
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
          this.inkLoaded = true;
          this.inkLoading = false;
          if (window.InkSplatter) this.inkSplatter = new window.InkSplatter(gl);
          if (this.style === 'ink') {
            this.ready = true;
            this.resize();
            this.onRestore?.();
          }
        } catch (error) {
          this.inkLoading = false;
          console.warn('Using the ink illustration fallback.', error);
        } finally {
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        }
      }).catch(error => {
        if (this.lost || generation !== this.generation) return;
        this.inkLoading = false;
        console.warn('Using the ink illustration fallback.', error);
      });
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
          this.initialized = false;
          this.canvas.parentElement.classList.remove('is-ready');
          return;
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.inkSplatter?.resize(this.width, this.height);
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
      gl.uniform1f(this.scene.uniforms.u_ink, this.style === 'ink' ? 1 : 0);
      this.texture(this.scene, 'u_inkAtlas', this.inkTexture, 0);
      this.texture(this.scene, 'u_inkLight', this.inkLightTexture, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (this.style !== 'ink') {
        this.use(this.bloom, this.bloomTarget);
        this.texture(this.bloom, 'u_scene', this.sceneTarget.texture, 0);
        gl.uniform2f(this.bloom.uniforms.u_texel, 1 / this.width, 1 / this.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      const splatter = this.style === 'ink' ? this.inkSplatter?.render({
        time, x, y, width: this.width, height: this.height,
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
      gl.uniform1f(this.composite.uniforms.u_ink, this.style === 'ink' ? 1 : 0);
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
    setStyle(style) {
      this.style = style === 'ink' ? 'ink' : 'minimal';
      if (!this.initialized || !this.inkTexture || this.lost) return;
      this.ready = this.style !== 'ink' || this.inkLoaded;
      if (!this.ready) this.canvas.parentElement.classList.remove('is-ready');
      if (this.style === 'ink') this.loadInk();
    }
  }
  window.BlackHole = BlackHole;
})();
