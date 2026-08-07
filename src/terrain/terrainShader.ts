import * as THREE from 'three';

/**
 * 標高と傾斜だけから地表の見た目を作るシェーダ。
 * 航空写真タイルを一切ダウンロードしないので軽く、オフラインでも破綻しない。
 *
 * 富士山の帯構造を再現している:
 *   〜1600m  樹海（濃い針葉樹）
 *   〜2400m  亜高山帯（低木・カラマツ）
 *   〜3300m  火山礫（赤褐色〜黒のスコリア）— 富士山らしさの本体
 *   3300m〜  露岩と残雪
 * 急斜面には土も雪も乗らないので、傾斜が立つほど岩肌が出る。
 */

export const terrainVertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const terrainFragmentShader = /* glsl */ `
  precision highp float;

  varying vec3 vWorldPos;
  varying vec3 vNormal;

  uniform vec3 uSunDir;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uSnowLine;
  uniform float uTreeLine;
  uniform vec3 uCameraPos;
  uniform float uContourInterval;
  uniform float uContourStrength;

  // --- ノイズ (value noise + fbm) ---
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      v += amp * noise(p);
      p *= 2.03;
      amp *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 n = normalize(vNormal);
    float elev = vWorldPos.y;

    // 傾斜: 0 = 水平, 1 = 垂直
    float slope = clamp(1.0 - n.y, 0.0, 1.0);
    float slopeDeg = degrees(acos(clamp(n.y, -1.0, 1.0)));

    // 大小 2 スケールのノイズで単調さを消す
    float nBig = fbm(vWorldPos.xz * 0.0035);
    float nMid = fbm(vWorldPos.xz * 0.02);
    float nFine = fbm(vWorldPos.xz * 0.15);

    // --- 基本色（標高帯） ---
    vec3 forest    = mix(vec3(0.075, 0.145, 0.070), vec3(0.130, 0.200, 0.095), nMid);
    vec3 subalpine = mix(vec3(0.190, 0.205, 0.135), vec3(0.255, 0.240, 0.170), nMid);
    vec3 scoria    = mix(vec3(0.255, 0.165, 0.130), vec3(0.150, 0.115, 0.105), nBig);
    vec3 highRock  = mix(vec3(0.300, 0.265, 0.250), vec3(0.185, 0.170, 0.165), nMid);

    // ノイズで境界をぼかし、等高線のような不自然な直線を避ける
    float eJit = (nBig - 0.5) * 220.0;
    float e = elev + eJit;

    vec3 col = forest;
    col = mix(col, subalpine, smoothstep(uTreeLine - 800.0, uTreeLine - 150.0, e));
    col = mix(col, scoria,    smoothstep(uTreeLine - 150.0, uTreeLine + 250.0, e));
    col = mix(col, highRock,  smoothstep(uSnowLine - 500.0, uSnowLine + 100.0, e));

    // --- 露岩: 急斜面は植生も礫も乗らない ---
    vec3 rock = mix(vec3(0.235, 0.215, 0.205), vec3(0.115, 0.105, 0.100), nFine);
    float rockMask = smoothstep(30.0, 52.0, slopeDeg);
    col = mix(col, rock, rockMask * 0.92);

    // --- 積雪: 高標高かつ緩斜面に積もる ---
    float snowAmt = smoothstep(uSnowLine - 250.0, uSnowLine + 350.0, e);
    snowAmt *= 1.0 - smoothstep(38.0, 62.0, slopeDeg);   // 急斜面には残らない
    snowAmt *= 0.55 + 0.45 * smoothstep(0.35, 0.75, nMid); // まだら模様
    vec3 snow = vec3(0.90, 0.93, 0.98);
    col = mix(col, snow, clamp(snowAmt, 0.0, 1.0));

    // --- ライティング ---
    vec3 L = normalize(uSunDir);
    float diff = clamp(dot(n, L), 0.0, 1.0);
    // 空からの環境光は上向き面ほど強い。
    // 日陰側の斜面でも足元の起伏が読めるだけの明るさは残す
    // （読めないと登攀ルートが選べずゲームとして成立しない）。
    float sky = 0.5 + 0.5 * n.y;
    vec3 ambient = mix(vec3(0.30, 0.33, 0.41), vec3(0.56, 0.59, 0.66), sky);
    vec3 sunCol = vec3(1.04, 0.98, 0.90);

    col = col * (ambient + sunCol * diff * 0.95);

    // 尾根を明るく、谷を暗く（AO 近似）
    float ao = mix(0.78, 1.0, smoothstep(0.0, 1.0, n.y));
    col *= ao;

    // --- 等高線（登攀ルートの高度感を掴みやすくする） ---
    if (uContourStrength > 0.001) {
      float c = elev / uContourInterval;
      float w = fwidth(c);
      float line = 1.0 - smoothstep(0.0, w * 1.5, abs(fract(c) - 0.5) - (0.5 - w * 1.5));
      col = mix(col, col * 0.72, clamp(line, 0.0, 1.0) * uContourStrength);
    }

    // --- 距離フォグ（大気遠近） ---
    float dist = distance(vWorldPos, uCameraPos);
    float fogAmt = smoothstep(uFogNear, uFogFar, dist);
    // 高いところほど空気が澄む
    fogAmt *= mix(1.0, 0.55, smoothstep(2000.0, 3800.0, uCameraPos.y));
    col = mix(col, uFogColor, fogAmt);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface TerrainUniforms {
  uSunDir: { value: THREE.Vector3 };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
  uSnowLine: { value: number };
  uTreeLine: { value: number };
  uCameraPos: { value: THREE.Vector3 };
  uContourInterval: { value: number };
  uContourStrength: { value: number };
}

export function createTerrainMaterial(opts: {
  snowLine: number;
  treeLine: number;
  fogColor: THREE.Color;
  fogNear: number;
  fogFar: number;
}): THREE.ShaderMaterial {
  const uniforms: TerrainUniforms = {
    uSunDir: { value: new THREE.Vector3(0.45, 0.72, 0.53).normalize() },
    uFogColor: { value: opts.fogColor.clone() },
    uFogNear: { value: opts.fogNear },
    uFogFar: { value: opts.fogFar },
    uSnowLine: { value: opts.snowLine },
    uTreeLine: { value: opts.treeLine },
    uCameraPos: { value: new THREE.Vector3() },
    uContourInterval: { value: 100 },
    uContourStrength: { value: 0.35 },
  };

  return new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: terrainVertexShader,
    fragmentShader: terrainFragmentShader,
    side: THREE.FrontSide,
  });
}
