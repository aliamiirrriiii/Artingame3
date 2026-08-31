import * as THREE from 'three';

/**
 * A hand-authored daytime sky.
 *
 * The HDRI is kept purely for image-based lighting; using it as the visible
 * backdrop puts a photograph of somewhere else behind the arena and hands the
 * bloom pass a blown-out hotspot to chew on. This shader draws the sky the game
 * actually wants: a Rayleigh-ish vertical gradient, a haze band that matches the
 * fog exactly so distant geometry dissolves into it, a real sun disc with a
 * tight glare and a wide atmospheric halo, and a drifting cumulus layer.
 *
 * The clouds are three octaves of value noise projected onto a plane above the
 * camera — the standard cheap trick, and the right one here, because the sky is
 * the one surface that covers every pixel the geometry does not, so anything
 * expensive in it is paid for over the whole screen.
 */
export class Sky {
  constructor(scene, { radius = 400 } = {}) {
    this.uniforms = {
      uZenith:     { value: new THREE.Color(0x3f74b8) },
      uHorizon:    { value: new THREE.Color(0xa8bdd2) },
      uHaze:       { value: new THREE.Color(0xc4cfd8) },
      uSunDir:     { value: new THREE.Vector3(-0.42, 0.58, 0.70).normalize() },
      uSunColor:   { value: new THREE.Color(0xfff4e0) },
      uSunSize:    { value: 0.9993 },  // cos of angular radius
      uSunGlare:   { value: 0.85 },
      // Cloud lit by a low sun is warm on top and blue underneath, because
      // what lights its underside is the sky, not the sun. Neutral white and
      // neutral grey is what a cloud looks like at noon, and it fought with
      // the warm key everywhere else in the frame.
      uCloud:      { value: new THREE.Color(0xfaf2e6) },
      uCloudDark:  { value: new THREE.Color(0x8496ad) },
      uCloudAmount: { value: 1.0 },
      uCloudCover: { value: 0.56 },
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
        uniform vec3  uSunDir;
        uniform vec3  uSunColor;
        uniform float uSunSize;
        uniform float uSunGlare;
        uniform vec3  uCloud;
        uniform vec3  uCloudDark;
        uniform float uCloudAmount;
        uniform float uCloudCover;
        uniform float uTime;
        uniform float uExposure;

        float hash21( vec2 p ) {
          p = fract( p * vec2( 123.34, 345.45 ) );
          p += dot( p, p + 34.345 );
          return fract( p.x * p.y );
        }

        float vnoise( vec2 p ) {
          vec2 i = floor( p ), f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          float a = hash21( i );
          float b = hash21( i + vec2( 1.0, 0.0 ) );
          float c = hash21( i + vec2( 0.0, 1.0 ) );
          float d = hash21( i + vec2( 1.0, 1.0 ) );
          return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
        }

        float fbm( vec2 p ) {
          float v = 0.0, a = 0.5;
          for ( int i = 0; i < 3; i++ ) {
            v += a * vnoise( p );
            p = p * 2.03 + 11.7;
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 d = normalize( vDir );
          float up = clamp( d.y, -1.0, 1.0 );

          // Vertical gradient with a haze band hugging the horizon.
          float t = pow( clamp( up * 0.5 + 0.5, 0.0, 1.0 ), 0.9 );
          vec3 col = mix( uHorizon, uZenith, smoothstep( 0.50, 1.00, t ) );
          float haze = pow( 1.0 - clamp( abs( up ) * 2.6, 0.0, 1.0 ), 2.0 );
          col = mix( col, uHaze, haze * 0.9 );

          float sd = dot( d, normalize( uSunDir ) );

          // Clouds. Projecting the view direction onto a plane at a fixed
          // height is what gives the layer perspective: cells stretch and
          // crowd together as they approach the horizon, the way real ones do.
          if ( up > 0.01 && uCloudAmount > 0.001 ) {
            vec2 pl = d.xz / max( up, 0.06 );
            vec2 drift = vec2( uTime * 0.0035, uTime * 0.0016 );
            float n = fbm( pl * 0.55 + drift );
            n = mix( n, fbm( pl * 1.7 - drift * 1.9 ), 0.35 );
            float cover = smoothstep( uCloudCover, uCloudCover + 0.26, n );
            // Thin them out toward the horizon, where the projection smears.
            cover *= smoothstep( 0.01, 0.16, up ) * uCloudAmount;
            // Sun side lit, base shaded: a flat white cloud reads as fog.
            float lit = clamp( 0.45 + 0.55 * sd, 0.0, 1.0 );
            vec3 cloudCol = mix( uCloudDark, uCloud, lit );
            col = mix( col, cloudCol, cover * 0.92 );
          }

          // Sun: hard disc, tight glare, wide halo. The disc is deliberately
          // only just over white — the bloom pass does the rest, and a sun
          // pushed to 20.0 here blooms into a hole in the sky.
          float disc = smoothstep( uSunSize, uSunSize + 0.0004, sd );
          float glare = pow( max( sd, 0.0 ), 900.0 ) * uSunGlare;
          float wide = pow( max( sd, 0.0 ), 8.0 ) * 0.16;
          col += uSunColor * ( disc * 3.2 + glare * 1.2 + wide );

          gl_FragColor = vec4( col * uExposure, 1.0 );
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'Sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
    this.scene = scene;
  }

  /** Ties the haze band to the scene fog so the horizon reads as one surface. */
  matchFog(fogColor) {
    this.uniforms.uHaze.value.copy(fogColor);
    this.uniforms.uHorizon.value.copy(fogColor).lerp(this.uniforms.uZenith.value, 0.18);
  }

  /** Aligns the drawn sun with the light that is actually casting shadows. */
  alignToLight(light) {
    this.uniforms.uSunDir.value.copy(light.position).sub(light.target.position).normalize();
    this.uniforms.uSunColor.value.copy(light.color);
  }

  setMood({ zenith, horizon, haze, sunColor, exposure, clouds, cover }) {
    if (zenith !== undefined) this.uniforms.uZenith.value.setHex(zenith);
    if (horizon !== undefined) this.uniforms.uHorizon.value.setHex(horizon);
    if (haze !== undefined) this.uniforms.uHaze.value.setHex(haze);
    if (sunColor !== undefined) this.uniforms.uSunColor.value.setHex(sunColor);
    if (exposure !== undefined) this.uniforms.uExposure.value = exposure;
    if (clouds !== undefined) this.uniforms.uCloudAmount.value = clouds;
    if (cover !== undefined) this.uniforms.uCloudCover.value = cover;
  }

  /** Clouds cost a full-screen fbm; the cheapest presets do without them. */
  setQuality(preset) {
    this.uniforms.uCloudAmount.value = preset.name === 'Low' ? 0.55 : 1.0;
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
