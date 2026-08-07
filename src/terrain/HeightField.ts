import { LocalFrame, lonLatToTile, metersPerPixel } from '../geo/mercator';
import { decoderById } from './decoders';
import { loadTilePixels, tileUrl, type ResolvedSource } from './TileSource';

export interface HeightFieldOptions {
  source: ResolvedSource;
  frame: LocalFrame;
  /** 原点から東西南北それぞれ何メートル分を読み込むか */
  radiusMeters: number;
  zoom: number;
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * 複数の標高タイルを 1 枚の連続した高さ格子に貼り合わせ、
 * ワールド座標（メートル）から標高をバイリニア補間で引けるようにする。
 */
export class HeightField {
  readonly source: ResolvedSource;
  readonly frame: LocalFrame;
  readonly zoom: number;
  readonly tileSize: number;

  /** 格子の左上に対応するグローバルピクセル座標 */
  private originPxX = 0;
  private originPxY = 0;
  private width = 0;
  private height = 0;
  private data!: Float32Array;

  /** 読み込み済み範囲の統計 */
  minElevation = Infinity;
  maxElevation = -Infinity;
  /** 原点緯度における 1 ピクセルのメートル数（参考値） */
  readonly resolutionMeters: number;

  constructor(opts: HeightFieldOptions) {
    this.source = opts.source;
    this.frame = opts.frame;
    this.zoom = Math.min(opts.zoom, opts.source.maxZoom);
    this.tileSize = opts.source.tileSize;
    this.resolutionMeters = metersPerPixel(opts.frame.originLat, this.zoom, this.tileSize);
  }

  static async load(opts: HeightFieldOptions): Promise<HeightField> {
    const hf = new HeightField(opts);
    await hf.loadTiles(opts.radiusMeters, opts.onProgress);
    return hf;
  }

  private async loadTiles(radiusMeters: number, onProgress?: (l: number, t: number) => void) {
    const { frame } = this;
    const z = this.zoom;
    const ts = this.tileSize;

    // 必要な範囲を緯度経度に直し、それを含むタイル矩形を求める
    const corners = [
      frame.toLonLat(-radiusMeters, -radiusMeters),
      frame.toLonLat(radiusMeters, -radiusMeters),
      frame.toLonLat(-radiusMeters, radiusMeters),
      frame.toLonLat(radiusMeters, radiusMeters),
    ].map((c) => lonLatToTile(c.lon, c.lat, z));

    const tx0 = Math.floor(Math.min(...corners.map((c) => c.x)));
    const tx1 = Math.floor(Math.max(...corners.map((c) => c.x)));
    const ty0 = Math.floor(Math.min(...corners.map((c) => c.y)));
    const ty1 = Math.floor(Math.max(...corners.map((c) => c.y)));

    const nx = tx1 - tx0 + 1;
    const ny = ty1 - ty0 + 1;

    this.originPxX = tx0 * ts;
    this.originPxY = ty0 * ts;
    this.width = nx * ts;
    this.height = ny * ts;
    this.data = new Float32Array(this.width * this.height).fill(NaN);

    const decoder = decoderById(this.source.decoder);
    const total = nx * ny;
    let loaded = 0;

    // 並列度を絞りつつ全タイルを取得（サーバに優しく、かつ十分速い）
    const jobs: Array<() => Promise<void>> = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        jobs.push(async () => {
          const url = tileUrl(this.source, z, tx, ty);
          try {
            const px = await loadTilePixels(url, ts);
            const side = Math.round(Math.sqrt(px.length / 4));
            const ox = (tx - tx0) * ts;
            const oy = (ty - ty0) * ts;
            for (let y = 0; y < side; y++) {
              const rowOut = (oy + y) * this.width + ox;
              const rowIn = y * side * 4;
              for (let x = 0; x < side; x++) {
                const i = rowIn + x * 4;
                if (px[i + 3] === 0) continue;
                const v = decoder.decode(px[i], px[i + 1], px[i + 2]);
                if (!Number.isFinite(v)) continue;
                this.data[rowOut + x] = v;
              }
            }
          } catch {
            // 欠損タイルは NaN のまま残し、後段の穴埋めに任せる
          } finally {
            loaded++;
            onProgress?.(loaded, total);
          }
        });
      }
    }

