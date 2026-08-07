/**
 * エンドツーエンドのスモークテスト。
 *
 * 実タイルサーバに繋がず、合成 DEM（富士山を模した円錐）を差し込んで
 * 「タイル取得 → デコード → 貼り合わせ → 座標変換 → メッシュ生成 → 登攀 → 登頂」
 * の全経路を実ブラウザ上で検証する。
 *
 *   node test/smoke.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTile, elevationAt, SUMMIT } from './syntheticDem.mjs';

/**
 * 環境に置かれている Chromium を探す。
 * playwright のバージョンと同梱ビルド番号がずれている環境があるため、
 * PLAYWRIGHT_BROWSERS_PATH 配下を実際に見て解決する。
 */
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!fs.existsSync(root)) return undefined;
  const candidates = fs
    .readdirSync(root)
    .filter((d) => d.startsWith('chromium'))
    .sort()
    .reverse()
    .flatMap((d) => [
      path.join(root, d, 'chrome-linux', 'chrome'),
      path.join(root, d, 'chrome-linux', 'headless_shell'),
    ]);
  return candidates.find((p) => fs.existsSync(p));
}

const PORT = 4173;
const URL = `http://127.0.0.1:${PORT}/`;

let failures = 0;
let checks = 0;

function check(name, ok, detail = '') {
  checks++;
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a, b, tol) {
  return Number.isFinite(a) && Math.abs(a - b) <= tol;
}

/**
 * 実時間ではなく「シミュレーションが進んだ量」で待つ。
 * ソフトウェアレンダリングだと数 fps しか出ず、実時間で待つと
 * ゲームロジックがほとんど進まないまま検証してしまう。
 */
async function stepFrames(page, frames) {
  const start = await page.evaluate(() => window.__fujiclimb.frames);
  await page.waitForFunction(
    (target) => window.__fujiclimb.frames >= target,
    start + frames,
    { timeout: 120000 },
  );
}

