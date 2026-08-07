import * as THREE from 'three';
import './ui/styles.css';

import { LocalFrame } from './geo/mercator';
import { HeightField } from './terrain/HeightField';
import { TerrainLOD } from './terrain/TerrainLOD';
import { createTerrainMaterial } from './terrain/terrainShader';
import {
  autoDetectSource,
  CANDIDATE_SOURCES,
  type ResolvedSource,
  type TileSourceConfig,
} from './terrain/TileSource';
import type { DecoderId } from './terrain/decoders';
import { Climber, DEFAULT_TUNING } from './game/Climber';
import { Input } from './game/Input';
import { FUJI, difficultyLabel, type Mountain, type Route } from './game/routes';
import { Hud, formatClock } from './ui/Hud';
import {
  createCloudSea,
  createMarkers,
  createSky,
  createSummitBeacon,
  type MarkerSet,
} from './world/Scenery';

type Phase = 'title' | 'loading' | 'playing' | 'paused' | 'summit' | 'error';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/* ------------------------------------------------------------------ */
/* レンダラの基礎                                                       */
/* ------------------------------------------------------------------ */

const canvas = $<HTMLCanvasElement>('scene');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(68, 1, 0.5, 40000);
const input = new Input(canvas);
const hud = new Hud();

const SUN_DIR = new THREE.Vector3(0.42, 0.66, 0.62).normalize();
const FOG_COLOR = new THREE.Color(0.66, 0.75, 0.87);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

/* ------------------------------------------------------------------ */
/* 実行中のセッション                                                   */
/* ------------------------------------------------------------------ */

interface Session {
  mountain: Mountain;
  route: Route;
  frame: LocalFrame;
  hf: HeightField;
  terrain: TerrainLOD;
  climber: Climber;
  markers: MarkerSet;
  goal: { east: number; north: number; y: number };
  visited: Set<string>;
  anchorGroup: THREE.Group;
  terrainMaterial: THREE.ShaderMaterial;
  cloudMaterial: THREE.ShaderMaterial | null;
  beaconMaterial: THREE.ShaderMaterial;
  sourceLabel: string;
}

let phase: Phase = 'title';
let session: Session | null = null;

/** 俯瞰カメラ */
const freeCam = { on: false, yaw: 0, pitch: -0.45, dist: 420 };

/* ------------------------------------------------------------------ */
/* タイトル画面                                                         */
/* ------------------------------------------------------------------ */

function buildRouteList(mountain: Mountain) {
  const list = $('route-list');
  list.replaceChildren();
  for (const route of mountain.routes) {
    const startLm = route.landmarks[0];
    const gain = route.goal.elevation - startLm.elevation;

    const btn = document.createElement('button');
    btn.className = 'route';
    btn.innerHTML = `
      <span>
        <span class="name">${route.name}</span>
        <span class="sub">${route.subtitle} · 出発 ${startLm.name} ${startLm.elevation}m</span>
        <span class="desc">${route.description}</span>
      </span>
      <span class="meta">
        <b class="gain">+${gain}m</b>
        <span class="diff d${route.difficulty}">${difficultyLabel(route.difficulty)}</span>
      </span>`;
    btn.addEventListener('click', () => void start(mountain, route));
    list.appendChild(btn);
  }
}

// 詳細設定の出し入れ
$('opt-source').addEventListener('change', () => {
  const custom = ($('opt-source') as HTMLSelectElement).value === 'custom';
  $('custom-url-row').classList.toggle('hidden', !custom);
  $('custom-dec-row').classList.toggle('hidden', !custom);
});

function setPhase(p: Phase) {
  phase = p;
  $('title-screen').classList.toggle('hidden', p !== 'title');
  $('loading').classList.toggle('hidden', p !== 'loading');
  $('pause-screen').classList.toggle('hidden', p !== 'paused');
  $('summit-screen').classList.toggle('hidden', p !== 'summit');
  $('error-screen').classList.toggle('hidden', p !== 'error');
  $('hud').classList.toggle('hidden', p !== 'playing');
}

