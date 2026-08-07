/**
 * 標高 PNG タイルのデコーダ群。
 *
 * どちらも「RGB 24bit に整数を詰める」点は同じで、スケールとゼロ点だけが違う。
 * サーバの仕様が不明でも、両方で復号して「もっともらしい標高が出るほう」を
 * 選べば実用上ほぼ確実に当たる（TileSource の自動判定を参照）。
 */

export type DecoderId = 'terrain-rgb' | 'gsi-dem' | 'terrarium';

export interface Decoder {
  id: DecoderId;
  label: string;
  /** RGB (0-255) → 標高[m]。データ無しの場合は NaN を返す。 */
  decode(r: number, g: number, b: number): number;
}

/** Mapbox Terrain-RGB 系: elev = -10000 + (R*65536 + G*256 + B) * 0.1 */
export const terrainRgb: Decoder = {
  id: 'terrain-rgb',
  label: 'Terrain-RGB (Mapbox方式)',
  decode(r, g, b) {
    return -10000 + (r * 65536 + g * 256 + b) * 0.1;
  },
};

/**
 * 国土地理院 標高タイル (dem_png):
 * x = R*65536 + G*256 + B を符号付き 24bit として解釈し、u=0.01 を掛ける。
 * x === 2^23 (0x800000) は「データ無し」。
 */
export const gsiDem: Decoder = {
  id: 'gsi-dem',
  label: 'GSI 標高タイル (dem_png)',
  decode(r, g, b) {
    const x = r * 65536 + g * 256 + b;
    if (x === 0x800000) return NaN;
    return (x < 0x800000 ? x : x - 0x1000000) * 0.01;
  },
};

/** Mapzen/AWS Terrarium: elev = (R*256 + G + B/256) - 32768 */
export const terrarium: Decoder = {
  id: 'terrarium',
  label: 'Terrarium (Mapzen方式)',
  decode(r, g, b) {
    return r * 256 + g + b / 256 - 32768;
  },
};

export const DECODERS: Decoder[] = [terrainRgb, gsiDem, terrarium];

export function decoderById(id: DecoderId): Decoder {
  const d = DECODERS.find((x) => x.id === id);
  if (!d) throw new Error(`unknown decoder: ${id}`);
  return d;
}

/**
 * デコード結果が「地球上の陸地としてありえるか」を採点する。
 * 自動判定で使う。高いほどもっともらしい。
 */
export function plausibility(samples: Float32Array, expected?: { min: number; max: number }): number {
  let valid = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of samples) {
    if (!Number.isFinite(v)) continue;
    // 地球上の標高としてありえない値は即失格
    if (v < -500 || v > 9000) return -Infinity;
    valid++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (valid < samples.length * 0.5) return -Infinity;

  const mean = sum / valid;
  let score = 0;

  // 期待レンジ（その山域のおおよその標高）に収まっていれば大幅加点
  if (expected) {
    const overlap =
      Math.min(max, expected.max) - Math.max(min, expected.min);
    const span = Math.max(1, expected.max - expected.min);
    score += 100 * Math.max(0, overlap / span);
    // 平均が期待レンジの中にあるか
    if (mean >= expected.min && mean <= expected.max) score += 50;
    score -= Math.abs(mean - (expected.min + expected.max) / 2) / 100;
  }

  // 起伏がゼロ（＝単色 = デコード失敗の典型）は減点
  const relief = max - min;
  if (relief < 1) score -= 100;

  return score;
}
