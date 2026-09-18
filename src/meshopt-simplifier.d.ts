// Three.js ships meshoptimizer 1.1; @types/three does not yet declare this addon.
declare module 'three/addons/libs/meshopt_simplifier.module.js' {
  export const MeshoptSimplifier: {
    ready: Promise<void>;
    simplifyWithAttributes(
      indices: Uint32Array,
      positions: Float32Array,
      positionStride: number,
      attributes: Float32Array,
      attributeStride: number,
      weights: number[],
      locks: Uint8Array | null,
      targetIndexCount: number,
      targetError: number,
      flags: ('Permissive' | 'ErrorAbsolute')[],
    ): [Uint32Array<ArrayBuffer>, number];
    compactMesh(indices: Uint32Array): [Uint32Array<ArrayBuffer>, number];
  };
}
