import * as THREE from 'three';
import type { HeightField } from './HeightField';

/**
 * 四分木ベースの地形 LOD。
 *
 * プレイヤーに近いノードほど深く分割し、遠いノードは粗いまま描く。
 * 葉の頂点数は一定なので、視界内の総頂点数は範囲の広さではなく
 * 四分木の深さ（= log）でしか増えない。
 *
 * 隣り合う葉の分割深度が違うと辺に隙間（クラック）が出るので、
 * 各葉の外周に下向きの「スカート」を付けて塞ぐ。
 */

export interface TerrainLODOptions {
  /** ルートノードの一辺[m]。プレイ範囲全体を覆う */
  rootSize: number;
  /** 最大分割深度。葉の一辺 = rootSize / 2^maxDepth */
  maxDepth: number;
  /** 葉 1 枚あたりの分割数（頂点は (gridRes+1)^2） */
  gridRes: number;
  /** 大きいほど手前まで細かくなる */
  lodBias: number;
  material: THREE.Material;
  /** キャッシュに保持する葉ジオメトリの上限 */
  cacheLimit: number;
}

interface LeafKey {
  depth: number;
  ix: number;
  iy: number;
}

function keyString(k: LeafKey): string {
  return `${k.depth}/${k.ix}/${k.iy}`;
}

export class TerrainLOD {
  readonly group = new THREE.Group();
  private hf: HeightField;
  private opts: TerrainLODOptions;

  /** 全ノードで共有するインデックスバッファ（配置は同一なので使い回せる） */
  private sharedIndex: THREE.BufferAttribute;
  private vertsPerSide: number;

  private cache = new Map<string, THREE.Mesh>();
  private active = new Set<string>();
  private lastRebuildAt = new THREE.Vector3(Infinity, Infinity, Infinity);

  /** 直近の描画統計（HUD 表示用） */
  stats = { leaves: 0, triangles: 0 };

  constructor(hf: HeightField, opts: TerrainLODOptions) {
    this.hf = hf;
    this.opts = opts;
    this.group.name = 'terrain';
    // 内側 (gridRes+1) + 外周スカート 1 周
    this.vertsPerSide = opts.gridRes + 3;
    this.sharedIndex = TerrainLOD.buildIndex(this.vertsPerSide);
  }

