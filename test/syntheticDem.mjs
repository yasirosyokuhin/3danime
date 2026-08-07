/**
 * テスト用の合成 DEM タイル生成。
 *
 * 実サーバに繋がない環境でもパイプライン全体（PNG デコード → タイル貼り合わせ →
 * メルカトル座標変換 → メッシュ生成 → ゲーム進行）を検証できるように、
 * 富士山を模した円錐を国土地理院 dem_png 形式の PNG として合成する。
 */
import zlib from 'node:zlib';

/* ---------- 最小限の PNG エンコーダ ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgb: Uint8Array(width*height*3) → PNG (truecolor 8bit) */
export function encodePng(width, height, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 各スキャンラインの先頭にフィルタバイト 0 を付ける
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const o = y * (width * 3 + 1);
    raw[o] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, o + 1);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 合成地形 ---------- */

export const SUMMIT = { lon: 138.72743, lat: 35.36055, elevation: 3776 };
const BASE_ELEV = 800;
const CONE_RADIUS = 12000;

/** 原点近似での度→メートル（テスト用なので固定係数で十分） */
const M_PER_LAT = 110946;
const M_PER_LON = 90920; // 緯度 35.36° 付近

/**
 * 解析的な富士山モデル。ゲーム側の座標変換が正しければ、
 * ゲーム内で測った標高がこの値と一致するはず。
 */
export function elevationAt(lon, lat) {
  const dx = (lon - SUMMIT.lon) * M_PER_LON;
  const dy = (lat - SUMMIT.lat) * M_PER_LAT;
  const d = Math.hypot(dx, dy);

  const t = Math.max(0, 1 - d / CONE_RADIUS);
  let h = BASE_ELEV + (SUMMIT.elevation - BASE_ELEV) * Math.pow(t, 1.5);

  // 放射谷（大沢崩れ的な溝）で傾斜に変化をつける。
  // 中心では theta が定義できず尖ってしまうので、頂上付近では効果を消す。
  const theta = Math.atan2(dy, dx);
  const radial = Math.min(1, d / 900);
  h += Math.sin(theta * 8) * 55 * t * radial;

  // 45度を超える岩壁を 1 本作る（滑落判定を実際に踏むため）。
  // 南西方向の 1.5〜2.5km にある段差。
  const wallDist = Math.abs(d - 2000);
  const towardWall = Math.cos(theta - Math.PI * 1.25);
  if (towardWall > 0.86) {
    const across = Math.max(0, 1 - wallDist / 260);
    h += 300 * Math.pow(across, 0.7) * Math.pow((towardWall - 0.86) / 0.14, 0.5);
  }

  return h;
}

/** GSI dem_png のエンコード: 標高*100 を符号付き 24bit で RGB に詰める */
function encodeElevation(h, out, i) {
  let x = Math.round(h * 100);
  if (x < 0) x += 0x1000000;
  out[i] = (x >> 16) & 0xff;
  out[i + 1] = (x >> 8) & 0xff;
  out[i + 2] = x & 0xff;
}

const TILE = 256;

/** z/x/y の合成標高タイルを PNG バッファで返す */
export function makeTile(z, x, y) {
  const n = 2 ** z;
  const rgb = new Uint8Array(TILE * TILE * 3);

  for (let py = 0; py < TILE; py++) {
    // グローバルピクセル → タイル座標 → 緯度
    const ty = y + (py + 0.5) / TILE;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n)));
    const lat = (latRad * 180) / Math.PI;

    for (let px = 0; px < TILE; px++) {
      const tx = x + (px + 0.5) / TILE;
      const lon = (tx / n) * 360 - 180;
      encodeElevation(elevationAt(lon, lat), rgb, (py * TILE + px) * 3);
    }
  }

  return encodePng(TILE, TILE, rgb);
}
