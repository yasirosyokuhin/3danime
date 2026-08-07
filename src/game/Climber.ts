import * as THREE from 'three';
import type { HeightField } from '../terrain/HeightField';
import type { Input } from './Input';

export type ClimbMode = 'walk' | 'scramble' | 'climb' | 'slip' | 'rest';

export interface ClimberTuning {
  /** 平地での基準速度[m/s] */
  baseSpeed: number;
  /** 登攀（Shift）時の速度倍率 */
  climbSpeedMul: number;
  /** 登攀時の消耗倍率 */
  climbEffortMul: number;
  /** これを超える傾斜では握力を消費する[度] */
  gripSlope: number;
  /** 握力が尽きたとき滑落し始める傾斜[度] */
  slipSlope: number;
  /** 滑落が止まる傾斜[度] */
  slipStopSlope: number;
  /** 高山病が始まる標高[m] */
  altitudeOnset: number;
  /** 目線の高さ[m] */
  eyeHeight: number;
  /** ハーケンの初期数 */
  pitons: number;
  /** 酸素ボンベの初期数 */
  oxygen: number;
  /** 行動可能な半径[m]（読み込み済み地形の内側に留める） */
  boundsRadius: number;
}

export const DEFAULT_TUNING: ClimberTuning = {
  baseSpeed: 8.0,
  climbSpeedMul: 1.35,
  climbEffortMul: 1.7,
  gripSlope: 45,
  slipSlope: 42,
  slipStopSlope: 33,
  altitudeOnset: 2500,
  eyeHeight: 1.7,
  pitons: 6,
  oxygen: 3,
  boundsRadius: 6200,
};

export interface ClimberEvent {
  kind: 'slip-start' | 'slip-end' | 'anchor-placed' | 'anchor-caught' | 'oxygen' | 'exhausted' | 'no-pitons' | 'no-oxygen';
  message: string;
}

export class Climber {
  readonly pos = new THREE.Vector3();
  yaw = 0;
  pitch = 0;

  stamina = 100;
  grip = 100;
  pitons: number;
  oxygen: number;

  mode: ClimbMode = 'walk';
  /** 足元の傾斜[度] */
  terrainSlope = 0;
  /** いま進んでいる方向の勾配[度]。負なら下り */
  travelGrade = 0;
  speed = 0;

  /** 統計 */
  elapsed = 0;
  distance = 0;
  ascent = 0;
  maxAltitude = -Infinity;
  falls = 0;
  altitudeLostToFalls = 0;

  anchors: THREE.Vector3[] = [];
  /** 酸素ボンベの効果残り時間[s] */
  private oxygenTimer = 0;
  private slipVel = new THREE.Vector3();
  private bobPhase = 0;
  bobOffset = 0;
  /** 高所の風。カメラ揺れと消耗に効く 0..1 */
  wind = 0;

  /** 俯瞰カメラ中はマウスをそちらに渡すので視点操作を止める */
  lookEnabled = true;

  private tuning: ClimberTuning;
  private hf: HeightField;
  private events: ClimberEvent[] = [];
  private lastY = 0;

  constructor(hf: HeightField, tuning: ClimberTuning = DEFAULT_TUNING) {
    this.hf = hf;
    this.tuning = tuning;
    this.pitons = tuning.pitons;
    this.oxygen = tuning.oxygen;
  }

  /** east/north[m] にスポーンし、地表に吸着させる */
  spawnAt(east: number, north: number, faceLon?: { east: number; north: number }) {
    this.pos.set(east, this.hf.heightAt(east, north), -north);
    this.lastY = this.pos.y;
    this.maxAltitude = this.pos.y;
    if (faceLon) {
      // 目標方向を向く。
      // 前方ベクトルは (-sin(yaw), -cos(yaw))、ワールドの北は -Z なので、
      // 目標が (dEast, dNorth) にあるとき yaw = atan2(-dEast, dNorth)。
      const dEast = faceLon.east - east;
      const dNorth = faceLon.north - north;
      this.yaw = Math.atan2(-dEast, dNorth);
    }
  }

