// Imperative custom scrollbar for canvas editors (we own scrolling, so the
// thumb is positioned from the controller's view state each time it moves —
// no React re-render). Thumb drag + track paging, pointer-captured.

export class ScrollbarCtl {
  private pos = 0;
  private view = 1;
  private content = 1;
  private drag: { start: number; startPos: number } | null = null;
  private offs: Array<() => void> = [];

  constructor(
    private track: HTMLElement,
    private thumb: HTMLElement,
    private axis: 'x' | 'y',
    private onScroll: (pos: number) => void,
  ) {
    const coord = (e: PointerEvent) => (axis === 'x' ? e.clientX : e.clientY);
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.target === thumb) {
        thumb.setPointerCapture(e.pointerId);
        this.drag = { start: coord(e), startPos: this.pos };
        thumb.dataset.active = '1';
      } else {
        const r = thumb.getBoundingClientRect();
        const before = axis === 'x' ? coord(e) < r.left : coord(e) < r.top;
        this.onScroll(this.pos + (before ? -1 : 1) * this.view * 0.9);
      }
    };
    const move = (e: PointerEvent) => {
      if (!this.drag) return;
      const len = this.trackLen();
      const thumbLen = this.thumbLen(len);
      const usable = Math.max(1, len - thumbLen);
      const range = Math.max(0, this.content - this.view);
      this.onScroll(this.drag.startPos + ((coord(e) - this.drag.start) / usable) * range);
    };
    const up = () => {
      this.drag = null;
      delete thumb.dataset.active;
    };
    track.addEventListener('pointerdown', down);
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', up);
    thumb.addEventListener('pointercancel', up);
    this.offs.push(
      () => track.removeEventListener('pointerdown', down),
      () => thumb.removeEventListener('pointermove', move),
      () => thumb.removeEventListener('pointerup', up),
      () => thumb.removeEventListener('pointercancel', up),
    );
  }

  private trackLen(): number {
    return this.axis === 'x' ? this.track.clientWidth : this.track.clientHeight;
  }

  private thumbLen(len: number): number {
    return Math.max(24, Math.min(len, (this.view / Math.max(this.content, 1)) * len));
  }

  /** Reflect the current scroll position / viewport / content length (any unit). */
  update(pos: number, view: number, content: number): void {
    this.pos = pos;
    this.view = view;
    this.content = Math.max(content, view);
    const len = this.trackLen();
    const tl = this.thumbLen(len);
    const range = Math.max(1e-9, this.content - this.view);
    const off = (Math.min(1, Math.max(0, pos / range)) || 0) * (len - tl);
    const s = this.thumb.style;
    if (this.axis === 'x') {
      s.width = `${tl}px`;
      s.transform = `translate3d(${off}px,0,0)`;
    } else {
      s.height = `${tl}px`;
      s.transform = `translate3d(0,${off}px,0)`;
    }
    this.thumb.style.opacity = this.content > this.view + 1e-6 ? '1' : '0.35';
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.offs = [];
  }
}
