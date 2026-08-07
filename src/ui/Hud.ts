import type { Climber, ClimbMode } from '../game/Climber';

const MODE_LABEL: Record<ClimbMode, string> = {
  walk: '歩行',
  scramble: 'よじ登り',
  climb: '登攀',
  slip: '滑落中',
  rest: '休憩',
};

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

export function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export class Hud {
  private altitude = $('altitude');
  private altRemaining = $('alt-remaining');
  private distRemaining = $('dist-remaining');
  private clock = $('clock');
  private ascent = $('ascent');
  private barStamina = $('bar-stamina');
  private barGrip = $('bar-grip');
  private modeBadge = $('mode-badge');
  private slope = $('slope');
  private pitons = $('pitons');
  private oxygen = $('oxygen');
  private wind = $('wind');
  private altWarn = $('alt-warn');
  private compassStrip = $('compass-strip');
  private summitMarker = $('summit-marker');
  private toasts = $('toasts');
  private perf = $('perf');

  private lastCompassYaw = NaN;

  constructor() {
    this.buildCompass();
  }

  private buildCompass() {
    // -180..180 度を 10 度刻みで刻む。表示は yaw に応じてずらす
    const frag = document.createDocumentFragment();
    for (let deg = -180; deg <= 540; deg += 15) {
      const d = ((deg % 360) + 360) % 360;
      const span = document.createElement('span');
      span.className = 'tick';
      const card: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
      if (card[d]) {
        span.textContent = card[d];
        span.classList.add('card');
      } else if (d % 45 === 0) {
        span.textContent = String(d);
      } else {
        span.textContent = '·';
      }
      span.dataset.deg = String(deg);
      frag.appendChild(span);
    }
    this.compassStrip.appendChild(frag);
  }

  private updateCompass(yawDeg: number, summitBearing: number) {
    if (Math.abs(yawDeg - this.lastCompassYaw) < 0.4) return;
    this.lastCompassYaw = yawDeg;
    const pxPerDeg = 260 / 120; // 視野 120 度分をバーに収める
    for (const el of Array.from(this.compassStrip.children) as HTMLElement[]) {
      const deg = Number(el.dataset.deg);
      let rel = deg - yawDeg;
      rel = ((rel + 180) % 360 + 360) % 360 - 180;
      const x = 130 + rel * pxPerDeg;
      el.style.left = `${x}px`;
      el.style.display = x < -20 || x > 280 ? 'none' : '';
    }
    let relS = summitBearing - yawDeg;
    relS = ((relS + 180) % 360 + 360) % 360 - 180;
    const sx = 130 + relS * pxPerDeg;
    this.summitMarker.style.left = `${Math.max(6, Math.min(254, sx))}px`;
    this.summitMarker.style.opacity = Math.abs(relS) > 62 ? '0.35' : '1';
  }

  update(
    c: Climber,
    info: { goalElevation: number; goalDistance: number; summitBearing: number },
  ) {
    this.altitude.textContent = String(Math.round(c.pos.y));
    const remain = Math.max(0, info.goalElevation - c.pos.y);
    this.altRemaining.textContent = String(Math.round(remain));
    this.distRemaining.textContent =
      info.goalDistance > 1000
        ? `${(info.goalDistance / 1000).toFixed(2)} km`
        : `${Math.round(info.goalDistance)} m`;

    this.clock.textContent = formatClock(c.elapsed);
    this.ascent.textContent = String(Math.round(c.ascent));

    this.barStamina.style.width = `${c.stamina}%`;
    this.barStamina.style.background =
      c.stamina < 20 ? 'var(--danger)' : c.stamina < 45 ? 'var(--warn)' : 'var(--ok)';
    this.barGrip.style.width = `${c.grip}%`;
    this.barGrip.style.background =
      c.grip < 20 ? 'var(--danger)' : c.grip < 45 ? 'var(--warn)' : 'var(--accent)';

    this.modeBadge.textContent = MODE_LABEL[c.mode];
    this.modeBadge.className = `badge ${c.mode}`;

    this.slope.textContent = `${Math.round(c.terrainSlope)}°`;
    this.pitons.textContent = String(c.pitons);
    this.oxygen.textContent = c.oxygenActive ? `${c.oxygen} (使用中)` : String(c.oxygen);
    this.wind.textContent =
      c.wind < 0.15 ? '穏やか' : c.wind < 0.45 ? 'やや強い' : c.wind < 0.75 ? '強風' : '暴風';

    this.altWarn.classList.toggle('on', c.altitudeFactor < 0.85 && !c.oxygenActive);

    this.updateCompass(
      ((-c.yaw * 180) / Math.PI + 360 * 3) % 360,
      ((info.summitBearing * 180) / Math.PI + 360 * 3) % 360,
    );
  }

  setPerf(lines: string[]) {
    this.perf.textContent = lines.join('\n');
  }

  toast(message: string, kind: 'info' | 'danger' | 'good' = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind === 'info' ? '' : kind}`;
    el.textContent = message;
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
}