  takeEvents(): ClimberEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private emit(kind: ClimberEvent['kind'], message: string) {
    this.events.push({ kind, message });
  }

  /** 標高による消耗補正。1 が平常、小さいほど苦しい */
  get altitudeFactor(): number {
    if (this.oxygenTimer > 0) return 1;
    const t = THREE.MathUtils.clamp(
      (this.pos.y - this.tuning.altitudeOnset) / (3776 - this.tuning.altitudeOnset),
      0,
      1,
    );
    return THREE.MathUtils.lerp(1, 0.42, t);
  }

  get oxygenActive(): boolean {
    return this.oxygenTimer > 0;
  }

  /** 傾斜による速度倍率。緩やかに効かせて急に止まらないようにする */
  private static gradeMultiplier(gradeDeg: number): number {
    if (gradeDeg <= 0) {
      // 下りは少しだけ速いが、急すぎると慎重にならざるを得ない
      const steepDown = Math.max(0, -gradeDeg - 35) / 45;
      return THREE.MathUtils.clamp(1.1 - steepDown * 0.75, 0.25, 1.1);
    }
    return 1 / (1 + (gradeDeg / 28) ** 2);
  }

  update(dt: number, input: Input) {
    this.elapsed += dt;
    const T = this.tuning;
    const east = this.pos.x;
    const north = -this.pos.z;

    // --- 足元の地形 ---
    this.terrainSlope = this.hf.slopeAt(east, north, 5);
    const n = this.hf.normalAt(east, north, 5);

    // 風は標高と斜面の露出度で決まる
    const windTarget = THREE.MathUtils.clamp((this.pos.y - 2400) / 1400, 0, 1);
    this.wind += (windTarget - this.wind) * Math.min(1, dt * 0.6);

    if (this.oxygenTimer > 0) this.oxygenTimer = Math.max(0, this.oxygenTimer - dt);

    // --- 視点 ---
    if (input.locked && this.lookEnabled) {
      const sens = 0.0022;
      this.yaw -= input.mouseDX * sens;
      this.pitch -= input.mouseDY * sens;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
    }

    if (this.mode === 'slip') {
      this.updateSlip(dt, n);
      this.finishFrame(dt);
      return;
    }

    // --- 入力 → 進行方向 ---
    let fwd = 0;
    let strafe = 0;
    if (input.down('KeyW') || input.down('ArrowUp')) fwd += 1;
    if (input.down('KeyS') || input.down('ArrowDown')) fwd -= 1;
    if (input.down('KeyD') || input.down('ArrowRight')) strafe += 1;
    if (input.down('KeyA') || input.down('ArrowLeft')) strafe -= 1;

    const resting = input.down('KeyR') && fwd === 0 && strafe === 0;
    const climbing = input.down('ShiftLeft') || input.down('ShiftRight');

    // ハーケン
    if (input.pressed('Space')) this.placeAnchor();
    // 酸素
    if (input.pressed('KeyE')) this.useOxygen();

    const moving = (fwd !== 0 || strafe !== 0) && this.stamina > 0;

    if (moving) {
      // yaw=0 が -Z（北）を向く
      const sinY = Math.sin(this.yaw);
      const cosY = Math.cos(this.yaw);
      let dx = strafe * cosY - fwd * sinY;
      let dz = -strafe * sinY - fwd * cosY;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;

      // 進行方向の勾配を実地形から測る
      const probe = 3;
      const hHere = this.pos.y;
      const hAhead = this.hf.heightAt(east + dx * probe, north - dz * probe);
      this.travelGrade = (Math.atan2(hAhead - hHere, probe) * 180) / Math.PI;

      let mul = Climber.gradeMultiplier(this.travelGrade);

      // 急斜面を登るには Shift（登攀）が要る
      const needsClimb = this.travelGrade > 38;
      if (needsClimb && !climbing) mul *= 0.28;
      if (climbing) mul *= T.climbSpeedMul;

      // 握力が落ちていると壁で失速する
      if (this.terrainSlope > T.gripSlope) mul *= THREE.MathUtils.lerp(0.25, 1, this.grip / 100);
      // 体力切れ間近も失速
      mul *= THREE.MathUtils.lerp(0.35, 1, THREE.MathUtils.clamp(this.stamina / 30, 0, 1));

      // 垂直に近い壁は登れない
      if (this.travelGrade > 82) mul *= 0.05;

      this.speed = T.baseSpeed * mul * this.altitudeFactor ** 0.4;

      const step = this.speed * dt;
      let nx = east + dx * step;
      let nz = north - dz * step;

      // 読み込み済み範囲の外には出さない
      const r = Math.hypot(nx, nz);
      if (r > T.boundsRadius) {
        nx *= T.boundsRadius / r;
        nz *= T.boundsRadius / r;
      }

      const newH = this.hf.heightAt(nx, nz);
      this.pos.set(nx, newH, -nz);
      this.distance += step;

      // 消耗
      const effort = climbing ? T.climbEffortMul : 1;
      const drain = (0.55 + 0.075 * Math.max(0, this.travelGrade)) * effort;
      this.stamina -= drain * dt;

      this.bobPhase += dt * (2 + this.speed * 0.7);
    } else {
      this.speed = 0;
      this.travelGrade = 0;
      // 回復。休憩姿勢だと速い
      const regen = (resting ? 13 : 6.5) * this.altitudeFactor;
      this.stamina += regen * dt;
      this.bobPhase += dt * 0.8;
    }

    // 3500m 超は静止していても消耗する
    if (this.pos.y > 3500 && !this.oxygenActive) {
      this.stamina -= 0.28 * dt;
    }
    // 強風での消耗
    this.stamina -= this.wind * 0.35 * dt;

    // --- 握力 ---
    if (this.terrainSlope > T.gripSlope) {
      const severity = (this.terrainSlope - T.gripSlope) * 0.22;
      this.grip -= severity * (moving ? 1 : 0.5) * (climbing ? 1.25 : 1) * dt;
    } else {
      this.grip += 12 * dt;
    }

    this.stamina = THREE.MathUtils.clamp(this.stamina, 0, 100);
    this.grip = THREE.MathUtils.clamp(this.grip, 0, 100);

    // --- 滑落判定 ---
    let slipping = false;
    if (this.grip <= 0 && this.terrainSlope > T.slipSlope) {
      slipping = this.beginSlip();
    } else if (this.stamina <= 0 && this.terrainSlope > T.slipSlope + 8) {
      this.emit('exhausted', '体力が尽きた！');
      slipping = this.beginSlip();
    }

    // 滑落に入ったら、この後の表示モード更新で 'slip' を上書きしないよう抜ける
    if (slipping) {
      this.finishFrame(dt);
      return;
    }

    // --- モード表示 ---
    if (resting) this.mode = 'rest';
    else if (this.terrainSlope > 55) this.mode = 'climb';
    else if (this.terrainSlope > 32) this.mode = 'scramble';
    else this.mode = 'walk';

    this.finishFrame(dt);
  }

