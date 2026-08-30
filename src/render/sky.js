import * as THREE from 'three';

/**
 * A hand-authored night sky.
 *
 * The HDRI is kept purely for image-based lighting; using it as the visible
 * backdrop washed the horizon out and gave bloom a blown-out hotspot to chew on.
 * This shader draws the sky the game actually wants: a deep zenith, a haze band
 * that matches the fog exactly so distant geometry dissolves into it, a real
 * moon disc with a falloff halo, and stars that thin out toward the horizon.
 */
export class NightSky {
  constructor(scene, { radius = 400, moonTexture = null } = {}) {
    this.uniforms = {
      uZenith:     { value: new THREE.Color(0x05070f) },
      uHorizon:    { value: new THREE.Color(0x121a26) },
      uHaze:       { value: new THREE.Color(0x1b2634) },
      uMoonDir:    { value: new THREE.Vector3(-0.55, 0.42, 0.72).normalize() },
      uMoonColor:  { value: new THREE.Color(0xdfe8ff) },
      uMoonSize:   { value: 0.986 },   // cos of angular radius
      uMoonGlow:   { value: 0.55 },
      uStarAmount: { value: 1.0 },
      uTime:       { value: 0 },
      uExposure:   { value: 1.0 },
    };

    const geo = new THREE.SphereGeometry(radius, 32, 20);

    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: true,
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize( position );
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mv;
          gl_Position.z = gl_Position.w;   // always at the far plane
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vDir;

        uniform vec3  uZenith;
        uniform vec3  uHorizon;
        uniform vec3  uHaze;
        uniform vec3  uMoonDir;
        uniform vec3  uMoonColor;
        uniform float uMoonSize;
        uniform float uMoonGlow;
        uniform float uStarAmount;
        uniform float uTime;
        uniform float uExposure;

        float hash31( vec3 p ) {
          p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
          p *= 17.0;
          return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
        }

        void main() {
          vec3 d = normalize( vDir );
          float up = clamp( d.y, -1.0, 1.0 );

          // Vertical gradient with a tight haze band hugging the horizon.
          float t = pow( clamp( up * 0.5 + 0.5, 0.0, 1.0 ), 0.9 );
          vec3 col = mix( uHorizon, uZenith, smoothstep( 0.48, 0.95, t ) );
          float haze = pow( 1.0 - clamp( abs( up ) * 3.2, 0.0, 1.0 ), 2.2 );
          col = mix( col, uHaze, haze * 0.85 );

          // Stars: quantised direction cells, one star per cell, fading into
          // the haze so the horizon does not look like a starfield screensaver.
          if ( up > -0.05 ) {
            vec3 cell = floor( d * 320.0 );
            float h = hash31( cell );
            if ( h > 0.9955 ) {
              vec3 jitter = vec3( hash31( cell + 1.7 ), hash31( cell + 3.1 ), hash31( cell + 5.9 ) );
              vec3 starDir = normalize( ( cell + jitter ) / 320.0 );
              float dd = max( 0.0, dot( d, starDir ) );
              float spark = pow( dd, 40000.0 );
              float twinkle = 0.65 + 0.35 * sin( uTime * ( 1.5 + h * 6.0 ) + h * 40.0 );
              float fade = smoothstep( -0.02, 0.30, up );
              col += vec3( 0.85, 0.9, 1.0 ) * spark * twinkle * fade * uStarAmount
                   * ( 0.5 + ( h - 0.9955 ) * 180.0 );
            }
          }

          // Moon: hard disc, soft limb, wide atmospheric halo.
          float md = dot( d, normalize( uMoonDir ) );
          float disc = smoothstep( uMoonSize, uMoonSize + 0.0016, md );
          float glow = pow( max( md, 0.0 ), 220.0 ) * uMoonGlow;
          float wide = pow( max( md, 0.0 ), 12.0 ) * 0.10;
          col += uMoonColor * ( disc * 2.4 + glow * 0.9 + wide );

          gl_FragColor = vec4( col * uExposure, 1.0 );
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'NightSky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
    this.scene = scene;
  }

  /** Ties the haze band to the scene fog so the horizon reads as one surface. */
  matchFog(fogColor) {
    this.uniforms.uHaze.value.copy(fogColor);
    this.uniforms.uHorizon.value.copy(fogColor).multiplyScalar(0.75);
  }

  /** Aligns the drawn moon with the light that is actually casting shadows. */
  alignToLight(light) {
    this.uniforms.uMoonDir.value.copy(light.position).sub(light.target.position).normalize();
    this.uniforms.uMoonColor.value.copy(light.color);
  }

  setMood({ zenith, horizon, haze, moonColor, exposure, stars }) {
    if (zenith !== undefined) this.uniforms.uZenith.value.setHex(zenith);
    if (horizon !== undefined) this.uniforms.uHorizon.value.setHex(horizon);
    if (haze !== undefined) this.uniforms.uHaze.value.setHex(haze);
    if (moonColor !== undefined) this.uniforms.uMoonColor.value.setHex(moonColor);
    if (exposure !== undefined) this.uniforms.uExposure.value = exposure;
    if (stars !== undefined) this.uniforms.uStarAmount.value = stars;
  }

  update(dt, elapsed, cameraPos) {
    this.uniforms.uTime.value = elapsed;
    // Sky follows the camera so it never clips the far plane.
    this.mesh.matrix.makeTranslation(cameraPos.x, cameraPos.y, cameraPos.z);
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
