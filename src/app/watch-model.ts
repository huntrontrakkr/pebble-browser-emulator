import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadModelGeometry } from './watch-model-loader.ts';
import { modelDisplay, type WatchModelSpec } from './watch-model-specs.ts';
import {
  createWatchEnvironment,
  LIGHTING_ENVIRONMENTS,
  type LightingEnvironment,
  type WatchLighting,
} from './watch-lighting.ts';
/** Simplified official case geometry with an unchanged live framebuffer overlay. */
export class WatchModel {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  private controls: OrbitControls;
  private frame = 0;
  private disposed = false;
  private active = true;
  private geometry?: THREE.BufferGeometry;
  private caseMesh?: THREE.Mesh;
  private display?: THREE.Mesh;
  private buttonsDirty = true;
  private projection = new THREE.Vector3();
  private viewport = new THREE.Vector2();
  private finishValue = '';
  private lightingKey = '';
  private readonly pixelRatio = Math.min(devicePixelRatio, 1.5);
  private motionTimer?: ReturnType<typeof setTimeout>;
  private environments = new Map<LightingEnvironment, THREE.WebGLRenderTarget>();
  private keyLight = new THREE.DirectionalLight();
  private fillLight = new THREE.HemisphereLight();
  private material = new THREE.MeshStandardMaterial({
    color: 0xb6b9bd,
    metalness: 0.85,
    roughness: 0.32,
  });
  private texture!: THREE.DataTexture;
  private screenMaterial: THREE.MeshPhysicalMaterial;
  private screenGeometry!: THREE.ShapeGeometry;
  private resize: ResizeObserver;
  constructor(
    private host: HTMLElement,
    private spec: WatchModelSpec,
    private onButtons: (
      positions: { mask: number; x: number; y: number; visible: boolean }[],
    ) => void,
  ) {
    // Diffuse reflective LCD beneath a dielectric cover. Clearcoat uses the same
    // draw as the screen; no transmission render pass or screen-space reflection.
    this.screenMaterial = new THREE.MeshPhysicalMaterial({
      roughness: 0.68,
      metalness: 0,
      specularIntensity: 0.12,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      ior: 1.5,
      emissive: 0xdde8ff,
      emissiveIntensity: 0,
    });
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.resizeToHost();
    host.append(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;
    this.camera.position.set(24, 14, 110);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('start', () => this.motionResolution());
    this.controls.addEventListener('change', () => {
      this.motionResolution();
      this.buttonsDirty = true;
      this.invalidate();
    });
    this.controls.minDistance = 65;
    this.controls.maxDistance = 200;
    this.scene.add(this.keyLight, this.fillLight);
    this.setSpec(spec);
    this.setLighting({ environment: 'studio', ambient: 0.8, backlight: 0, azimuth: -35 });
    this.resize = new ResizeObserver(() => this.resizeToHost());
    this.resize.observe(host);
  }
  setSpec(spec: WatchModelSpec) {
    this.spec = spec;
    if (this.caseMesh) this.scene.remove(this.caseMesh);
    this.caseMesh = undefined;
    this.geometry?.dispose();
    this.geometry = undefined;
    if (this.display) this.scene.remove(this.display);
    this.screenGeometry?.dispose();
    this.texture?.dispose();
    this.onButtons([]);
    this.buttonsDirty = true;
    this.material.metalness = spec.plastic ? 0 : 0.9;
    this.material.roughness = spec.plastic ? 0.52 : 0.3;
    this.applyFinish();
    this.renderer.domElement.setAttribute(
      'aria-label',
      `Rotatable ${spec.name} model. Drag to rotate; scroll to zoom.`,
    );
    const dimensions = modelDisplay(spec);
    this.texture = new THREE.DataTexture(
      new Uint8Array(dimensions.width * dimensions.height * 4),
      dimensions.width,
      dimensions.height,
      THREE.RGBAFormat,
    );
    this.screenMaterial.map = this.texture;
    this.screenMaterial.emissiveMap = this.texture;
    this.screenMaterial.needsUpdate = true;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    const w = spec.screen.width / 2,
      h = spec.screen.height / 2,
      r = spec.screen.radius,
      s = new THREE.Shape();
    s.moveTo(-w + r, -h);
    s.lineTo(w - r, -h);
    s.absarc(w - r, -h + r, r, -Math.PI / 2, 0, false);
    s.lineTo(w, h - r);
    s.absarc(w - r, h - r, r, 0, Math.PI / 2, false);
    s.lineTo(-w + r, h);
    s.absarc(-w + r, h - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(-w, -h + r);
    s.absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5, false);
    this.screenGeometry = new THREE.ShapeGeometry(s, 16);
    const positions = this.screenGeometry.getAttribute('position'),
      uv = this.screenGeometry.getAttribute('uv');
    for (let i = 0; i < positions.count; i++)
      uv.setXY(i, positions.getX(i) / (w * 2) + 0.5, 0.5 - positions.getY(i) / (h * 2));
    this.display = new THREE.Mesh(this.screenGeometry, this.screenMaterial);
    this.display.position.set(spec.screen.x, spec.screen.y, spec.screen.z);
    this.scene.add(this.display);
    this.invalidate();
  }
  setActive(active: boolean) {
    this.active = active;
    if (active) this.invalidate();
    else {
      clearTimeout(this.motionTimer);
      if (this.renderer.getPixelRatio() !== this.pixelRatio)
        this.renderer.setPixelRatio(this.pixelRatio);
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }
  private resizeToHost() {
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    this.renderer.getSize(this.viewport);
    if (!width || !height || (width === this.viewport.x && height === this.viewport.y)) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.buttonsDirty = true;
    this.invalidate();
  }
  private motionResolution() {
    // Lower only the optical render target while rotating, never the guest's
    // texture or CAD mesh. Restore full detail once orbit damping has settled.
    if (this.disposed || !this.active || this.pixelRatio <= 1) return;
    clearTimeout(this.motionTimer);
    if (this.renderer.getPixelRatio() !== 1) this.renderer.setPixelRatio(1);
    this.motionTimer = setTimeout(() => {
      if (this.disposed) return;
      this.renderer.setPixelRatio(this.pixelRatio);
      this.invalidate();
    }, 180);
  }
  private invalidate() {
    if (this.disposed || !this.active || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed || !this.active || !this.host.clientHeight) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (!this.buttonsDirty) return;
      this.buttonsDirty = false;
      const front = this.camera.position.z > 15;
      const width = this.host.clientWidth,
        height = this.host.clientHeight;
      this.onButtons(
        this.spec.buttons.map((b) => {
          const p = this.projection.set(...b.position).project(this.camera);
          return {
            mask: b.mask,
            x: ((p.x + 1) / 2) * width,
            y: ((1 - p.y) / 2) * height,
            visible: front && p.z < 1 && Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.95,
          };
        }),
      );
    });
  }
  async load(signal: AbortSignal) {
    const spec = this.spec;
    const data = await loadModelGeometry(spec, signal);
    signal.throwIfAborted();
    if (this.disposed || spec !== this.spec) return;
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    this.caseMesh = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.caseMesh);
    this.invalidate();
  }
  pixels(rgba: Uint8ClampedArray) {
    const pixels = this.texture.image.data as Uint8Array;
    if (rgba.length !== pixels.length)
      throw new Error('Framebuffer does not match the 3D watch display.');
    // Firmware snapshots can repeat the same frame many times. Upload/render only
    // changed pixels; camera motion still renders independently at display rate.
    let changed = false;
    for (let i = 0; i < pixels.length; i++) {
      if (pixels[i] !== rgba[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    pixels.set(rgba);
    this.texture.needsUpdate = true;
    this.invalidate();
  }
  finish(value: string) {
    if (value === this.finishValue) return;
    this.finishValue = value;
    this.applyFinish();
    this.invalidate();
  }
  private applyFinish() {
    this.material.color.set(
      this.finishValue === 'black'
        ? this.spec.plastic
          ? 0x22272c
          : 0x4b5159
        : this.spec.plastic
          ? 0xe8eced
          : 0xc5c8cd,
    );
  }
  setLighting(options: WatchLighting) {
    const key = JSON.stringify(options);
    if (this.lightingKey === key) return;
    this.lightingKey = key;
    const ambient = THREE.MathUtils.clamp(options.ambient, 0, 1);
    const backlight = THREE.MathUtils.clamp(options.backlight, 0, 1);
    const preset = LIGHTING_ENVIRONMENTS[options.environment];
    let environment = this.environments.get(options.environment);
    if (!environment) {
      environment = createWatchEnvironment(this.renderer, options.environment);
      this.environments.set(options.environment, environment);
    }
    this.scene.environment = environment.texture;
    this.scene.environmentIntensity = ambient;
    const angle = THREE.MathUtils.degToRad(options.azimuth);
    this.scene.environmentRotation.set(0, angle, 0);
    this.keyLight.color.set(preset.lamp);
    this.keyLight.intensity = ambient * preset.direct;
    this.keyLight.position.set(Math.sin(angle) * 90, 55, Math.cos(angle) * 90);
    this.fillLight.color.set(preset.sky);
    this.fillLight.groundColor.set(preset.ground);
    this.fillLight.intensity = ambient * preset.fill;
    this.screenMaterial.emissiveIntensity = backlight * 0.8;
    this.invalidate();
  }
  reset() {
    this.camera.position.set(24, 14, 110);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.motionTimer);
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.geometry?.dispose();
    this.screenGeometry.dispose();
    this.material.dispose();
    this.screenMaterial.dispose();
    this.texture.dispose();
    for (const environment of this.environments.values()) environment.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