/* ------------------------------------------------------------------ */
/* 起動シーケンス                                                       */
/* ------------------------------------------------------------------ */

function log(msg: string) {
  const el = $('loading-log');
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function setProgress(f: number) {
  ($('loading-bar') as HTMLElement).style.width = `${Math.round(f * 100)}%`;
}

async function resolveSource(mountain: Mountain): Promise<ResolvedSource> {
  const mode = ($('opt-source') as HTMLSelectElement).value;

  if (mode === 'custom') {
    const url = ($('opt-url') as HTMLInputElement).value.trim();
    const dec = ($('opt-decoder') as HTMLSelectElement).value;
    const cfg: TileSourceConfig = {
      id: 'custom',
      label: '指定 URL',
      urlTemplate: url,
      decoder: dec === 'auto' ? null : (dec as DecoderId),
      minZoom: 0,
      maxZoom: 16,
      tileSize: 256,
      scheme: url.includes('{-y}') ? 'tms' : 'xyz',
      attribution: 'custom',
    };
    const r = await autoDetectSource(
      { ...mountain.center, expected: mountain.expectedElevation },
      [cfg],
      log,
    );
    return r.source;
  }

  const r = await autoDetectSource(
    { ...mountain.center, expected: mountain.expectedElevation },
    CANDIDATE_SOURCES,
    log,
  );
  return r.source;
}

async function start(mountain: Mountain, route: Route) {
  setPhase('loading');
  $('loading-log').textContent = '';
  setProgress(0.02);
  $('loading-title').textContent = `${mountain.name} — ${route.name}`;

  try {
    disposeSession();

    log('標高タイルのソースを判定しています…');
    const source = await resolveSource(mountain);
    setProgress(0.12);

    const zoom = Number(($('opt-zoom') as HTMLSelectElement).value);
    const frame = new LocalFrame(mountain.center);

    log(`地形を読み込みます (zoom ${Math.min(zoom, source.maxZoom)}, 半径 ${mountain.radiusMeters}m)`);
    const hf = await HeightField.load({
      source,
      frame,
      radiusMeters: mountain.radiusMeters,
      zoom,
      onProgress: (l, t) => {
        setProgress(0.12 + 0.72 * (l / t));
        if (l % 8 === 0 || l === t) log(`タイル ${l}/${t}`);
      },
    });
    log(`標高レンジ ${hf.minElevation.toFixed(0)}m 〜 ${hf.maxElevation.toFixed(0)}m / 解像度 約${hf.resolutionMeters.toFixed(1)}m`);

    if (hf.maxElevation < mountain.expectedElevation.max * 0.6) {
      log('警告: 想定より標高が低いです。ソースの範囲が足りていない可能性があります。');
    }

    setProgress(0.88);
    log('地形メッシュを構築しています…');
    session = buildScene(mountain, route, frame, hf, source);

    setProgress(1);
    setPhase('playing');
    hud.toast(`${route.name} — 剣ヶ峰を目指せ`, 'good');
    hud.toast('クリックで視点操作を開始', 'info');
  } catch (e) {
    console.error(e);
    $('error-detail').textContent = (e as Error).message ?? String(e);
    setPhase('error');
  }
}

function buildScene(
  mountain: Mountain,
  route: Route,
  frame: LocalFrame,
  hf: HeightField,
  source: ResolvedSource,
): Session {
  scene.clear();

  scene.add(createSky(SUN_DIR, 20000));

  const terrainMaterial = createTerrainMaterial({
    snowLine: mountain.snowLine,
    treeLine: mountain.treeLine,
    fogColor: FOG_COLOR,
    fogNear: 900,
    fogFar: 13000,
  });
  terrainMaterial.uniforms.uSunDir.value.copy(SUN_DIR);
  terrainMaterial.uniforms.uContourStrength.value = ($('opt-contour') as HTMLInputElement)
    .checked
    ? 0.35
    : 0;

  const rootSize = mountain.radiusMeters * 2;
  const terrain = new TerrainLOD(hf, {
    rootSize,
    // 葉の一辺が DEM 解像度の数倍になるところで打ち切る。
    // これ以上分割しても元データに無い細部を作るだけで、頂点だけ増える。
    maxDepth: 7,
    gridRes: 32,
    lodBias: 1.8,
    material: terrainMaterial,
    cacheLimit: 500,
  });
  scene.add(terrain.group);

  // 雲海
  let cloudMaterial: THREE.ShaderMaterial | null = null;
  if (($('opt-clouds') as HTMLInputElement).checked) {
    const clouds = createCloudSea(1950, 34000);
    cloudMaterial = clouds.material as THREE.ShaderMaterial;
    scene.add(clouds);
  }

  // ランドマーク
  const markers = createMarkers(route.landmarks, hf, frame);
  scene.add(markers.group);

  // 山頂ビーコン
  const g = frame.toLocal(route.goal.lon, route.goal.lat);
  const goalY = hf.heightAt(g.east, g.north);
  const beacon = createSummitBeacon(g.east, g.north, goalY);
  scene.add(beacon);

  // ハーケンの表示用
  const anchorGroup = new THREE.Group();
  anchorGroup.name = 'anchors';
  scene.add(anchorGroup);

  // プレイヤー
  const climber = new Climber(hf, {
    ...DEFAULT_TUNING,
    boundsRadius: mountain.radiusMeters - 800,
  });
  const s = frame.toLocal(route.start.lon, route.start.lat);
  climber.spawnAt(s.east, s.north, { east: g.east, north: g.north });

  terrain.update(climber.pos, true);

  return {
    mountain,
    route,
    frame,
    hf,
    terrain,
    climber,
    markers,
    goal: { east: g.east, north: g.north, y: goalY },
    visited: new Set(),
    anchorGroup,
    terrainMaterial,
    cloudMaterial,
    beaconMaterial: beacon.material as THREE.ShaderMaterial,
    sourceLabel: `${source.label} / ${source.decoder}`,
  };
}

function disposeSession() {
  if (!session) return;
  session.terrain.dispose();
  session.markers.dispose();
  session.terrainMaterial.dispose();
  scene.clear();
  session = null;
}

/* ------------------------------------------------------------------ */
/* ハーケンの見た目                                                     */
/* ------------------------------------------------------------------ */

const anchorGeo = new THREE.ConeGeometry(1.1, 4.5, 6);
const anchorMat = new THREE.MeshBasicMaterial({ color: 0xffd166 });

function addAnchorMesh(s: Session, pos: THREE.Vector3) {
  const m = new THREE.Mesh(anchorGeo, anchorMat);
  m.position.copy(pos).setY(pos.y + 2.2);
  s.anchorGroup.add(m);
}

/* ------------------------------------------------------------------ */
/* ゲームループ                                                         */
/* ------------------------------------------------------------------ */

const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;
let fps = 0;
let frameCount = 0;

function bearingTo(from: THREE.Vector3, eastT: number, northT: number): number {
  const dx = eastT - from.x;
  const dz = -northT - from.z;
  return Math.atan2(-dx, -dz);
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  frameCount++;

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum > 0.5) {
    fps = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
  }

  if (session && (phase === 'playing' || phase === 'summit')) {
    const s = session;
    const c = s.climber;

    if (phase === 'playing') {
      // 俯瞰カメラの切り替え
      if (input.pressed('KeyC')) {
        freeCam.on = !freeCam.on;
        c.lookEnabled = !freeCam.on;
        if (freeCam.on) {
          freeCam.yaw = c.yaw;
          freeCam.pitch = -0.45;
        }
      }

      const anchorsBefore = c.anchors.length;
      c.update(dt, input);
      if (c.anchors.length > anchorsBefore) {
        addAnchorMesh(s, c.anchors[c.anchors.length - 1]);
      }

      for (const ev of c.takeEvents()) {
        const kind =
          ev.kind === 'slip-start' || ev.kind === 'exhausted'
            ? 'danger'
            : ev.kind === 'anchor-caught' || ev.kind === 'oxygen'
              ? 'good'
              : 'info';
        hud.toast(ev.message, kind);
      }

      // ランドマーク通過
      for (const lm of s.route.landmarks) {
        if (s.visited.has(lm.name)) continue;
        const p = s.frame.toLocal(lm.lon, lm.lat);
        const d = Math.hypot(p.east - c.pos.x, -p.north - c.pos.z);
        if (d < 55) {
          s.visited.add(lm.name);
          hud.toast(`${lm.name} を通過 — ${Math.round(c.pos.y)}m`, 'good');
        }
      }

      // 登頂判定
      const goalDist = Math.hypot(s.goal.east - c.pos.x, -s.goal.north - c.pos.z);
      if (goalDist < s.route.goalRadius && c.pos.y > s.goal.y - 45) {
        showSummit(s);
      }
    }

    // カメラ
    if (freeCam.on) {
      if (input.locked) {
        freeCam.yaw -= input.mouseDX * 0.0025;
        freeCam.pitch = THREE.MathUtils.clamp(
          freeCam.pitch - input.mouseDY * 0.0025,
          -1.4,
          0.5,
        );
      }
      const cp = Math.cos(freeCam.pitch);
      camera.position.set(
        c.pos.x - Math.sin(freeCam.yaw) * cp * freeCam.dist,
        c.pos.y - Math.sin(freeCam.pitch) * freeCam.dist,
        c.pos.z - Math.cos(freeCam.yaw) * cp * freeCam.dist,
      );
      camera.rotation.set(0, 0, 0);
      camera.lookAt(c.pos.x, c.pos.y + 20, c.pos.z);
    } else {
      c.applyToCamera(camera, t);
    }

    // 地形 LOD とシェーダのカメラ依存パラメータ
    s.terrain.update(c.pos);
    s.terrainMaterial.uniforms.uCameraPos.value.copy(camera.position);
    if (s.cloudMaterial) {
      s.cloudMaterial.uniforms.uTime.value = t;
      s.cloudMaterial.uniforms.uCameraPos.value.copy(camera.position);
    }
    s.beaconMaterial.uniforms.uTime.value = t;
    s.markers.update(camera.position);

    if (phase === 'playing') {
      const goalDist = Math.hypot(s.goal.east - c.pos.x, -s.goal.north - c.pos.z);
      hud.update(c, {
        goalElevation: s.route.goal.elevation,
        goalDistance: goalDist,
        summitBearing: bearingTo(c.pos, s.goal.east, s.goal.north),
      });
      hud.setPerf([
        `${fps.toFixed(0)} fps`,
        `葉 ${s.terrain.stats.leaves} / 三角 ${(s.terrain.stats.triangles / 1000).toFixed(0)}k`,
        `DEM ${s.hf.resolutionMeters.toFixed(1)}m · ${s.sourceLabel}`,
        freeCam.on ? '俯瞰カメラ (C で戻る)' : '',
      ]);
    }
  }

  renderer.render(scene, camera);
  input.endFrame();
}

