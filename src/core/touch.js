/* ------------------------------------------------------------------ *
 * On-screen controls for touch devices: no keyboard, no mouse, so every
 * key this world listens for needs a touch equivalent --
 *
 *   WASD    -> a floating joystick, left half of the screen
 *   mouse   -> drag-to-look, right half of the screen
 *   E       -> the interact button
 *   V       -> the e-bike button
 *   P       -> the planet button
 *   M       -> the music button
 *   Esc     -> the pause button (pointer lock has no touch equivalent)
 *
 * Both the joystick and the look layer use Pointer Events rather than touch
 * events, so one finger can drive the stick while another looks around --
 * each pointer is tracked by its own id and the two zones never fight over
 * the same one.
 * ------------------------------------------------------------------ */

export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  return Boolean(coarse || navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
}

const JOY_RADIUS = 46;
const LOOK_SENSITIVITY = 2.6;

export function createTouchControls({ player, onInteract, onEbike, onMusic, onPlanet, onPause }) {
  const el = (tag, cls, parent) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    (parent || document.body).appendChild(n);
    return n;
  };

  const root = el('div', 'touch-ui hidden');

  /* ---------- movement: a joystick that appears wherever the thumb lands ---------- */
  const joyZone = el('div', 'tjoy-zone', root);
  const joyBase = el('div', 'tjoy-base', root);
  const joyStick = el('div', 'tjoy-stick', joyBase);
  let joyId = null;
  const joyCenter = { x: 0, y: 0 };

  joyZone.addEventListener('pointerdown', (e) => {
    if (joyId !== null) return;
    joyId = e.pointerId;
    joyZone.setPointerCapture(joyId);
    joyCenter.x = e.clientX;
    joyCenter.y = e.clientY;
    joyBase.style.left = e.clientX + 'px';
    joyBase.style.top = e.clientY + 'px';
    joyBase.classList.add('on');
    joyStick.style.transform = 'translate(-50%, -50%)';
  });
  joyZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joyId) return;
    const dx = e.clientX - joyCenter.x;
    const dy = e.clientY - joyCenter.y;
    const d = Math.hypot(dx, dy);
    const k = d > JOY_RADIUS ? JOY_RADIUS / d : 1;
    const sx = dx * k, sy = dy * k;
    joyStick.style.transform = `translate(calc(-50% + ${sx}px), calc(-50% + ${sy}px))`;
    // screen y grows downward; "up" on the stick has to mean "forward"
    player.setMoveVector(sx / JOY_RADIUS, -sy / JOY_RADIUS);
  });
  const endJoy = (e) => {
    if (e.pointerId !== joyId) return;
    joyId = null;
    joyBase.classList.remove('on');
    player.setMoveVector(0, 0);
  };
  joyZone.addEventListener('pointerup', endJoy);
  joyZone.addEventListener('pointercancel', endJoy);

  /* ---------- look: drag anywhere on the right side of the screen ---------- */
  const lookZone = el('div', 'tlook-zone', root);
  let lookId = null;
  const lookLast = { x: 0, y: 0 };

  lookZone.addEventListener('pointerdown', (e) => {
    if (lookId !== null) return;
    lookId = e.pointerId;
    lookZone.setPointerCapture(lookId);
    lookLast.x = e.clientX;
    lookLast.y = e.clientY;
  });
  lookZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    const dx = e.clientX - lookLast.x;
    const dy = e.clientY - lookLast.y;
    lookLast.x = e.clientX;
    lookLast.y = e.clientY;
    player.look(dx * LOOK_SENSITIVITY, dy * LOOK_SENSITIVITY);
  });
  const endLook = (e) => {
    if (e.pointerId === lookId) lookId = null;
  };
  lookZone.addEventListener('pointerup', endLook);
  lookZone.addEventListener('pointercancel', endLook);

  /* ---------- buttons ---------- */
  const btn = (cls, label, handler) => {
    const b = el('button', 'tbtn ' + cls, root);
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handler?.();
    });
    return b;
  };

  btn('tbtn-interact', 'E', onInteract);
  btn('tbtn-ebike', '\u{1F6B2}', onEbike);   // bicycle
  btn('tbtn-planet', '\u{1F30F}', onPlanet); // globe
  btn('tbtn-music', '♪', onMusic);      // eighth note
  btn('tbtn-pause', '⏸', onPause);      // pause

  return {
    root,
    /** Shown only while the player is actually walking round -- hidden
     * behind the title/pause overlay so its full-screen zones can't steal
     * the tap meant for the "start" button underneath them. */
    setActive(active) {
      root.classList.toggle('hidden', !active);
      if (!active) {
        joyId = null;
        lookId = null;
        joyBase.classList.remove('on');
        player.setMoveVector(0, 0);
      }
    },
  };
}
