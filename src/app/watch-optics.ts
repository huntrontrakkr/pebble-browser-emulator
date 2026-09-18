import * as THREE from 'three';
import { TIME2_OPTICS } from './watch-optics-profile.ts';

export type OpticalStyle = 'standard' | 'layered';
export type OpticalProfile = 'time2';
const profiles = { time2: TIME2_OPTICS } as const;
const tables = new Map<OpticalProfile, Uint8Array>();

/** Same-origin, versioned presentation data. No remote service or Python at runtime. */
export async function loadOpticalTable(profile: OpticalProfile, signal: AbortSignal) {
  signal.throwIfAborted();
  const cached = tables.get(profile);
  if (cached) return cached;
  const spec = profiles[profile];
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const response = await fetch(new URL(spec.path, document.baseURI), { signal: deadline });
  if (!response.ok) throw new Error('The display optics could not be downloaded.');
  const data = new Uint8Array(await response.arrayBuffer());
  deadline.throwIfAborted();
  if (data.byteLength !== spec.bytes) throw new Error('The display optics have an invalid size.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');
  deadline.throwIfAborted();
  if (hash !== spec.sha256) throw new Error('The display optics checksum does not match.');
  tables.set(profile, data);
  return data;
}

/** A deliberately bounded display material, independent of CPU/firmware emulation. */
export class OpticalScreen {
  readonly material: THREE.ShaderMaterial;
  readonly frame: THREE.DataTexture;
  private response: THREE.DataTexture;
  constructor(
    profile: OpticalProfile,
    table: Uint8Array,
    pixels: Uint8Array,
    width: number,
    height: number,
  ) {
    const spec = profiles[profile];
    this.frame = new THREE.DataTexture(pixels, width, height, THREE.RedFormat);
    this.frame.magFilter = this.frame.minFilter = THREE.NearestFilter;
    this.frame.unpackAlignment = 1;
    this.frame.needsUpdate = true;
    this.response = new THREE.DataTexture(table, spec.width, spec.height, THREE.RGBAFormat);
    this.response.magFilter = this.response.minFilter = THREE.LinearFilter;
    this.response.generateMipmaps = false;
    this.response.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      name: spec.id,
      uniforms: {
        uFrame: { value: this.frame },
        uResponse: { value: this.response },
        uEnvironment: { value: null },
        uEnvironmentRotation: { value: new THREE.Matrix3() },
        uAmbient: { value: 0 },
        uBacklight: { value: 0 },
        uKeyDirection: { value: new THREE.Vector3(0, 0, 1) },
        uKeyColor: { value: new THREE.Color(0) },
        uFill: { value: new THREE.Color(0) },
      },
      defines: {
        ENVMAP_TYPE_CUBE_UV: '',
        OPTICS_ANGLES: spec.angles.toFixed(1),
        OPTICS_WIDTH: spec.width.toFixed(1),
        OPTICS_HEIGHT: spec.height.toFixed(1),
        GLASS_IOR: spec.glassIor.toFixed(5),
        GLASS_ROUGHNESS: spec.glassRoughness.toFixed(5),
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;
        void main() {
          vUv = uv;
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorldPosition = world.xyz;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        #include <common>
        #include <cube_uv_reflection_fragment>
        uniform sampler2D uFrame;
        uniform sampler2D uResponse;
        uniform sampler2D uEnvironment;
        uniform mat3 uEnvironmentRotation;
        uniform float uAmbient;
        uniform float uBacklight;
        uniform vec3 uKeyDirection;
        uniform vec3 uKeyColor;
        uniform vec3 uFill;
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;

        float framebufferColor() {
          // Native ARGB2222, point sampled; alpha bits have no optical meaning.
          return mod(floor(texture2D(uFrame, vUv).r * 255.0 + 0.5), 64.0);
        }
        vec3 responseAt(float color, float viewCosine, float column) {
          vec2 tile = vec2(mod(color, 8.0) * (OPTICS_ANGLES + 2.0),
                           floor(color / 8.0) * OPTICS_ANGLES);
          vec2 pixel = tile + vec2(column, clamp(viewCosine, 0.0, 1.0) * (OPTICS_ANGLES - 1.0)) + 0.5;
          vec3 encoded = texture2D(uResponse, pixel / vec2(OPTICS_WIDTH, OPTICS_HEIGHT)).rgb;
          return encoded * encoded;
        }
        float glassFresnel(float cosine) {
          float mu = clamp(cosine, 0.0, 1.0);
          float transmitted = sqrt(1.0 - (1.0 - mu * mu) / (GLASS_IOR * GLASS_IOR));
          float rs = (mu - GLASS_IOR * transmitted) / (mu + GLASS_IOR * transmitted);
          float rp = (GLASS_IOR * mu - transmitted) / (GLASS_IOR * mu + transmitted);
          return 0.5 * (rs * rs + rp * rp);
        }
        float glassHighlight(vec3 n, vec3 v, vec3 l) {
          vec3 h = normalize(v + l);
          float nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 0.0001);
          float nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
          float a2 = pow(GLASS_ROUGHNESS, 4.0);
          float d = nh * nh * (a2 - 1.0) + 1.0;
          float distribution = a2 / max(PI * d * d, 0.0000001);
          float masking = 0.5 / max(nl * sqrt(nv * nv * (1.0 - a2) + a2)
                                + nv * sqrt(nl * nl * (1.0 - a2) + a2), 0.000001);
          return distribution * masking * glassFresnel(vh) * nl;
        }
        void main() {
          vec3 n = normalize(vWorldNormal), v = normalize(cameraPosition - vWorldPosition);
          float nv = max(dot(n, v), 0.0), nl = max(dot(n, uKeyDirection), 0.0);
          float color = framebufferColor();
          vec3 direct = responseAt(color, nv, nl * (OPTICS_ANGLES - 1.0));
          vec3 diffuse = responseAt(color, nv, OPTICS_ANGLES);
          vec3 backlight = responseAt(color, nv, OPTICS_ANGLES + 1.0);
          vec3 environmentDiffuse = textureCubeUV(uEnvironment, uEnvironmentRotation * n, 1.0).rgb;
          vec3 reflectionDirection = uEnvironmentRotation * reflect(-v, n);
          vec3 environmentSpecular = textureCubeUV(uEnvironment, reflectionDirection, GLASS_ROUGHNESS).rgb;
          float exitReflection = glassFresnel(nv);
          vec3 panel = direct * uKeyColor * nl * (1.0 - glassFresnel(nl)) / PI
                     + diffuse * (environmentDiffuse * uAmbient + uFill / PI)
                     + backlight * uBacklight;
          vec3 cover = environmentSpecular * uAmbient * exitReflection
                     + uKeyColor * glassHighlight(n, v, uKeyDirection);
          gl_FragColor = vec4(panel * (1.0 - exitReflection) + cover, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
  }
  lighting(
    environment: THREE.Texture,
    rotation: THREE.Euler,
    ambient: number,
    backlight: number,
    key: THREE.DirectionalLight,
    fill: THREE.HemisphereLight,
  ) {
    const uniforms = this.material.uniforms;
    uniforms['uEnvironment'].value = environment;
    uniforms['uEnvironmentRotation'].value.setFromMatrix4(
      new THREE.Matrix4().makeRotationFromEuler(rotation).invert(),
    );
    uniforms['uAmbient'].value = ambient;
    uniforms['uBacklight'].value = backlight;
    uniforms['uKeyDirection'].value.copy(key.position).sub(key.target.position).normalize();
    uniforms['uKeyColor'].value.copy(key.color).multiplyScalar(key.intensity);
    // This display is flat in the XY plane, so the hemisphere normal weight is 1/2.
    uniforms['uFill'].value
      .copy(fill.color)
      .add(fill.groundColor)
      .multiplyScalar(fill.intensity * 0.5);
    const { width, height } = environment.image as { width: number; height: number };
    const maxMip = Math.log2(height) - 2;
    if (this.material.defines['CUBEUV_MAX_MIP'] !== maxMip.toFixed(1)) {
      this.material.defines['CUBEUV_MAX_MIP'] = maxMip.toFixed(1);
      this.material.defines['CUBEUV_TEXEL_WIDTH'] = (1 / width).toPrecision(12);
      this.material.defines['CUBEUV_TEXEL_HEIGHT'] = (1 / height).toPrecision(12);
      this.material.needsUpdate = true;
    }
  }
  dispose() {
    this.frame.dispose();
    this.response.dispose();
    this.material.dispose();
  }
}