/* ------------------------------------------------------------------ */
/* 登頂・ポーズ                                                         */
/* ------------------------------------------------------------------ */

function statsTable(rows: Array<[string, string]>): string {
  return `<dl class="stats-table">${rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('')}</dl>`;
}

function showSummit(s: Session) {
  const c = s.climber;
  input.exitLock();
  freeCam.on = true;
  freeCam.dist = 700;
  freeCam.pitch = -0.35;
  c.lookEnabled = false;

  $('summit-stats').innerHTML =
    `<p class="tagline">${s.route.goal.name} ${Math.round(c.pos.y)}m — ${s.route.name}</p>` +
    statsTable([
      ['所要時間', formatClock(c.elapsed)],
      ['累積上昇', `${Math.round(c.ascent)} m`],
      ['踏破距離', `${(c.distance / 1000).toFixed(2)} km`],
      ['最高到達点', `${Math.round(c.maxAltitude)} m`],
      ['滑落回数', `${c.falls} 回`],
      ['滑落で失った高度', `${Math.round(c.altitudeLostToFalls)} m`],
      ['残ハーケン', `${c.pitons} / ${DEFAULT_TUNING.pitons}`],
      ['残酸素', `${c.oxygen} / ${DEFAULT_TUNING.oxygen}`],
    ]);
  setPhase('summit');
}

