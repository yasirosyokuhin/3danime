import * as THREE from 'three';
import { flat } from '../core/toon.js';
import { basisAt, positionAt } from './planet.js';

/* ------------------------------------------------------------------ *
 * The errand marker -- a column of light standing on the next stop.
 *
 * A runtime module rather than a district, for the same single reason the
 * e-bike is one: it is placed **after** `bakeToPlanet`, which folds every
 * mesh's geometry into root space and clears the container transforms.  A
 * marker that is somewhere else on the next objective cannot be baked at all,
 * so it goes straight onto the scene and is seated the way the bake seats a
 * rigid rig -- `basisAt` for the tangent frame, `positionAt` for the position.
 *
 * Three decisions worth keeping:
 *
 *  - **`fog: false`.**  Scene fog runs 44 to 205 m, so a marker 180 m away --
 *    which the lake pier is -- would be very nearly the fog colour and
 *    therefore not there.  This is the one object in the world whose job is to
 *    be seen from outside the fog, so it opts out of it.  Nothing else should.
 *
 *  - **Depth-tested, not drawn over the world.**  A quest marker that renders
 *    through buildings is the obvious thing to reach for and it looks pasted
 *    on -- a hard-edged bar of colour lying on top of a hand-painted frame.
 *    The column is 9 m so it clears a two-storey roof, and the HUD arrow and
 *    the distance are what actually navigate.  The column only confirms.
 *
 *  - **`depthWrite: false` on every translucent part.**  Same rule as the
 *    petals and the wires: the ink pass is a second difference of the depth
 *    buffer, so a translucent thing that writes depth gets outlined into
 *    speckle.  The pin is the exception and is meant to be -- it is opaque, so
 *    it writes depth and the ink pass contours it like any other solid.
 * ------------------------------------------------------------------ */

/** How tall the column stands. Two-storey roofs here are about 6.5 m. */
const COLUMN_H = 9.0;
/**
 * 0.38 m and 0.30 opacity was the first try and it measured invisible.
 *
 * Raycast from the crossing at 30 m: the column was *there*, unoccluded,
 * projecting to the middle of the frame -- and in the rendered image there was
 * nothing to see.  0.76 m of warm colour at 30 m is about 13 px, and at 0.30
 * over a pale sky that lands within a few per cent of the sky itself.  It is
 * the trap table's "a pale translucent sheet against a pale sky is invisible",
 * which the overbridge canopy already hit once at 0.42.
 *
 * So: wider, denser, and with an **opaque** pin on top -- because past about
 * eighty metres any amount of alpha is still a wash, and what carries at that
 * range is a hard silhouette of a known size.  Same conclusion the crows on
 * the wires reached from the other direction.
 */
const COLUMN_R = 0.62;
const COLUMN_OPACITY = 0.55;
/** The pin, which is what you actually pick out at distance. */
const PIN_R = 0.85;
/** The ring drawn flat on the ground, so the stop reads as a *place*. */
const RING_R = 2.6;

export function createBeacon({ scene, world }) {
  const marker = new THREE.Group();
  marker.name = 'errandBeacon';
  marker.visible = false;
  scene.add(marker);

  /* Everything that animates hangs off this. The outer group carries the
   * placement and is written once per objective; the inner one spins every
   * frame and must never be given a placement of its own. */
  const spin = new THREE.Group();
  marker.add(spin);

  const warm = 0xe8724f;

  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(COLUMN_R * 0.5, COLUMN_R, COLUMN_H, 10, 1, true),
    /* `cache: false` because `update` writes `opacity` every frame, and a
     * cached material is shared -- mutating one is mutating everybody's. */
    flat({ color: warm, transparent: true, opacity: COLUMN_OPACITY, fog: false,
           side: THREE.DoubleSide, depthWrite: false, cache: false })
  );
  column.name = 'beaconColumn';
  column.position.y = COLUMN_H / 2;
  spin.add(column);

  // a brighter core, so the column has a value range rather than one wash
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(COLUMN_R * 0.18, COLUMN_R * 0.34, COLUMN_H, 8, 1, true),
    flat({ color: 0xfff0e2, transparent: true, opacity: 0.75, fog: false,
           side: THREE.DoubleSide, depthWrite: false })
  );
  core.name = 'beaconCore';
  core.position.y = COLUMN_H / 2;
  spin.add(core);

  /* The pin.  Opaque and unfogged, so it is the one part that survives being
   * far away -- and it writes depth, which means the ink pass contours it like
   * everything else in the world rather than leaving it a floating decal. */
  const pin = new THREE.Mesh(
    new THREE.OctahedronGeometry(PIN_R, 0),
    flat({ color: warm, fog: false })
  );
  pin.name = 'beaconPin';
  pin.position.y = COLUMN_H + PIN_R * 0.6;
  pin.scale.set(1, 1.45, 1);
  spin.add(pin);

  /* The ground ring.  `RingGeometry` is authored in the XY plane and faces +z,
   * so it needs the quarter turn to lie down -- and `-PI/2` rather than
   * `+PI/2`, or it faces into the ground and `flat()` is single-sided. */
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(RING_R * 0.82, RING_R, 40),
    flat({ color: warm, transparent: true, opacity: 0.62, fog: false,
           side: THREE.DoubleSide, depthWrite: false })
  );
  ring.name = 'beaconRing';
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  spin.add(ring);

  const inner = new THREE.Mesh(
    new THREE.RingGeometry(0, RING_R * 0.66, 32),
    flat({ color: warm, transparent: true, opacity: 0.13, fog: false,
           side: THREE.DoubleSide, depthWrite: false })
  );
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.05;
  spin.add(inner);

  const _up = new THREE.Vector3();
  const _east = new THREE.Vector3();
  const _north = new THREE.Vector3();
  const _basis = new THREE.Matrix4();
  const _q = new THREE.Quaternion();

  let t = 0;

  return {
    root: marker,

    /** Stand the marker on a flat point. Called once per objective. */
    moveTo(x, z) {
      /* No `fromY`: this is a builder seating something on the ground, which
       * is the case the third argument is deliberately left out of.  See the
       * note on `heightAt` in `world/index.js`. */
      const y = world.heightAt(x, z);
      basisAt(x, z, _up, _east, _north);
      _basis.makeBasis(_east, _up, _north);
      _q.setFromRotationMatrix(_basis);
      marker.quaternion.copy(_q);
      positionAt(x, y, z, marker.position);
      marker.updateMatrixWorld(true);
      marker.visible = true;
    },

    hide() {
      marker.visible = false;
    },

    update(dt) {
      if (!marker.visible) return;
      t += dt;
      spin.rotation.y = t * 0.55;
      // a slow breath rather than a blink -- this thing is in frame for minutes
      const pulse = 1 + Math.sin(t * 1.9) * 0.06;
      ring.scale.set(pulse, pulse, 1);
      column.material.opacity = COLUMN_OPACITY + Math.sin(t * 1.9) * 0.07;
      pin.position.y = COLUMN_H + PIN_R * 0.6 + Math.sin(t * 1.9) * 0.22;
    },
  };
}