  /** 滑落状態に入る。すでに滑落中なら false を返す。 */
  private beginSlip(): boolean {
    if (this.mode === 'slip') return false;
    this.mode = 'slip';
    this.falls++;
    this.slipVel.set(0, 0, 0);
    this.emit('slip-start', '滑落！ 斜面が緩むまで止まらない');
    return true;
  }

  private updateSlip(dt: number, normal: [number, number, number]) {
    const T = this.tuning;
    // 最急降下方向は法線の水平成分
    let dx = normal[0];
    let dz = normal[2];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) {
      this.endSlip();
      return;
    }
    dx /= len;
    dz /= len;

    const slopeRad = (this.terrainSlope * Math.PI) / 180;
    const target = 6 + 22 * Math.sin(slopeRad);
    // 慣性を持たせて急に止まらないように
    this.slipVel.x += (dx * target - this.slipVel.x) * Math.min(1, dt * 3);
    this.slipVel.z += (dz * target - this.slipVel.z) * Math.min(1, dt * 3);

    const before = this.pos.y;
    let nx = this.pos.x + this.slipVel.x * dt;
    let nz = -(this.pos.z + this.slipVel.z * dt);

    const r = Math.hypot(nx, nz);
    if (r > T.boundsRadius) {
      nx *= T.boundsRadius / r;
      nz *= T.boundsRadius / r;
    }

