/**
 * Web メルカトル (EPSG:3857) と XYZ タイル座標の相互変換。
 *
 * ゲーム内のワールド座標は「原点（出発地点の緯度経度）を中心とした
 * ローカル ENU メートル系」で、+X = 東 / +Y = 上 / -Z = 北 (three.js 既定の右手系)。
 */

export const EARTH_RADIUS = 6378137;
/** 赤道上での 1 タイル (256px) あたりのメートル数 */
export const EQUATOR_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;

export interface LonLat {
  lon: number;
  lat: number;
}

/** 緯度経度 → タイル座標（小数、zoom 指定）。y は上が北。 */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

/** タイル座標（小数）→ 緯度経度 */
export function tileToLonLat(x: number, y: number, z: number): LonLat {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lon, lat: (latRad * 180) / Math.PI };
}

/**
 * 指定ズーム・緯度における 1 ピクセル（256px タイル前提）のメートル数。
 * メルカトル図法は高緯度ほど引き伸ばされるため cos(lat) 補正が必要。
 */
export function metersPerPixel(lat: number, z: number, tileSize = 256): number {
  return (EQUATOR_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (tileSize * 2 ** z);
}

/**
 * 原点を基準にしたローカル平面近似。
 * 富士山クラス（数 km 四方）の範囲なら誤差は無視できる。
 */
export class LocalFrame {
  readonly originLon: number;
  readonly originLat: number;
  /** 経度 1 度あたりのメートル（原点緯度における） */
  readonly mPerLon: number;
  /** 緯度 1 度あたりのメートル */
  readonly mPerLat: number;

  constructor(origin: LonLat) {
    this.originLon = origin.lon;
    this.originLat = origin.lat;
    const latRad = (origin.lat * Math.PI) / 180;
    this.mPerLat = 111132.92 - 559.82 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad);
    this.mPerLon = 111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad);
  }

  /** 緯度経度 → ワールド (east, north) メートル */
  toLocal(lon: number, lat: number): { east: number; north: number } {
    return {
      east: (lon - this.originLon) * this.mPerLon,
      north: (lat - this.originLat) * this.mPerLat,
    };
  }

  /** ワールド (east, north) メートル → 緯度経度 */
  toLonLat(east: number, north: number): LonLat {
    return {
      lon: this.originLon + east / this.mPerLon,
      lat: this.originLat + north / this.mPerLat,
    };
  }
}
