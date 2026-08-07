import * as THREE from 'three';
import type { HeightField } from '../terrain/HeightField';
import type { Landmark } from '../game/routes';

/** 天球。地平線から天頂へのグラデーションと太陽のにじみ。 */
export function createSky(sunDir: THREE.Vector3, radius: number): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: sunDir.clone().normalize() },
      uHorizon: { value: new THREE.Color(0.62, 0.72, 0.86) },
      uZenith: { value: new THREE.Color(0.10, 0.24, 0.52) },
      uGround: { value: new THREE.Color(0.30, 0.32, 0.36) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 uSunDir;
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      uniform vec3 uGround;

      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;

        vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.62));
        // 地平線下はうっすら地面色に
        col = mix(col, uGround, smoothstep(0.0, -0.12, h));

        // 太陽本体とハロー
        float sd = dot(d, normalize(uSunDir));
        col += vec3(1.0, 0.92, 0.76) * pow(clamp(sd, 0.0, 1.0), 900.0) * 8.0;
        col += vec3(1.0, 0.88, 0.70) * pow(clamp(sd, 0.0, 1.0), 22.0) * 0.28;
        // 太陽側の地平線を暖色に
        col += vec3(0.9, 0.6, 0.35) * pow(clamp(sd, 0.0, 1.0), 5.0)
             * (1.0 - smoothstep(0.0, 0.35, abs(h))) * 0.22;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 20), mat);
  sky.name = 'sky';
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  return sky;
}

/**
 * 雲海。富士山の上部から見下ろしたときの主役なので、
 * 単なる板ではなく fbm で穴と濃淡を作る。
 */
export function createCloudSea(altitude: number, extent: number): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uCameraPos: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color(0.94, 0.96, 1.0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;
      uniform float uTime;
      uniform vec3 uCameraPos;
      uniform vec3 uColor;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.07; a *= 0.5; }
        return v;
      }

      void main() {
        vec2 uv = vWorldPos.xz * 0.00055;
        uv += vec2(uTime * 0.0035, uTime * 0.0018);
        float n = fbm(uv * 2.0) * 0.65 + fbm(uv * 7.0) * 0.35;

        float a = smoothstep(0.42, 0.72, n);
        // 遠くほど密に見える（視線が雲を長く貫くため）
        float dist = distance(vWorldPos.xz, uCameraPos.xz);
        a = mix(a, min(1.0, a + 0.42), smoothstep(1500.0, 9000.0, dist));
        // 真横から見たときにペラいのがバレないよう、端は薄く
        a *= smoothstep(14000.0, 8000.0, dist);

        float shade = 0.82 + 0.18 * smoothstep(0.4, 0.9, n);
        gl_FragColor = vec4(uColor * shade, a * 0.9);
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(extent, extent, 1, 1), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = altitude;
  mesh.name = 'cloud-sea';
  mesh.renderOrder = 10;
  return mesh;
}

/** テキストラベルのスプライトを作る */
function makeLabel(text: string, sub: string, accent: string): THREE.Sprite {
  const pad = 16;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const scale = 2;

  ctx.font = `700 ${28 * scale}px 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif`;
  const w1 = ctx.measureText(text).width;
  ctx.font = `${18 * scale}px ui-monospace, monospace`;
  const w2 = ctx.measureText(sub).width;

  canvas.width = Math.ceil(Math.max(w1, w2) + pad * 2 * scale);
  canvas.height = Math.ceil((28 + 18 + 14) * scale + pad * scale);

  ctx.fillStyle = 'rgba(8, 12, 20, 0.78)';
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, 10 * scale);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2 * scale;
  ctx.stroke();

  ctx.textBaseline = 'top';
  ctx.fillStyle = '#eef2f8';
  ctx.font = `700 ${28 * scale}px 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif`;
  ctx.fillText(text, pad * scale, pad * 0.5 * scale);
  ctx.fillStyle = accent;
  ctx.font = `${18 * scale}px ui-monospace, monospace`;
  ctx.fillText(sub, pad * scale, (pad * 0.5 + 32) * scale);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }),
  );
  // ワールド単位でのラベルの大きさ
  const h = 55;
  sprite.scale.set((canvas.width / canvas.height) * h, h, 1);
  sprite.renderOrder = 100;
  return sprite;
}

export interface MarkerSet {
  group: THREE.Group;
  update(cameraPos: THREE.Vector3): void;
  dispose(): void;
}

const KIND_COLOR: Record<Landmark['kind'], string> = {
  start: '#6fb2ff',
  hut: '#ffb454',
  crater: '#c08cff',
  peak: '#7ddc8f',
};

/** ランドマークのポールとラベルを配置する */
export function createMarkers(
  landmarks: Landmark[],
  hf: HeightField,
  frame: { toLocal(lon: number, lat: number): { east: number; north: number } },
): MarkerSet {
  const group = new THREE.Group();
  group.name = 'markers';
  const sprites: Array<{ sprite: THREE.Sprite; base: THREE.Vector3 }> = [];
  const disposables: Array<{ dispose(): void }> = [];

  for (const lm of landmarks) {
    const { east, north } = frame.toLocal(lm.lon, lm.lat);
    const y = hf.heightAt(east, north);
    const color = KIND_COLOR[lm.kind];
    const poleH = lm.kind === 'peak' ? 90 : 45;

    const poleGeo = new THREE.CylinderGeometry(1.2, 1.2, poleH, 6, 1, true);
    const poleMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(east, y + poleH / 2, -north);
    group.add(pole);
    disposables.push(poleGeo, poleMat);

    const label = makeLabel(lm.name, `${Math.round(lm.elevation)} m`, color);
    const base = new THREE.Vector3(east, y + poleH + 30, -north);
    label.position.copy(base);
    group.add(label);
    sprites.push({ sprite: label, base });
    disposables.push(label.material, label.material.map!);
  }

  return {
    group,
    update(cameraPos: THREE.Vector3) {
      // 近すぎると邪魔、遠すぎると読めないので距離で大きさと不透明度を調整
      for (const { sprite, base } of sprites) {
        const d = cameraPos.distanceTo(base);
        const s = THREE.MathUtils.clamp(d / 900, 0.35, 4.0);
        const aspect = sprite.scale.x / sprite.scale.y;
        const h = 55 * s;
        sprite.scale.set(aspect * h, h, 1);
        const m = sprite.material as THREE.SpriteMaterial;
        m.opacity = d < 60 ? 0.25 : THREE.MathUtils.clamp(1 - (d - 4000) / 4000, 0.15, 1);
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      group.clear();
    },
  };
}

/** 山頂の光柱。どこからでもゴールが分かるようにする。 */
export function createSummitBeacon(east: number, north: number, y: number): THREE.Mesh {
  const h = 2000;
  const geo = new THREE.CylinderGeometry(9, 26, h, 12, 1, true);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying float vY;
      void main() {
        vY = uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vY;
      uniform float uTime;
      void main() {
        float fade = pow(1.0 - vY, 2.2);
        float pulse = 0.72 + 0.28 * sin(uTime * 1.6 - vY * 6.0);
        gl_FragColor = vec4(vec3(0.49, 0.86, 0.56) * fade * pulse, fade * 0.32);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(east, y + h / 2, -north);
  mesh.renderOrder = 50;
  mesh.name = 'summit-beacon';
  return mesh;
}