  /** 全ノード共通の三角形インデックスを 1 度だけ作る */
  private static buildIndex(n: number): THREE.BufferAttribute {
    const quads = (n - 1) * (n - 1);
    const idx = quads * 6 < 65535 ? new Uint16Array(quads * 6) : new Uint32Array(quads * 6);
    let p = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1; // +i → 東 (+X)
        const c = a + n; // +j → 北 (-Z)
        const d = c + 1;
        // 格子の j は北向き = -Z なので、(a,b,c) の順で巻くと
        // 面法線が +Y（上）を向く。逆にすると地表が裏面になり、
        // FrontSide のカリングで上面が丸ごと消える。
        idx[p++] = a;
        idx[p++] = b;
        idx[p++] = c;
        idx[p++] = b;
        idx[p++] = d;
        idx[p++] = c;
      }
    }
    return new THREE.BufferAttribute(idx, 1);
  }

  /**
   * 1 枚の葉のジオメトリを作る。
   * east0/north0 はノードの南西角、size は一辺[m]。
   */
  private buildLeaf(east0: number, north0: number, size: number): THREE.BufferGeometry {
    const { gridRes } = this.opts;
    const n = this.vertsPerSide; // gridRes + 3
    const cell = size / gridRes;

    // 法線の中央差分用に 1 セル分外側まで含めてサンプリング
    const heights = this.hf.sampleGrid(east0 - cell, north0 - cell, cell, n);

    const positions = new Float32Array(n * n * 3);
    const normals = new Float32Array(n * n * 3);

    // スカートの落とし込み量。粗い LOD ほど段差が大きくなるので比例させる
    const skirtDepth = Math.max(12, cell * 2.5);

    let minY = Infinity;
    let maxY = -Infinity;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const vi = (j * n + i) * 3;
        const isSkirt = i === 0 || j === 0 || i === n - 1 || j === n - 1;

        // 実体の格子座標（スカートは端にクランプ）
        const gi = Math.min(Math.max(i, 1), n - 2);
        const gj = Math.min(Math.max(j, 1), n - 2);

        const east = east0 + (gi - 1) * cell;
        const north = north0 + (gj - 1) * cell;
        const h = heights[gj * n + gi];

        positions[vi] = east;
        positions[vi + 1] = isSkirt ? h - skirtDepth : h;
        positions[vi + 2] = -north; // 北は -Z

        // 中央差分で法線。gi/gj は 1..n-2 なので隣接は必ず存在する
        const hL = heights[gj * n + (gi - 1)];
        const hR = heights[gj * n + (gi + 1)];
        const hD = heights[(gj - 1) * n + gi];
        const hU = heights[(gj + 1) * n + gi];
        const dhdx = (hR - hL) / (2 * cell);
        const dhdn = (hU - hD) / (2 * cell);
        let nx = -dhdx;
        const ny = 1;
        let nz = dhdn;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        nz /= len;
        normals[vi] = nx;
        normals[vi + 1] = ny / len;
        normals[vi + 2] = nz;

        if (!isSkirt) {
          if (h < minY) minY = h;
          if (h > maxY) maxY = h;
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setIndex(this.sharedIndex);

    // 錐台カリング用の境界。スカート分を下に見込む
    const cx = east0 + size / 2;
    const cz = -(north0 + size / 2);
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(cx, (minY + maxY) / 2, cz),
      Math.hypot(size * 0.708, (maxY - minY) / 2 + skirtDepth),
    );
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(east0, minY - skirtDepth, cz - size / 2),
      new THREE.Vector3(east0 + size, maxY, cz + size / 2),
    );

    return geo;
  }

  private getLeaf(k: LeafKey, east0: number, north0: number, size: number): THREE.Mesh {
    const ks = keyString(k);
    const hit = this.cache.get(ks);
    if (hit) {
      // LRU: 触ったものを末尾へ
      this.cache.delete(ks);
      this.cache.set(ks, hit);
      return hit;
    }
    const mesh = new THREE.Mesh(this.buildLeaf(east0, north0, size), this.opts.material);
    mesh.name = ks;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.cache.set(ks, mesh);
    this.evict();
    return mesh;
  }

  private evict() {
    while (this.cache.size > this.opts.cacheLimit) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      const ks = oldest.value;
      if (this.active.has(ks)) {
        // 使用中のものは消さずに末尾へ回す
        const m = this.cache.get(ks)!;
        this.cache.delete(ks);
        this.cache.set(ks, m);
        // 全部が active なら諦める
        if (this.active.size >= this.cache.size) break;
        continue;
      }
      const m = this.cache.get(ks)!;
      this.cache.delete(ks);
      m.geometry.dispose();
    }
  }

  /** ノード矩形とプレイヤーの XZ 平面上の最短距離 */
  private static boxDistance(
    px: number,
    pz: number,
    east0: number,
    north0: number,
    size: number,
  ): number {
    const minX = east0;
    const maxX = east0 + size;
    const minZ = -(north0 + size);
    const maxZ = -north0;
    const dx = Math.max(minX - px, 0, px - maxX);
    const dz = Math.max(minZ - pz, 0, pz - maxZ);
    return Math.hypot(dx, dz);
  }

  /**
   * プレイヤー位置に合わせて四分木を選び直す。
   * 一定距離動くまでは何もしないので毎フレーム呼んでよい。
   */
  update(playerPos: THREE.Vector3, force = false) {
    const moved = this.lastRebuildAt.distanceTo(playerPos);
    const threshold = this.opts.rootSize / 2 ** this.opts.maxDepth / 4;
    if (!force && moved < threshold) return;
    this.lastRebuildAt.copy(playerPos);

    const half = this.opts.rootSize / 2;
    const selected: Array<{ k: LeafKey; e: number; n: number; s: number }> = [];

    const visit = (depth: number, ix: number, iy: number) => {
      const size = this.opts.rootSize / 2 ** depth;
      const east0 = -half + ix * size;
      const north0 = -half + iy * size;
      const dist = TerrainLOD.boxDistance(playerPos.x, playerPos.z, east0, north0, size);

      if (depth < this.opts.maxDepth && dist < size * this.opts.lodBias) {
        visit(depth + 1, ix * 2, iy * 2);
        visit(depth + 1, ix * 2 + 1, iy * 2);
        visit(depth + 1, ix * 2, iy * 2 + 1);
        visit(depth + 1, ix * 2 + 1, iy * 2 + 1);
      } else {
        selected.push({ k: { depth, ix, iy }, e: east0, n: north0, s: size });
      }
    };
    visit(0, 0, 0);

    this.group.clear();
    this.active.clear();
    let tris = 0;
    for (const s of selected) {
      const mesh = this.getLeaf(s.k, s.e, s.n, s.s);
      this.active.add(keyString(s.k));
      this.group.add(mesh);
      tris += this.sharedIndex.count / 3;
    }
    this.stats.leaves = selected.length;
    this.stats.triangles = tris;
  }

  dispose() {
    for (const m of this.cache.values()) m.geometry.dispose();
    this.cache.clear();
    this.group.clear();
  }
}