    const CONCURRENCY = 6;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor++];
          await job();
        }
      }),
    );

    this.fillHoles();
    this.computeStats();
  }

  /** 欠損 (NaN) を近傍の平均で数回に分けて埋める。海や欠測タイルの穴対策。 */
  private fillHoles() {
    const { width: w, height: h, data } = this;
    let remaining = 0;
    for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) remaining++;
    if (remaining === 0) return;

    for (let pass = 0; pass < 8 && remaining > 0; pass++) {
      const next = Float32Array.from(data);
      let filled = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (Number.isFinite(data[i])) continue;
          let sum = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nxp = x + dx;
              const nyp = y + dy;
              if (nxp < 0 || nyp < 0 || nxp >= w || nyp >= h) continue;
              const v = data[nyp * w + nxp];
              if (!Number.isFinite(v)) continue;
              sum += v;
              n++;
            }
          }
          if (n > 0) {
            next[i] = sum / n;
            filled++;
          }
        }
      }
      this.data = next;
      remaining -= filled;
      if (filled === 0) break;
    }
    // それでも埋まらなければ 0m 扱い
    for (let i = 0; i < this.data.length; i++) {
      if (!Number.isFinite(this.data[i])) this.data[i] = 0;
    }
  }

  private computeStats() {
    let mn = Infinity;
    let mx = -Infinity;
    for (const v of this.data) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    this.minElevation = mn;
    this.maxElevation = mx;
  }

  /** グローバルピクセル座標でのバイリニア補間 */
  private sampleGlobalPx(gx: number, gy: number): number {
    const x = gx - this.originPxX;
    const y = gy - this.originPxY;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;

    const cx0 = Math.min(Math.max(x0, 0), this.width - 1);
    const cy0 = Math.min(Math.max(y0, 0), this.height - 1);
    const cx1 = Math.min(cx0 + 1, this.width - 1);
    const cy1 = Math.min(cy0 + 1, this.height - 1);

    const d = this.data;
    const w = this.width;
    const h00 = d[cy0 * w + cx0];
    const h10 = d[cy0 * w + cx1];
    const h01 = d[cy1 * w + cx0];
    const h11 = d[cy1 * w + cx1];

    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fy;
  }

  /**
   * 等間隔グリッドを一括サンプリングする（メッシュ生成用の高速版）。
   *
   * heightAt を count^2 回呼ぶと緯度→タイル座標の tan/log が毎回走って重い。
   * 経度→X は線形、緯度→Y は行ごとに一定なので、両方を先に畳んでおく。
   * 返り値は row-major (j * count + i)、位置は (east0 + i*cell, north0 + j*cell)。
   */
  sampleGrid(east0: number, north0: number, cell: number, count: number): Float32Array {
    const { frame, zoom, tileSize } = this;
    const scale = 2 ** zoom * tileSize;
    const out = new Float32Array(count * count);

    // 経度方向は完全に線形なので X ピクセルを先に作り置き
    const gxs = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const lon = frame.originLon + (east0 + i * cell) / frame.mPerLon;
      gxs[i] = ((lon + 180) / 360) * scale;
    }

    for (let j = 0; j < count; j++) {
      const lat = frame.originLat + (north0 + j * cell) / frame.mPerLat;
      const latRad = (lat * Math.PI) / 180;
      const gy =
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
      const row = j * count;
      for (let i = 0; i < count; i++) {
        out[row + i] = this.sampleGlobalPx(gxs[i], gy);
      }
    }
    return out;
  }

  /** 緯度経度から標高[m] */
  heightAtLonLat(lon: number, lat: number): number {
    const t = lonLatToTile(lon, lat, this.zoom);
    return this.sampleGlobalPx(t.x * this.tileSize, t.y * this.tileSize);
  }

  /**
   * ワールド座標（east[m], north[m]）から標高[m]。
   * ゲームロジックとメッシュ生成の両方がこれを使う。
   */
  heightAt(east: number, north: number): number {
    const ll = this.frame.toLonLat(east, north);
    return this.heightAtLonLat(ll.lon, ll.lat);
  }

  /**
   * 地表の法線。有限差分で求める。
   * eps を大きくすると滑らかに（＝掴める判定が甘く）なる。
   */
  normalAt(east: number, north: number, eps = 4): [number, number, number] {
    const hL = this.heightAt(east - eps, north);
    const hR = this.heightAt(east + eps, north);
    const hD = this.heightAt(east, north - eps);
    const hU = this.heightAt(east, north + eps);

    // 接ベクトル: (2eps, hR-hL, 0) と (0, hU-hD, 2eps) の外積
    const dhdx = (hR - hL) / (2 * eps);
    const dhdn = (hU - hD) / (2 * eps);
    // ワールド: +X=東, +Y=上, -Z=北 → north 方向は -Z
    const nx = -dhdx;
    const ny = 1;
    const nz = dhdn;
    const len = Math.hypot(nx, ny, nz);
    return [nx / len, ny / len, nz / len];
  }

  /** 傾斜角[度]。0 = 水平, 90 = 垂直の壁 */
  slopeAt(east: number, north: number, eps = 4): number {
    const n = this.normalAt(east, north, eps);
    return (Math.acos(Math.min(1, Math.max(-1, n[1]))) * 180) / Math.PI;
  }
}
