// ──────────────────────────────────────────────────────────────────────
// Home background: a dark, slowly flowing texture (domain-warped noise in
// a tiny WebGL fragment shader) in the Krypt palette. Mostly void, with
// faint indigo haze and thin purple → pink veins: the gradient stays an
// accent (kryptguidelines §2.2, 80/20).
//
// Cost caps: drawn at ~40 % of CSS resolution and upscaled, at most 30 fps,
// only while Home is up, the window is visible AND focused. Reduced motion
// draws one still frame. Lite mode / no WebGL → a static CSS gradient.
// Ticks ride the shared frame loop (src/render/frameLoop.ts).
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { onFrame } from '../render/frameLoop';

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;

const FRAG = `precision mediump float;
uniform vec2 uRes;
uniform float uTime;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<4;i++){v+=a*noise(p);p=m*p;a*=.5;}return v;}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes.y;
  float t=uTime*.022;
  vec2 q=vec2(fbm(uv*1.7+vec2(0.,t)),fbm(uv*1.7+vec2(5.2,-t)));
  vec2 r=vec2(fbm(uv*1.7+2.8*q+vec2(1.7,9.2)+t*.6),fbm(uv*1.7+2.8*q+vec2(8.3,2.8)-t*.45));
  float f=fbm(uv*1.7+3.*r);
  float vein=pow(1.-abs(f*2.-1.),10.);
  vec3 col=mix(vec3(.039,.039,.059),vec3(.075,.065,.14),smoothstep(.25,.95,f));
  col+=vec3(.39,.40,.95)*.045*length(q);
  col+=mix(vec3(.66,.33,.97),vec3(.93,.28,.60),clamp(r.x,0.,1.))*vein*.16;
  vec2 c=gl_FragCoord.xy/uRes-.5;
  col*=1.-dot(c,c)*1.1;
  col+=(hash(gl_FragCoord.xy+fract(uTime))-.5)/255.;
  gl_FragColor=vec4(col,1.);
}`;

/** Fraction of CSS pixels rendered (the texture is soft; upscaling hides it). */
const RENDER_SCALE = 0.4;
const FRAME_SEC = 1 / 30;

interface Gl {
  gl: WebGLRenderingContext;
  uRes: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
}

function initGl(canvas: HTMLCanvasElement): Gl | null {
  const gl = canvas.getContext('webgl', { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) return null;
  const sh = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = sh(gl.VERTEX_SHADER, VERT);
  const fs = sh(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  return { gl, uRes: gl.getUniformLocation(prog, 'uRes'), uTime: gl.getUniformLocation(prog, 'uTime') };
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = (): void => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Static fallback (Lite mode, no WebGL): layered gradients, no animation. */
function StillGradient() {
  return (
    <div
      className="absolute inset-0"
      style={{
        background:
          'radial-gradient(900px circle at 18% 0%, rgba(168,85,247,0.14), transparent 60%), radial-gradient(800px circle at 90% 100%, rgba(99,102,241,0.10), transparent 60%), radial-gradient(600px circle at 70% 30%, rgba(236,72,153,0.05), transparent 65%), #0A0A0F',
      }}
    />
  );
}

export function HomeBackground({ lite }: { lite: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (lite || failed) return;
    const host = hostRef.current;
    if (!host) return;
    // A fresh canvas per run: a context released with loseContext() can't be reused.
    const canvas = document.createElement('canvas');
    canvas.className = 'absolute inset-0 h-full w-full';
    host.appendChild(canvas);
    const g = initGl(canvas);
    if (!g) {
      canvas.remove();
      setFailed(true);
      return;
    }
    const { gl } = g;
    const start = performance.now() - 40_000 * Math.random(); // a different frame each open
    let width = 0;
    let height = 0;
    const resize = (): void => {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * RENDER_SCALE));
      const h = Math.max(1, Math.round(r.height * RENDER_SCALE));
      if (w === width && h === height) return;
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    };
    const draw = (now: number): void => {
      resize();
      gl.uniform2f(g.uRes, width, height);
      gl.uniform1f(g.uTime, (now - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    let off: (() => void) | null = null;
    let acc = FRAME_SEC;
    const stop = (): void => {
      off?.();
      off = null;
    };
    let focused = document.hasFocus();
    const run = (): void => {
      // Pause while hidden, minimised or unfocused; reduced motion = one still frame.
      const active = !reduced && focused && document.visibilityState === 'visible';
      if (!active) {
        stop();
        if (!reduced || width === 0) draw(performance.now());
        return;
      }
      if (off) return;
      acc = FRAME_SEC;
      off = onFrame((dt, now) => {
        acc += dt;
        if (acc < FRAME_SEC) return;
        acc = 0;
        draw(now);
      });
    };
    const ro = new ResizeObserver(() => {
      if (!off) draw(performance.now());
    });
    ro.observe(canvas);
    const lost = (e: Event): void => {
      e.preventDefault();
      stop();
      setFailed(true);
    };
    canvas.addEventListener('webglcontextlost', lost);
    const onFocus = (): void => {
      focused = true;
      run();
    };
    const onBlur = (): void => {
      focused = false;
      run();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', run);
    draw(performance.now());
    run();
    return () => {
      stop();
      ro.disconnect();
      canvas.removeEventListener('webglcontextlost', lost);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', run);
      gl.getExtension('WEBGL_lose_context')?.loseContext(); // free the context now, not at GC
      canvas.remove();
    };
  }, [lite, failed, reduced]);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {lite || failed ? <StillGradient /> : <div ref={hostRef} className="absolute inset-0" />}
      {/* soft vignette so cards always sit on near-black */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(10,10,15,0.55)_100%)]" />
    </div>
  );
}