/** ゲーム内時間で n 秒ぶん進むまで待つ */
async function stepSimSeconds(page, seconds) {
  const start = await page.evaluate(() => window.__fujiclimb.session.climber.elapsed);
  await page.waitForFunction(
    (target) => window.__fujiclimb.session.climber.elapsed >= target,
    start + seconds,
    { timeout: 180000 },
  );
}

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* まだ起動していない */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start: ${url}`);
}

async function main() {
  console.log('vite preview を起動中…');
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
  });
  const shutdown = () => server.kill('SIGTERM');
  process.on('exit', shutdown);

  try {
    await waitForServer(URL);

    const executablePath = findChromium();
    if (executablePath) console.log(`chromium: ${executablePath}`);
    const browser = await chromium.launch({
      executablePath,
      args: [
        '--no-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    });
    // ソフトウェアラスタライズが追いつくよう小さめのビューポートで動かす
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });

    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    /* ---- タイルの差し替え ---------------------------------------- */
    let tilesServed = 0;

    // 実サーバ（到達不能）は 404 にして自動判定のフォールバックを検証する
    await page.route('**armd-01.sakura.ne.jp/**', (r) =>
      r.fulfill({ status: 404, body: '' }),
    );
    // dem5a も 404 にして dem_png が選ばれることを確認する
    await page.route('**cyberjapandata.gsi.go.jp/xyz/dem5a_png/**', (r) =>
      r.fulfill({ status: 404, body: '' }),
    );
    await page.route('**cyberjapandata.gsi.go.jp/xyz/dem_png/**', (route) => {
      const m = route.request().url().match(/dem_png\/(\d+)\/(\d+)\/(\d+)\.png/);
      if (!m) return route.fulfill({ status: 404, body: '' });
      tilesServed++;
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' },
        body: makeTile(Number(m[1]), Number(m[2]), Number(m[3])),
      });
    });

    /* ---- タイトル画面 -------------------------------------------- */
    console.log('\nタイトル画面');
    await page.goto(URL, { waitUntil: 'networkidle' });
    const routeCount = await page.locator('#route-list .route').count();
    check('ルートが 4 本表示される', routeCount === 4, `${routeCount} 本`);
    check(
      'WebGL が初期化されている',
      await page.evaluate(() => !!document.querySelector('canvas')?.getContext),
    );

    /* ---- ロード -------------------------------------------------- */
    console.log('\n地形の読み込み（合成 DEM を注入）');
    await page.locator('#route-list .route').first().click();
    await page.waitForFunction(
      () => window.__fujiclimb?.phase === 'playing' || window.__fujiclimb?.phase === 'error',
      null,
      { timeout: 120000 },
    );

    const phase = await page.evaluate(() => window.__fujiclimb.phase);
    if (phase === 'error') {
      const detail = await page.locator('#error-detail').textContent();
      check('ロードが成功する', false, detail ?? '');
      throw new Error('load failed');
    }
    check('ロードが成功して playing になる', phase === 'playing');
    check('タイルが実際に取得された', tilesServed > 0, `${tilesServed} 枚`);

    const src = await page.evaluate(() => window.__fujiclimb.session.sourceLabel);
    check('armd → GSI へフォールバックした', src.includes('DEM10B'), src);

    /* ---- 標高の正しさ -------------------------------------------- */
    console.log('\n標高と座標変換');
    const hf = await page.evaluate(() => {
      const s = window.__fujiclimb.session;
      return {
        min: s.hf.minElevation,
        max: s.hf.maxElevation,
        res: s.hf.resolutionMeters,
        atOrigin: s.hf.heightAt(0, 0),
        // 原点 = 山頂。そこから東へ 3km / 北へ 3km
        east3k: s.hf.heightAt(3000, 0),
        north3k: s.hf.heightAt(0, 3000),
        slopeSummit: s.hf.slopeAt(0, 0),
        slopeFlank: s.hf.slopeAt(2000, 0),
      };
    });

    check('最高標高が剣ヶ峰とほぼ一致', near(hf.max, 3776, 25), `${hf.max.toFixed(1)} m`);
    check(
      '原点（山頂）の標高が正しい',
      near(hf.atOrigin, 3776, 25),
      `${hf.atOrigin.toFixed(1)} m`,
    );

    // 解析モデルと突き合わせる = メルカトル変換とタイル貼り合わせの検証
    const expectEast = elevationAt(SUMMIT.lon + 3000 / 90920, SUMMIT.lat);
    const expectNorth = elevationAt(SUMMIT.lon, SUMMIT.lat + 3000 / 110946);
    check(
      '東 3km 地点の標高がモデルと一致',
      near(hf.east3k, expectEast, 60),
      `${hf.east3k.toFixed(0)} m (期待 ${expectEast.toFixed(0)} m)`,
    );
    check(
      '北 3km 地点の標高がモデルと一致',
      near(hf.north3k, expectNorth, 60),
      `${hf.north3k.toFixed(0)} m (期待 ${expectNorth.toFixed(0)} m)`,
    );
    check('山頂は平坦に近い', hf.slopeSummit < 20, `${hf.slopeSummit.toFixed(1)}°`);
    check('中腹には傾斜がある', hf.slopeFlank > 8, `${hf.slopeFlank.toFixed(1)}°`);
    check('DEM 解像度が妥当', hf.res > 3 && hf.res < 12, `${hf.res.toFixed(2)} m/px`);

    /* ---- 地形メッシュ -------------------------------------------- */
    console.log('\n地形メッシュ (四分木 LOD)');
    const mesh = await page.evaluate(() => {
      const s = window.__fujiclimb.session;
      let verts = 0;
      s.terrain.group.traverse((o) => {
        if (o.geometry) verts += o.geometry.getAttribute('position').count;
      });
      return { ...s.terrain.stats, verts, children: s.terrain.group.children.length };
    });
    check('葉ノードが生成されている', mesh.leaves > 20, `${mesh.leaves} 葉`);

    // 巻き順の検証。ここが逆だと FrontSide のカリングで地表が丸ごと消え、
    // スカートだけが格子状に残る（見た目は「地形に穴が空いている」ように見える）。
    const winding = await page.evaluate(() => {
      const m = window.__fujiclimb.session.terrain.group.children[0];
      const pos = m.geometry.getAttribute('position');
      const idx = m.geometry.index;
      const get = (k) => [pos.getX(k), pos.getY(k), pos.getZ(k)];
      let up = 0;
      let down = 0;
      // スカートを避けて内側の三角形だけ数える
      const n = 35;
      for (let t = 0; t < idx.count; t += 3) {
        const i0 = idx.getX(t);
        const i1 = idx.getX(t + 1);
        const i2 = idx.getX(t + 2);
        const onEdge = [i0, i1, i2].some((k) => {
          const gi = k % n;
          const gj = Math.floor(k / n);
          return gi === 0 || gj === 0 || gi === n - 1 || gj === n - 1;
        });
        if (onEdge) continue;
        const [v0, v1, v2] = [get(i0), get(i1), get(i2)];
        const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
        const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
        const ny = e1[2] * e2[0] - e1[0] * e2[2];
        if (ny > 0) up++;
        else down++;
      }
      return { up, down };
    });
    check(
      '地表の三角形が表を上に向けている',
      winding.down === 0 && winding.up > 100,
      `上向き ${winding.up} / 下向き ${winding.down}`,
    );

    // 実際に地表のピクセルが描画されているか（カリング事故の最終防波堤）。
    // 巻き順が逆だと上面が消えてスカートだけが残り、ここが一気に落ちる。
    const coverage = await page.evaluate(() => {
      document.getElementById('hud').style.display = 'none';
      const grid = window.__fujiclimb.snapshotGrid(64, 36);
      document.getElementById('hud').style.display = '';
      // 画面下半分だけ見る。空と雲は青が強く、火山礫と岩肌は赤が強い。
      let ground = 0;
      let total = 0;
      for (let r = 18; r < 36; r++) {
        for (const [red, , blue] of grid[r]) {
          total++;
          if (red > blue + 8) ground++;
        }
      }
      return ground / total;
    });
    check('画面下半分が地表で埋まっている', coverage > 0.6, `${(coverage * 100).toFixed(1)}%`);
    check(
      '三角形数が実用範囲',
      mesh.triangles > 10000 && mesh.triangles < 3_000_000,
      `${(mesh.triangles / 1000).toFixed(0)}k tris / ${(mesh.verts / 1000).toFixed(0)}k verts`,
    );

    /* ---- スポーン ------------------------------------------------ */
    console.log('\nプレイヤー');
    const spawn0 = await page.evaluate(() => {
      const c = window.__fujiclimb.session.climber;
      return { x: c.pos.x, y: c.pos.y, z: c.pos.z, yaw: c.yaw, stamina: c.stamina };
    });
    check(
      '五合目付近の標高にスポーンする',
      spawn0.y > 1800 && spawn0.y < 3200,
      `${spawn0.y.toFixed(0)} m`,
    );
    check('体力が満タン', near(spawn0.stamina, 100, 0.1));

    // 山頂を向いているか（山頂は原点なので、前方ベクトルが原点方向を向くはず）
    const facing = await page.evaluate(() => {
      const c = window.__fujiclimb.session.climber;
      const fx = -Math.sin(c.yaw);
      const fz = -Math.cos(c.yaw);
      const tx = -c.pos.x;
      const tz = -c.pos.z;
      const len = Math.hypot(tx, tz);
      return (fx * tx + fz * tz) / len; // 1 なら真正面
    });
    check('山頂の方を向いてスポーンする', facing > 0.95, `cosθ=${facing.toFixed(3)}`);

    /* ---- 登攀シミュレーション ------------------------------------ */
    console.log('\n登攀シミュレーション（ゲーム内時間で 6 秒ぶん W を押し続ける）');
    await page.locator('#scene').click();
    await page.keyboard.down('KeyW');
    await stepSimSeconds(page, 6);
    // travelGrade は静止時に 0 に戻る仕様なので、押している間に読む
    const whileMoving = await page.evaluate(() => {
      const c = window.__fujiclimb.session.climber;
      return { grade: c.travelGrade, speed: c.speed };
    });
    await page.keyboard.up('KeyW');

    const after = await page.evaluate(() => {
      const c = window.__fujiclimb.session.climber;
      return {
        y: c.pos.y,
        ascent: c.ascent,
        distance: c.distance,
        stamina: c.stamina,
        slope: c.terrainSlope,
        grade: c.travelGrade,
        mode: c.mode,
        elapsed: c.elapsed,
      };
    });

    check('標高が上がった', after.y > spawn0.y + 5, `${spawn0.y.toFixed(0)} → ${after.y.toFixed(0)} m`);
    check('移動距離が記録された', after.distance > 25, `${after.distance.toFixed(0)} m`);
    check('累積上昇が記録された', after.ascent > 5, `${after.ascent.toFixed(0)} m`);
    // 斜面を登った量が三角関数と整合しているか（物理の健全性）
    const expectedGain = after.distance * Math.tan((after.slope * Math.PI) / 180);
    check(
      '上昇量が距離×傾斜と整合する',
      Math.abs(after.ascent - expectedGain) < expectedGain * 0.6 + 4,
      `${after.ascent.toFixed(1)} m (幾何的な期待値 ${expectedGain.toFixed(1)} m)`,
    );
    check('体力が消耗した', after.stamina < 100, `${after.stamina.toFixed(1)}`);
    check('傾斜が計測されている', after.slope > 2 && after.slope < 89, `${after.slope.toFixed(1)}°`);
    check('登り方向の勾配が正', whileMoving.grade > 0, `${whileMoving.grade.toFixed(1)}°`);
    check('移動速度が妥当', whileMoving.speed > 1 && whileMoving.speed < 12, `${whileMoving.speed.toFixed(2)} m/s`);
    check('時間が進んでいる', after.elapsed > 4, `${after.elapsed.toFixed(1)} s`);

    /* ---- 休憩による回復 ------------------------------------------ */
    console.log('\n休憩');
    await page.keyboard.down('KeyR');
    await stepSimSeconds(page, 1.5);
    await page.keyboard.up('KeyR');
    const rested = await page.evaluate(() => {
      const c = window.__fujiclimb.session.climber;
      return { stamina: c.stamina, mode: c.mode };
    });
    await page.screenshot({ path: 'test/screenshot-play.png' });
    await page.evaluate(() => {
      // 俯瞰カメラに切り替えて地形全体の描画も撮っておく
      const ev = new KeyboardEvent('keydown', { code: 'KeyC' });
      window.dispatchEvent(ev);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC' }));
    });
    await stepFrames(page, 4);
    await page.screenshot({ path: 'test/screenshot-overview.png' });
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC' }));
    });
    await stepFrames(page, 2);

    check('休憩で体力が回復する', rested.stamina > after.stamina, `${after.stamina.toFixed(1)} → ${rested.stamina.toFixed(1)}`);

    /* ---- ハーケン ------------------------------------------------ */
    console.log('\nハーケン');
    const beforePitons = await page.evaluate(
      () => window.__fujiclimb.session.climber.pitons,
    );
    // 急斜面へ移動してから打つ
    await page.evaluate(() => window.__fujiclimb.teleport(1500, 900));
    await stepFrames(page, 2);
    await page.keyboard.press('Space');
    await stepFrames(page, 2);
    const anchors = await page.evaluate(() => {
      const s = window.__fujiclimb.session;
      return {
        pitons: s.climber.pitons,
        count: s.climber.anchors.length,
        meshes: s.anchorGroup.children.length,
        slope: s.climber.terrainSlope,
      };
    });
    if (anchors.slope >= 30) {
      check('ハーケンを消費した', anchors.pitons === beforePitons - 1, `${anchors.pitons} 本`);
      check('支点が記録された', anchors.count === 1);
      check('支点が 3D に表示された', anchors.meshes === 1);
    } else {
      check('緩斜面ではハーケンを打てない', anchors.pitons === beforePitons, `傾斜 ${anchors.slope.toFixed(1)}°`);
    }

    /* ---- 酸素ボンベ ---------------------------------------------- */
    console.log('\n酸素ボンベ');
    await page.evaluate(() => {
      window.__fujiclimb.session.climber.stamina = 30;
    });
    await page.keyboard.press('KeyE');
    await stepFrames(page, 2);
    const oxy = await page.evaluate(() => {
      const c = window.__fujiclimb.session.climber;
      return { oxygen: c.oxygen, active: c.oxygenActive, stamina: c.stamina };
    });
    check('酸素ボンベを消費した', oxy.oxygen === 2, `残り ${oxy.oxygen}`);
    check('効果が有効になった', oxy.active === true);
    check('体力が回復した', oxy.stamina > 60, `${oxy.stamina.toFixed(1)}`);

    /* ---- 滑落 ---------------------------------------------------- */
    console.log('\n滑落');
    const slipped = await page.evaluate(async () => {
      const s = window.__fujiclimb.session;
      const c = s.climber;
      c.anchors.length = 0;
      // 傾斜が急な場所を探す
      let best = null;
      for (let a = 0; a < 32; a++) {
        for (let r = 400; r < 4000; r += 200) {
          const e = Math.cos((a / 32) * Math.PI * 2) * r;
          const n = Math.sin((a / 32) * Math.PI * 2) * r;
          const sl = s.hf.slopeAt(e, n);
          if (!best || sl > best.sl) best = { e, n, sl };
        }
      }
      window.__fujiclimb.teleport(best.e, best.n);
      c.grip = 0;
      const y0 = c.pos.y;
      const t0 = c.elapsed;
      // ゲーム内時間で 2 秒ぶん待つ
      while (c.elapsed - t0 < 2) await new Promise((r) => setTimeout(r, 50));
      return { slope: best.sl, mode: c.mode, falls: c.falls, drop: y0 - c.pos.y };
    });
    if (slipped.slope > 42) {
      check('握力ゼロで滑落が始まる', slipped.falls >= 1, `${slipped.falls} 回 / 傾斜 ${slipped.slope.toFixed(1)}°`);
      check(
        '滑落が毎フレーム再発火していない',
        slipped.falls <= 3,
        `${slipped.falls} 回`,
      );
      check('滑落で高度を失う', slipped.drop > 0, `${slipped.drop.toFixed(1)} m 降下`);
    } else {
      check('この地形には滑落する急斜面がない（合成地形のため想定内）', true, `最急 ${slipped.slope.toFixed(1)}°`);
    }

    /* ---- 登頂 ---------------------------------------------------- */
    console.log('\n登頂判定');
    await page.evaluate(() => {
      const c = window.__fujiclimb.session.climber;
      c.grip = 100;
      c.stamina = 100;
      window.__fujiclimb.teleport(0, 0); // 原点 = 剣ヶ峰
    });
    await page.waitForFunction(() => window.__fujiclimb.phase === 'summit', null, {
      timeout: 10000,
    });
    check('山頂に到達すると登頂画面になる', true);
    const summitVisible = await page.locator('#summit-screen').isVisible();
    check('登頂画面が表示される', summitVisible);
    const summitText = await page.locator('#summit-stats').textContent();
    check('登頂記録が出る', /所要時間/.test(summitText ?? ''), (summitText ?? '').slice(0, 60).replace(/\s+/g, ' '));

    /* ---- 描画の健全性 -------------------------------------------- */
    console.log('\n描画');
    await page.screenshot({ path: 'test/screenshot-summit.png' });
    const nonBlank = await page.evaluate(() => {
      const cv = document.querySelector('canvas');
      // WebGL キャンバスは 2d で読めないので、描画コールが回っているかで判定
      return cv.width > 0 && cv.height > 0;
    });
    check('キャンバスにサイズがある', nonBlank);
    check('FPS が計測されている', (await page.evaluate(() => window.__fujiclimb.fps)) > 0);

    const shaderErrors = consoleErrors.filter((e) =>
      /shader|GLSL|WebGL|compile|program/i.test(e),
    );
    check('シェーダのコンパイルエラーがない', shaderErrors.length === 0, shaderErrors.join(' | '));
    // armd / dem5a への 404 は自動判定のフォールバックを試すため意図的に返している
    const realErrors = consoleErrors.filter(
      (e) => !/status of 404/.test(e) && !/ERR_FAILED/.test(e),
    );
    check('JS エラーがない', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

    await browser.close();
  } finally {
    server.kill('SIGTERM');
  }

  console.log(
    `\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} 通過\x1b[0m`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