function showPause() {
  if (!session) return;
  const c = session.climber;
  $('pause-stats').innerHTML = statsTable([
    ['現在標高', `${Math.round(c.pos.y)} m`],
    ['経過時間', formatClock(c.elapsed)],
    ['累積上昇', `${Math.round(c.ascent)} m`],
    ['踏破距離', `${(c.distance / 1000).toFixed(2)} km`],
    ['滑落回数', `${c.falls} 回`],
  ]);
  setPhase('paused');
}

/* ------------------------------------------------------------------ */
/* 入力の配線                                                           */
/* ------------------------------------------------------------------ */

canvas.addEventListener('click', () => {
  if (phase === 'playing') input.requestLock();
});

input.setLockListener((locked) => {
  if (!locked && phase === 'playing') showPause();
});

$('btn-resume').addEventListener('click', () => {
  setPhase('playing');
  input.requestLock();
});

$('btn-quit').addEventListener('click', () => {
  disposeSession();
  freeCam.on = false;
  setPhase('title');
});

$('btn-again').addEventListener('click', () => {
  if (!session) return setPhase('title');
  const { mountain, route } = session;
  freeCam.on = false;
  void start(mountain, route);
});

$('btn-error-back').addEventListener('click', () => setPhase('title'));

canvas.addEventListener(
  'wheel',
  (e) => {
    if (!freeCam.on) return;
    e.preventDefault();
    freeCam.dist = THREE.MathUtils.clamp(freeCam.dist * (1 + e.deltaY * 0.001), 40, 6000);
  },
  { passive: false },
);

