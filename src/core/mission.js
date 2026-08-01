import { wrapDelta } from '../world/planet.js';

/* ------------------------------------------------------------------ *
 * おつかい -- the errand run.
 *
 * The world had no goal in it: you walked, and walking was the whole of it.
 * This is a five-to-ten minute loop laid over the top of that without taking
 * anything away -- a memo with six places on it, a clock, and a rank at the
 * end.  Press Q (or the 📋 button) and it starts; press it again and it is
 * gone and you are just walking again.
 *
 * **There is nobody to give you the errand and there never will be.**  The
 * no-people rule is the hardest constraint this project has, and an errand is
 * exactly the kind of feature that breaks it -- a quest giver, a shopkeeper, a
 * mother at a door.  So the framing is a *list*: おつかいメモ, found in a
 * pocket, six stops on it in somebody's handwriting.  The town stays empty and
 * the narrative is still carried by the objects, which is what `README.md`
 * says it is for.
 *
 * Every coordinate in `STOPS` is lifted from the verified camera table in
 * `CLAUDE.md`.  That matters more than it looks: those are positions somebody
 * has actually stood at and rendered from, checked against `world.colliders`,
 * so none of them is inside a shop, a vending machine or a parked van -- which
 * is the failure mode for any spot picked off a plan (see the trap table).
 * Do not add a stop here with a coordinate you have not walked to.
 * ------------------------------------------------------------------ */

/**
 * The places an errand can send you.
 *
 * `zone` is what spreads a route over the map: one stop is taken from each of
 * six different zones, so a run cannot come out as six stops in the shopping
 * street.  It is the only thing keeping the route honest -- picking six at
 * random from a flat list clusters badly about a third of the time, because
 * the town's stops outnumber the outlying ones four to one.
 */
export const STOPS = [
  // --- the middle of town ---
  { id: 'crossing', zone: 'center', x: 1.85, z: 13.6, name: '桜踏切', sub: 'the level crossing' },
  { id: 'ippuku', zone: 'center', x: 12.9, z: 9.6, name: 'さくら坂いっぷく処', sub: 'the vending corner' },
  { id: 'shotengai', zone: 'center', x: 22.2, z: 20.0, name: 'さくら坂商店街', sub: 'the shopping street' },
  { id: 'ichome', zone: 'center', x: -13.2, z: -6.9, name: 'ひばり台一丁目', sub: 'the lineside lane' },

  // --- west: the shrine and the hot-spring shelf above it ---
  { id: 'shrine', zone: 'west', x: -27.9, z: 28.0, name: '桜守神社 社殿', sub: 'the shrine hall' },
  { id: 'matsuri', zone: 'west', x: -30.6, z: 18.4, name: '夏まつり準備中', sub: 'the festival ground' },
  { id: 'onsen', zone: 'west', x: -20.4, z: 48.8, name: '湯の坂', sub: 'the onsen street' },
  { id: 'ryokan', zone: 'west', x: -40.0, z: 48.4, name: '湯乃屋', sub: 'the ryokan court' },

  // --- south: the school and the streets that serve it ---
  { id: 'schoolgate', zone: 'south', x: 12.6, z: -49.5, name: '県立ひばり台高等学校 昇降口', sub: 'the school entrance' },
  { id: 'kobato', zone: 'south', x: 2.4, z: -29.5, name: 'こばと橋', sub: 'the road bridge' },
  { id: 'gochome', zone: 'south', x: -21.8, z: -58.0, name: 'ひばり台五丁目', sub: 'the back lane' },
  { id: 'bungu', zone: 'south', x: 0.4, z: -58.6, name: '文具 ひばり堂', sub: 'the stationery shop' },
  { id: 'kawabata', zone: 'south', x: 21.0, z: -32.2, name: '川端の道', sub: 'the lane by the water' },
  { id: 'canal', zone: 'south', x: -34.0, z: -20.6, name: '用水路 ひばり橋', sub: 'the drainage channel' },

  // --- north: the library and the blocks behind it ---
  { id: 'library', zone: 'north', x: 13.4, z: 44.4, name: 'ひばり台図書館', sub: 'the branch library' },
  { id: 'yonchome', zone: 'north', x: -3.4, z: 53.0, name: 'ひばり台四丁目', sub: "the main road's head" },
  { id: 'uramachi', zone: 'north', x: -10.3, z: 51.6, name: '桜守裏町', sub: 'the oldest lane' },
  { id: 'super', zone: 'north', x: -37.0, z: 92.4, name: 'スーパー さかえ', sub: 'the supermarket' },

  // --- east: the park, the overbridge and the estate beyond ---
  { id: 'park', zone: 'east', x: 33.0, z: 28.0, name: '児童公園', sub: "the children's park" },
  { id: 'overbridge', zone: 'east', x: 41.0, z: 20.5, name: 'ひばり台こ線橋', sub: 'the overbridge' },
  { id: 'nichome', zone: 'east', x: 49.2, z: 12.0, name: 'ひばり台二丁目', sub: 'the planned block' },
  { id: 'rokuchome', zone: 'east', x: 65.4, z: 47.4, name: 'ひばり台六丁目 転回場', sub: 'the bus turnaround' },

  /* --- the outlying two ---
   * These are what make a run take eight minutes rather than four, and they
   * are their own zone for exactly that reason: at most one of them is ever
   * on a memo.  Two would be a hike, not an errand. */
  { id: 'tenbodai', zone: 'far', x: 35.8, z: -128.2, name: 'ひばり山 展望台', sub: 'the hill viewpoint' },
  { id: 'sanbashi', zone: 'far', x: 166.0, z: -80.0, name: 'ひばり湖 見晴らし桟橋', sub: 'the lake pier' },
];

