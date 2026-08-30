/**
 * Final-image grade. One fullscreen pass that does the work a dozen separate
 * effects would otherwise cost: filmic colour grade, chromatic aberration,
 * barrel-ish edge smear, vignette, animated grain, and the gameplay overlays
 * (damage flash, low-health desaturation, adrenaline pulse, freeze tint).
 *
 * Runs after tone mapping, so it operates in display space.
 */
export const GradeShader = {
  name: 'GradeShader',

  uniforms: {
    tDiffuse:        { value: null },
    uTime:           { value: 0 },
    uResolution:     { value: [1280, 720] },

    uVignette:       { value: 0.72 },   // strength
    uGrain:          { value: 0.038 },
    uAberration:     { value: 0.0005 },

    uDamage:         { value: 0.0 },    // 0..1 red flash on taking a hit
    uHealth:         { value: 1.0 },    // 1 = fine, 0 = about to die
    uAdrenaline:     { value: 0.0 },    // power-up rush
    uFreeze:         { value: 0.0 },    // freeze power-up tint
    uFlash:          { value: 0.0 },    // explosion / nuke whiteout

    // Daylight grade: a bleached, slightly warm print. The night version
    // lifted the blacks into blue and pulled saturation down hard; under a sun
    // that reads as a filter over the lens rather than as the light itself.
    uLift:           { value: [0.010, 0.010, 0.012] },
    uGain:           { value: [1.05, 1.01, 0.97] },
    uSaturation:     { value: 0.88 },
    uContrast:       { value: 1.12 },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,

  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2  uResolution;

    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;

    uniform float uDamage;
    uniform float uHealth;
    uniform float uAdrenaline;
    uniform float uFreeze;
    uniform float uFlash;

    uniform vec3  uLift;
    uniform vec3  uGain;
    uniform float uSaturation;
    uniform float uContrast;

    varying vec2 vUv;

    const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );

    float hash( vec2 p ) {
      p = fract( p * vec2( 443.897, 441.423 ) );
      p += dot( p, p.yx + 19.19 );
      return fract( ( p.x + p.y ) * p.x );
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot( centered, centered );

      // Lens: chromatic aberration grows toward the edge, and a hit or an
      // adrenaline rush pushes it further for a woozy, physical feel.
      float ab = uAberration * ( 1.0 + uDamage * 5.0 + uAdrenaline * 2.0 )
               * ( 0.35 + r2 * 2.6 );
      vec2 dir = r2 > 0.00001 ? normalize( centered ) : vec2( 0.0 );

      vec3 color;
      color.r = texture2D( tDiffuse, uv + dir * ab ).r;
      color.g = texture2D( tDiffuse, uv ).g;
      color.b = texture2D( tDiffuse, uv - dir * ab ).b;

      // Filmic grade: lift/gain, contrast around mid grey, saturation.
      color = color * uGain + uLift;
      color = ( color - 0.5 ) * uContrast + 0.5;
      float luma = dot( color, LUMA );
      color = mix( vec3( luma ), color, uSaturation );

      // Low health: the world drains of colour and crushes toward red.
      float hurt = 1.0 - clamp( uHealth, 0.0, 1.0 );
      if ( hurt > 0.001 ) {
        float pulse = 0.5 + 0.5 * sin( uTime * 5.5 );
        float amt = hurt * hurt;
        color = mix( color, vec3( luma ), amt * 0.75 );
        color.r += amt * ( 0.06 + 0.05 * pulse );
        color.gb *= 1.0 - amt * 0.22;
      }

      // Freeze power-up: cyan bias plus frosted edges.
      if ( uFreeze > 0.001 ) {
        color = mix( color, vec3( luma ) * vec3( 0.55, 0.85, 1.15 ), uFreeze * 0.55 );
        color += uFreeze * r2 * 0.35 * vec3( 0.3, 0.6, 1.0 );
      }

      // Damage flash from the direction of the hit is handled by the HUD;
      // this is the whole-screen impact bloom.
      color = mix( color, vec3( 0.62, 0.045, 0.03 ), uDamage * 0.55 );

      // Adrenaline: warm push and a little extra bite.
      color += uAdrenaline * vec3( 0.10, 0.045, 0.0 ) * ( 0.5 + 0.5 * sin( uTime * 9.0 ) );

      // Vignette, tightened when hurt so the tunnel closes in.
      float vig = smoothstep( 0.85, 0.12, r2 * ( 1.9 + hurt * 1.5 ) );
      color *= mix( 1.0, vig, uVignette * ( 0.75 + hurt * 0.5 ) );

      // Animated sensor grain — scaled down in bright areas like real film.
      float g = hash( uv * uResolution + fract( uTime ) * 1371.0 ) - 0.5;
      color += g * uGrain * ( 1.0 - 0.6 * dot( color, LUMA ) );

      // Explosion whiteout.
      color = mix( color, vec3( 1.0 ), clamp( uFlash, 0.0, 1.0 ) );

      gl_FragColor = vec4( max( color, 0.0 ), 1.0 );
    }
  `,
};