/* ------------------------------------------------------------------ */
/* デバッグ／自動テスト用フック                                          */
/* ------------------------------------------------------------------ */

export interface DebugHook {
  readonly phase: Phase;
  readonly session: Session | null;
  readonly fps: number;
  /** 描画済みフレーム数。テストが「1 フレーム進んだ」ことを待つのに使う */
  readonly frames: number;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** ワールド座標へ瞬間移動（デバッグ用） */
  teleport(east: number, north: number): void;
  /**
   * 描画結果を粗いグリッドに落として返す（左上が [0][0]、各セルは [r,g,b]）。
   *
   * preserveDrawingBuffer を切っているので readPixels は描画直後にしか
   * 有効な内容を返さない。ここで render → readPixels を同一タスク内で
   * 行うことで、自動テストから実際の描画結果を検証できるようにする。
   */
  snapshotGrid(cols?: number, rows?: number): number[][][];
}

const debugHook: DebugHook = {
  get phase() {
    return phase;
  },
  get session() {
    return session;
  },
  get fps() {
    return fps;
  },
  get frames() {
    return frameCount;
  },
  scene,
  camera,
  teleport(east, north) {
    session?.climber.spawnAt(east, north);
    session?.terrain.update(session.climber.pos, true);
  },
  snapshotGrid(cols = 64, rows = 36) {
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    const out: number[][][] = [];
    for (let r = 0; r < rows; r++) {
      const row: number[][] = [];
      for (let c = 0; c < cols; c++) {
        // readPixels は左下原点なので上下を反転して返す
        const x = Math.floor(((c + 0.5) / cols) * w);
        const y = Math.floor(((rows - r - 0.5) / rows) * h);
        const i = (y * w + x) * 4;
        row.push([px[i], px[i + 1], px[i + 2]]);
      }
      out.push(row);
    }
    return out;
  },
};
(window as unknown as { __fujiclimb: DebugHook }).__fujiclimb = debugHook;

/* ------------------------------------------------------------------ */

buildRouteList(FUJI);
setPhase('title');
tick();