/**
 * How many stops on a memo.
 *
 * Six -- one per zone -- was the first try and it measured too short: median
 * route 404 m, which a player who never breaks into a run finishes in under
 * four minutes.  Eight is 6 + 2 extras drawn from anywhere, so the spread the
 * zones buy is kept and the run is half again as long.
 */
const STOP_COUNT = 8;
/** Close enough to have arrived, in metres. */
const ARRIVE_R = 3.4;
/** The first stop is never allowed to be one you are already standing at. */
const FIRST_MIN = 25;

/**
 * Pace the par time is set against, in **straight-line** metres a second.
 *
 * Not the run speed (5.1) and not the walk (2.55).  Every distance in this
 * file is the straight line between two flat points, and there is no straight
 * line anywhere in this town -- a leg across the map goes round the school
 * wall, over one of four canal crossings and up a flight of steps.  For the
 * two outlying stops it is far worse: the lake pier is 189 m from the crossing
 * in a straight line and the only way there is up the school's outer road,
 * over the east shoulder on the 見晴台の道 and down the far side.
 *
 * 3.0 is that whole effect folded into one number -- a player mixing walking
 * and running, covering straight-line ground at well under their actual pace.
 * It only sets par (and through it the rank), so it is a difficulty dial, not
 * a simulation.
 */
const PAR_SPEED = 3.0;
const PAR_PER_STOP = 12;

const ZONES = ['center', 'west', 'south', 'north', 'east', 'far'];

/** Planar distance between two flat points, the long way round excluded. */
export function flatDist(ax, az, bx, bz) {
  return Math.hypot(wrapDelta(ax, bx), az - bz);
}

/**
 * Build a memo.
 *
 * Six zones, one stop from each, then ordered nearest-neighbour from wherever
 * the player is standing.  The ordering is the difference between a route and
 * a list: unordered, a memo sends you across the whole map and back twice, and
 * the run stops being about moving well and starts being about the draw.
 */
export function makeRoute(fromX, fromZ, rand = Math.random) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  /* One from each zone.  `far` is in the zone list, so every memo has exactly
   * one outlying stop -- which is what sets the length of the run. */
  const chosen = [];
  for (const zone of ZONES) {
    const inZone = STOPS.filter((s) => s.zone === zone);
    if (inZone.length) chosen.push(pick(inZone));
  }

  /* Then fill up to `STOP_COUNT` from anywhere, minus `far`: the extras exist
   * to lengthen the run, and a second outlying stop does not lengthen it, it
   * doubles it -- the hill and the lake are on opposite sides of the range. */
  const rest = STOPS.filter((s) => s.zone !== 'far' && !chosen.includes(s));
  while (chosen.length < STOP_COUNT && rest.length) {
    chosen.push(rest.splice(Math.floor(rand() * rest.length), 1)[0]);
  }

  // trim if the zone list ever outgrows the count
  while (chosen.length > STOP_COUNT) chosen.splice(Math.floor(rand() * chosen.length), 1);

  /* Nearest-neighbour from the player.  The first leg additionally has to be
   * worth walking: without `FIRST_MIN` a memo whose nearest stop is the
   * crossing completes its first line before you have taken a step, which
   * reads as a bug rather than as luck. */
  const route = [];
  let cx = fromX, cz = fromZ;
  const pool = chosen.slice();
  while (pool.length) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < pool.length; i++) {
      let d = flatDist(cx, cz, pool[i].x, pool[i].z);
      if (route.length === 0 && d < FIRST_MIN) d += 1e4;  // push it later, don't drop it
      if (d < bestD) { bestD = d; best = i; }
    }
    const next = pool.splice(best, 1)[0];
    route.push(next);
    cx = next.x; cz = next.z;
  }
  return route;
}

