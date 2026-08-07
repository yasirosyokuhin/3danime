import { DECODERS, decoderById, plausibility, type Decoder, type DecoderId } from './decoders';
import { lonLatToTile } from '../geo/mercator';

export interface TileSourceConfig {
  id: string;
  label: string;
  /** {z}/{x}/{y} を含む URL テンプレート */
  urlTemplate: string;
  /** null なら自動判定 */
  decoder: DecoderId | null;
  minZoom: number;
  maxZoom: number;
  tileSize: number;
  /** tms は y 軸が反転（下が原点） */
  scheme: 'xyz' | 'tms';
  attribution: string;
}

export interface ResolvedSource extends TileSourceConfig {
  decoder: DecoderId;
}

export function tileUrl(cfg: TileSourceConfig, z: number, x: number, y: number): string {
  const n = 2 ** z;
  const ty = cfg.scheme === 'tms' ? n - 1 - y : y;
  return cfg.urlTemplate
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(ty));
}

/** 候補となるタイルソース。上から順に試す。 */
export const CANDIDATE_SOURCES: TileSourceConfig[] = [
  // --- ユーザー指定のサーバ (armd-01)。ディレクトリ構成が不明なので複数パターンを総当たり ---
  ...['', 'dem/', 'dem_png/', 'terrain/', 'elevation/', 'height/', 'std/'].map((sub, i) => ({
    id: `armd-${i}`,
    label: `armd-01 /tiles/${sub}`,
    urlTemplate: `https://armd-01.sakura.ne.jp/tiles/${sub}{z}/{x}/{y}.png`,
    decoder: null,
    minZoom: 0,
    maxZoom: 15,
    tileSize: 256,
    scheme: 'xyz' as const,
    attribution: 'armd-01.sakura.ne.jp',
  })),
  // --- フォールバック: 国土地理院。日本国内なら確実に取れる ---
  {
    id: 'gsi-dem5a',
    label: '国土地理院 DEM5A (5mメッシュ)',
    urlTemplate: 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png',
    decoder: 'gsi-dem',
    minZoom: 1,
    maxZoom: 15,
    tileSize: 256,
    scheme: 'xyz',
    attribution: '国土地理院 標高タイル',
  },
  {
    id: 'gsi-dem',
    label: '国土地理院 DEM10B (10mメッシュ)',
    urlTemplate: 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png',
    decoder: 'gsi-dem',
    minZoom: 1,
    maxZoom: 14,
    tileSize: 256,
    scheme: 'xyz',
    attribution: '国土地理院 標高タイル',
  },
];

/** 画像を読み込んで RGBA バイト列にする。CORS 不許可ならここで失敗する。 */
export async function loadTilePixels(
  url: string,
  tileSize: number,
  timeoutMs = 8000,
): Promise<Uint8ClampedArray> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error(`timeout: ${url}`));
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`load failed (404 or CORS): ${url}`));
    };
    img.src = url;
  });

  const w = img.naturalWidth || tileSize;
  const h = img.naturalHeight || tileSize;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(img, 0, 0);
  try {
    return ctx.getImageData(0, 0, w, h).data;
  } catch {
    // canvas が汚染された = CORS ヘッダが無い
    throw new Error(`CORS: canvas tainted, cannot read pixels from ${url}`);
  }
}

export interface ProbeResult {
  source: ResolvedSource;
  sampleMin: number;
  sampleMax: number;
  score: number;
}

/**
 * 候補ソースを順に叩き、実際にデコードできて標高が妥当なものを 1 つ選ぶ。
 *
 * 「サーバの仕様が分からない」問題をここで吸収する。URL の当たりを総当たりし、
 * 当たった画像に対して全デコーダを試して最良スコアを採用する。
 */
export async function autoDetectSource(
  probe: { lon: number; lat: number; expected: { min: number; max: number } },
  candidates: TileSourceConfig[] = CANDIDATE_SOURCES,
  onProgress?: (msg: string) => void,
): Promise<ProbeResult> {
  const errors: string[] = [];

  for (const cfg of candidates) {
    const z = Math.min(cfg.maxZoom, 13);
    const t = lonLatToTile(probe.lon, probe.lat, z);
    const url = tileUrl(cfg, z, Math.floor(t.x), Math.floor(t.y));
    onProgress?.(`判定中: ${cfg.label}`);

    let pixels: Uint8ClampedArray;
    try {
      pixels = await loadTilePixels(url, cfg.tileSize);
    } catch (e) {
      errors.push(`${cfg.label}: ${(e as Error).message}`);
      continue;
    }

    // このソースで試すデコーダを決める（指定があればそれだけ、無ければ全部）
    const tryDecoders: Decoder[] = cfg.decoder ? [decoderById(cfg.decoder)] : DECODERS;

    let best: ProbeResult | null = null;
    for (const dec of tryDecoders) {
      // 全画素だと重いので間引いてスコアリング
      const step = 8;
      const side = Math.floor(Math.sqrt(pixels.length / 4));
      const out: number[] = [];
      for (let y = 0; y < side; y += step) {
        for (let x = 0; x < side; x += step) {
          const i = (y * side + x) * 4;
          if (pixels[i + 3] === 0) {
            out.push(NaN);
            continue;
          }
          out.push(dec.decode(pixels[i], pixels[i + 1], pixels[i + 2]));
        }
      }
      const arr = Float32Array.from(out);
      const score = plausibility(arr, probe.expected);
      if (!Number.isFinite(score)) continue;

      let mn = Infinity;
      let mx = -Infinity;
      for (const v of arr) {
        if (!Number.isFinite(v)) continue;
        mn = Math.min(mn, v);
        mx = Math.max(mx, v);
      }
      const result: ProbeResult = {
        source: { ...cfg, decoder: dec.id },
        sampleMin: mn,
        sampleMax: mx,
        score,
      };
      if (!best || result.score > best.score) best = result;
    }

    if (best) {
      onProgress?.(
        `採用: ${best.source.label} / ${decoderById(best.source.decoder).label} ` +
          `(標高 ${best.sampleMin.toFixed(0)}〜${best.sampleMax.toFixed(0)}m)`,
      );
      return best;
    }
    errors.push(`${cfg.label}: 画像は取得できたがデコード結果が標高として不正`);
  }

  throw new Error(`利用可能な標高タイルが見つかりませんでした:\n${errors.join('\n')}`);
}
