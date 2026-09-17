import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { readLimited } from './projects.ts';
export const CAD_SOURCE =
  'https://github.com/coredevices/hardware/tree/cb50db8e68c053e7dd595188313dd54aba693bc9/watch/Pebble%20Time%202%20%28obelix%29';
const CAD_URL =
  'https://raw.githubusercontent.com/coredevices/hardware/cb50db8e68c053e7dd595188313dd54aba693bc9/watch/Pebble%20Time%202%20%28obelix%29/2026-04-08%20Pebble%20Time%202%20-%203D%20CAD%20Solid%20Model.STL';
/** Official case geometry with a live framebuffer overlay. Materials are an approximation. */
export class WatchModel {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  private controls: OrbitControls;
  private frame = 0;
  private disposed = false;
  private active = true;
  private geometry?: THREE.BufferGeometry;
  private material = new THREE.MeshStandardMaterial({
    color: 0xb6b9bd,
    metalness: 0.85,
    roughness: 0.32,
  });
  private texture = new THREE.DataTexture(
    new Uint8Array(200 * 228 * 4),
    200,
    228,
    THREE.RGBAFormat,
  );
  private screenMaterial = new THREE.MeshBasicMaterial({ map: this.texture });
  private screenGeometry: THREE.ShapeGeometry;
  private resize: ResizeObserver;
  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute(
      'aria-label',
      'Rotatable Pebble Time 2 model. Drag to rotate; scroll to zoom.',
    );
    this.renderer.domElement.tabIndex = 0;
    this.camera.position.set(36, 22, 115);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.minDistance = 65;
    this.controls.maxDistance = 200;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x69717e, 3));
    for (const [x, y, z] of [
      [-50, 70, 90],
      [60, -30, 50],
    ]) {
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.position.set(x, y, z);
      this.scene.add(light);
    }
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    const w = 12.8,
      h = 14.564,
      r = 2.5,
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
    const display = new THREE.Mesh(this.screenGeometry, this.screenMaterial);
    display.position.z = 6.215;
    this.scene.add(display);
    this.resize = new ResizeObserver(() => {
      const width = host.clientWidth,
        height = host.clientHeight;
      this.renderer.setSize(width, height);
      this.camera.aspect = width / Math.max(1, height);
      this.camera.updateProjectionMatrix();
      this.invalidate();
    });
    this.resize.observe(host);
    this.invalidate();
  }
  setActive(active: boolean) {
    this.active = active;
    if (active) this.invalidate();
    else {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }
  private invalidate() {
    if (this.disposed || !this.active || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed || !this.active || !this.host.clientHeight) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }
  async load(signal: AbortSignal) {
    const bytes = await readLimited(await fetch(CAD_URL, { signal }), 11 * 1024 * 1024);
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
      (v) => v.toString(16).padStart(2, '0'),
    ).join('');
    if (hash !== 'fb7c75e955e26de21611c81f73eb72bfe24a89df8b0b5064c730c88cecfa6311')
      throw new Error('CAD model checksum did not match the pinned official revision.');
    if (this.disposed) return;
    this.geometry = new STLLoader().parse(bytes.slice().buffer);
    this.geometry.translate(-127.9631424, -128.0000381, -6.2);
    this.geometry.computeVertexNormals();
    this.scene.add(new THREE.Mesh(this.geometry, this.material));
    this.invalidate();
  }
  pixels(rgba: Uint8ClampedArray) {
    (this.texture.image.data as Uint8Array).set(rgba);
    this.texture.needsUpdate = true;
    this.invalidate();
  }
  finish(value: string) {
    this.material.color.set(value === 'black' ? 0x30343b : 0xb6b9bd);
    this.invalidate();
  }
  reset() {
    this.camera.position.set(36, 22, 115);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.geometry?.dispose();
    this.screenGeometry.dispose();
    this.material.dispose();
    this.screenMaterial.dispose();
    this.texture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