/** Total length of a route walked in order from a starting point. */
export function routeLength(route, fromX, fromZ) {
  let total = 0, cx = fromX, cz = fromZ;
  for (const s of route) {
    total += flatDist(cx, cz, s.x, s.z);
    cx = s.x; cz = s.z;
  }
  return total;
}

/**
 * @param world   for `heightAt`, so the beacon stands on the ground
 * @param player  read for position and yaw; never written to
 * @param hud     `flash`, `setMission`, `showResult`
 * @param beacon  the in-world marker; `{ moveTo(x, z), hide(), update(dt) }`
 */
export function createMissions({ world, player, hud, beacon }) {
  const state = {
    active: false,
    route: [],
    index: 0,
    elapsed: 0,
    par: 0,
    limit: 0,
    /** null while running, then 'done' | 'timeout'. */
    outcome: null,
  };

  function start() {
    const route = makeRoute(player.pos.x, player.pos.z);
    const total = routeLength(route, player.pos.x, player.pos.z);
    const par = total / PAR_SPEED + PAR_PER_STOP * route.length;

    state.active = true;
    state.route = route;
    state.index = 0;
    state.elapsed = 0;
    state.par = par;
    /* The limit is generous on purpose: the clock is there to make moving well
     * *mean* something, not to end the walk.  Failing an errand in a town you
     * came here to look at is the one outcome nobody wants, so the limit is
     * roughly twice par -- which measures out at 11-13 minutes, comfortably
     * past the 5-10 a run actually takes. */
    state.limit = Math.min(900, Math.max(480, par * 1.95));
    state.outcome = null;

    aim();
    hud.flash('おつかいメモ  ·  ' + route.length + ' stops', 2600);
  }

  function stop(silent) {
    state.active = false;
    state.outcome = null;
    beacon.hide();
    hud.setMission(null);
    if (!silent) hud.flash('おつかい やめた', 1400);
  }

  /** Point the beacon and the arrow at the current line of the memo. */
  function aim() {
    const s = state.route[state.index];
    if (!s) return;
    beacon.moveTo(s.x, s.z);
  }

  function arrive() {
    state.index++;
    if (state.index >= state.route.length) {
      finish('done');
      return;
    }
    const left = state.route.length - state.index;
    hud.flash(`✓  ${state.route[state.index - 1].name}  ·  あと ${left}`, 2000);
    aim();
  }

  function finish(outcome) {
    state.outcome = outcome;
    state.active = false;
    beacon.hide();
    hud.setMission(null);
    hud.showResult({
      outcome,
      elapsed: state.elapsed,
      par: state.par,
      limit: state.limit,
      stops: state.route.length,
      rank: outcome === 'done' ? rankFor(state.elapsed, state.par) : null,
    });
  }

  /** S is "moved well", C is "got there". Nothing here is a fail but the clock. */
  function rankFor(t, par) {
    if (t <= par * 1.15) return 'S';
    if (t <= par * 1.45) return 'A';
    if (t <= par * 1.75) return 'B';
    return 'C';
  }

  return {
    get active() { return state.active; },
    state,
    start,
    stop,
    toggle() {
      if (state.active) stop();
      else start();
    },
    /**
     * @param locked  whether the player is actually walking -- the clock must
     *   not run behind the pause card, and the arrival test must not fire
     *   while the world is frozen either.
     */
    update(dt, locked) {
      beacon.update(dt);
      if (!state.active || !locked) return;

      state.elapsed += dt;
      if (state.elapsed >= state.limit) {
        finish('timeout');
        return;
      }

      const s = state.route[state.index];
      if (!s) return;
      const dx = wrapDelta(s.x, player.pos.x);
      const dz = s.z - player.pos.z;
      const dist = Math.hypot(dx, dz);

      if (dist <= ARRIVE_R) {
        arrive();
        return;
      }

      /* Bearing to the target in the player's own frame.
       *
       * `forward` is `(-sin yaw, 0, -cos yaw)`, so the world angle of a
       * direction is `atan2(-dx, -dz)` -- the same expression the `look`
       * helper in `CLAUDE.md` uses, and the same one three of the hill cameras
       * got backwards.  Subtract the yaw and it is relative; the HUD then
       * negates it, because yaw grows to the *left* and a CSS rotation grows
       * to the right.
       */
      let rel = Math.atan2(-dx, -dz) - player.yaw;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;

      hud.setMission({
        index: state.index,
        total: state.route.length,
        name: s.name,
        sub: s.sub,
        dist,
        bearing: rel,
        left: Math.max(0, state.limit - state.elapsed),
        urgent: state.limit - state.elapsed < 60,
      });
    },
  };
}