    this.pos.set(nx, this.hf.heightAt(nx, nz), -nz);
    this.altitudeLostToFalls += Math.max(0, before - this.pos.y);
    this.stamina = Math.max(0, this.stamina - 8 * dt);

    // ハーケンに引っかかれば止まる
    for (const a of this.anchors) {
      if (a.distanceTo(this.pos) < 10) {
        this.pos.copy(a);
        this.grip = 45;
        this.emit('anchor-caught', 'ハーケンが効いた！ 滑落を止めた');
        this.endSlip();
        return;
      }
    }

    this.terrainSlope = this.hf.slopeAt(this.pos.x, -this.pos.z, 5);
    if (this.terrainSlope < T.slipStopSlope && this.slipVel.length() < 12) {
      this.emit('slip-end', '止まった。体勢を立て直そう');
      this.endSlip();
    }
  }

  private endSlip() {
    this.mode = 'walk';
    this.slipVel.set(0, 0, 0);
    this.grip = Math.max(this.grip, 30);
    this.stamina = Math.max(0, this.stamina - 10);
  }

  private placeAnchor() {
    if (this.pitons <= 0) {
      this.emit('no-pitons', 'ハーケンの残りがない');
      return;
    }
    if (this.terrainSlope < 30) {
      this.emit('no-pitons', 'ここは緩すぎる。急斜面でしか打てない');
      return;
    }
    this.pitons--;
    this.anchors.push(this.pos.clone());
    this.emit('anchor-placed', `ハーケンを打ち込んだ（残り ${this.pitons}）`);
  }

  private useOxygen() {
    if (this.oxygen <= 0) {
      this.emit('no-oxygen', '酸素ボンベの残りがない');
      return;
    }
    this.oxygen--;
    this.oxygenTimer = 60;
    this.stamina = Math.min(100, this.stamina + 45);
    this.emit('oxygen', `酸素ボンベを使用（残り ${this.oxygen}）— 60秒間 高度の影響を無効化`);
  }

  private finishFrame(dt: number) {
    const gain = this.pos.y - this.lastY;
    if (gain > 0) this.ascent += gain;
    this.lastY = this.pos.y;
    if (this.pos.y > this.maxAltitude) this.maxAltitude = this.pos.y;

    // 歩行の上下動。滑落中は激しく揺らす
    const amp = this.mode === 'slip' ? 0.35 : Math.min(0.09, this.speed * 0.012);
    this.bobOffset = Math.sin(this.bobPhase * 2) * amp;
    void dt;
  }

  /** カメラに反映する視点位置と向き */
  applyToCamera(cam: THREE.PerspectiveCamera, time: number) {
    const shake = this.wind * 0.012 + (this.mode === 'slip' ? 0.05 : 0);
    cam.position.set(
      this.pos.x + Math.sin(time * 7.3) * shake,
      this.pos.y + this.tuning.eyeHeight + this.bobOffset,
      this.pos.z + Math.cos(time * 6.1) * shake,
    );
    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw + Math.sin(time * 3.1) * shake * 0.35;
    cam.rotation.x = this.pitch;
    cam.rotation.z = Math.sin(time * 2.2) * shake * 0.5;
  }
}
