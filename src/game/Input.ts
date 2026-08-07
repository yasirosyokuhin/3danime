/** キーボード・マウス入力とポインタロックの管理 */
export class Input {
  private keys = new Set<string>();
  private pressedThisFrame = new Set<string>();
  /** このフレームのマウス移動量（ポインタロック中のみ） */
  mouseDX = 0;
  mouseDY = 0;
  locked = false;

  private el: HTMLElement;
  private onLockChange?: (locked: boolean) => void;

  constructor(el: HTMLElement) {
    this.el = el;

    window.addEventListener('keydown', (e) => {
      // ブラウザのスクロール等を止める
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) {
        e.preventDefault();
      }
      if (!this.keys.has(e.code)) this.pressedThisFrame.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.keys.clear();
      this.onLockChange?.(this.locked);
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  requestLock() {
    if (!this.locked) void this.el.requestPointerLock();
  }

  exitLock() {
    if (this.locked) document.exitPointerLock();
  }

  setLockListener(fn: (locked: boolean) => void) {
    this.onLockChange = fn;
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** そのフレームに押し始めたか（連打防止に使う） */
  pressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  /** フレーム末尾で呼ぶ */
  endFrame() {
    this.pressedThisFrame.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
