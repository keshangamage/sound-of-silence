"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createNoise3D } from "simplex-noise";

type Phase = "idle" | "requesting" | "listening" | "error";

type AudioGraph = {
  ctx: AudioContext;
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  stream: MediaStream;
  freq: Uint8Array<ArrayBuffer>;
  wave: Uint8Array<ArrayBuffer>;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  hueShift: number;
};

const TAU = Math.PI * 2;

// Hue runs blue -> purple -> pink -> orange as bass gives way to treble.
const HUE_BASS = 258;
const HUE_SPAN = 122;

const MAX_PARTICLES = 520;
const MAX_BLOB_POINTS = 160;
const RING_POINTS = 200;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const hsla = (hue: number, sat: number, light: number, alpha: number) =>
  `hsla(${hue.toFixed(1)}, ${sat}%, ${light}%, ${alpha.toFixed(4)})`;

/** Average level of the bins between loHz and hiHz. */
function band(
  data: Uint8Array<ArrayBuffer>,
  binHz: number,
  loHz: number,
  hiHz: number,
) {
  const lo = Math.max(0, Math.floor(loHz / binHz));
  const hi = Math.min(data.length - 1, Math.ceil(hiHz / binHz));
  if (hi < lo) return 0;
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += data[i];
  return sum / (hi - lo + 1) / 255;
}

/** Loudness of the waveform. */
function rms(wave: Uint8Array<ArrayBuffer>) {
  let sum = 0;
  for (let i = 0; i < wave.length; i++) {
    const v = (wave[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / wave.length);
}

export default function SoundVisualizer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<AudioGraph | null>(null);
  const rafRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const stopAudio = useCallback(() => {
    const graph = audioRef.current;
    audioRef.current = null;
    if (!graph) return;
    for (const track of graph.stream.getTracks()) track.stop();
    graph.source.disconnect();
    graph.analyser.disconnect();
    if (graph.ctx.state !== "closed") void graph.ctx.close();
  }, []);

  // Browser APIs stay inside effects and handlers, so SSR is safe.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopAudio();
    };
  }, [stopAudio]);

  const handleStart = useCallback(async () => {
    if (audioRef.current || phase === "requesting") return;
    setPhase("requesting");
    setError(null);

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtor) throw new Error("This browser has no Web Audio support.");

      // Unmounted while the prompt was open.
      if (!mountedRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      const audioCtx = new AudioCtor();
      if (audioCtx.state === "suspended") await audioCtx.resume();

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.78;
      analyser.minDecibels = -92;
      analyser.maxDecibels = -18;

      // Not connected to the speakers, so the mic can't loop back.
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const graph: AudioGraph = {
        ctx: audioCtx,
        analyser,
        source,
        stream,
        freq: new Uint8Array(analyser.frequencyBinCount),
        wave: new Uint8Array(analyser.fftSize),
      };

      // Mic unplugged or permission revoked.
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => {
          if (audioRef.current !== graph) return;
          stopAudio();
          if (mountedRef.current) setPhase("idle");
        });
      }

      audioRef.current = graph;
      setPhase("listening");
    } catch (err) {
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (!mountedRef.current) return;
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in your browser, then try again."
          : "Couldn't reach a microphone. Check that one is connected and try again.",
      );
      setPhase("error");
    }
  }, [phase, stopAudio]);

  const handleSnapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `sound-of-silence-${Date.now()}.png`;
      document.body.append(link);
      link.click();
      link.remove();
      // Let the download start before releasing the blob.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Opaque, so trails and snapshots get a solid background.
    const c = canvas.getContext("2d", { alpha: false });
    if (!c) return;

    const noise3D = createNoise3D();
    const particles: Particle[] = [];
    const blobPts = new Float64Array(MAX_BLOB_POINTS * 2);

    let dpr = 1;
    let w = 0;
    let h = 0;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // Resizing clears the canvas, so repaint the background.
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = "source-over";
      c.fillStyle = "#04030a";
      c.fillRect(0, 0, canvas.width, canvas.height);
    };

    resize();
    window.addEventListener("resize", resize);

    /** Closed, smooth path deformed by a noise field. */
    const blobPath = (
      cx: number,
      cy: number,
      radius: number,
      deform: number,
      nFreq: number,
      t: number,
      seed: number,
      points: number,
    ) => {
      for (let i = 0; i < points; i++) {
        const a = (i / points) * TAU;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // Sampled on a circle, so the ends meet with no seam.
        const n =
          noise3D(ca * nFreq + seed, sa * nFreq, t) +
          noise3D(ca * nFreq * 2.3 + seed, sa * nFreq * 2.3, t * 1.5 + 19) *
            0.42;
        const r = radius * (1 + deform * n * 0.72);
        blobPts[i * 2] = cx + ca * r;
        blobPts[i * 2 + 1] = cy + sa * r;
      }

      const lastX = blobPts[(points - 1) * 2];
      const lastY = blobPts[(points - 1) * 2 + 1];
      c.beginPath();
      c.moveTo((lastX + blobPts[0]) / 2, (lastY + blobPts[1]) / 2);
      for (let i = 0; i < points; i++) {
        const x = blobPts[i * 2];
        const y = blobPts[i * 2 + 1];
        const nx = blobPts[((i + 1) % points) * 2];
        const ny = blobPts[((i + 1) % points) * 2 + 1];
        c.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
      }
      c.closePath();
    };

    const layers = [
      { r: 1.34, freq: 0.72, drift: 0.18, sat: 68, light: 30, alpha: 0.16, hueOff: -26, pts: 128, speed: 0.55 },
      { r: 1.0, freq: 1.05, drift: 0.13, sat: 80, light: 44, alpha: 0.26, hueOff: 0, pts: 120, speed: 1.0 },
      { r: 0.7, freq: 1.75, drift: 0.09, sat: 90, light: 58, alpha: 0.24, hueOff: 20, pts: 112, speed: 1.7 },
    ];

    let last = performance.now();
    let time = 0;
    let sBass = 0;
    let sMid = 0;
    let sTreble = 0;
    let sLevel = 0;
    let sTilt = 0.18;
    let liveness = 0;
    let trebleFloor = 0;
    let spawnAcc = 0;

    const frame = (now: number) => {
      rafRef.current = requestAnimationFrame(frame);

      const dt = Math.min(Math.max((now - last) / 1000, 0.001), 0.05);
      last = now;
      /** Move toward a target at the same speed on any frame rate. */
      const ease = (cur: number, target: number, rate: number) =>
        cur + (target - cur) * (1 - Math.exp(-dt * rate));

      let bass = 0;
      let mid = 0;
      let treble = 0;
      let level = 0;

      const graph = audioRef.current;
      if (graph) {
        graph.analyser.getByteFrequencyData(graph.freq);
        graph.analyser.getByteTimeDomainData(graph.wave);
        const binHz =
          graph.ctx.sampleRate / 2 / graph.analyser.frequencyBinCount;
        // Highs are quieter than lows, so each band gets its own gain.
        bass = clamp01(band(graph.freq, binHz, 20, 250) * 1.2);
        mid = clamp01(band(graph.freq, binHz, 250, 2000) * 1.6);
        treble = clamp01(band(graph.freq, binHz, 2000, 12000) * 2.6);
        level = clamp01(rms(graph.wave) * 4.2);
      }

      sBass = ease(sBass, bass, 7);
      sMid = ease(sMid, mid, 9);
      sTreble = ease(sTreble, treble, 14);
      sLevel = ease(sLevel, level, 9);

      // Quick to wake, slow to sleep.
      const liveTarget = clamp01((level - 0.02) / 0.06);
      liveness = ease(liveness, liveTarget, liveTarget > liveness ? 6 : 0.5);

      // In near-silence, breathe slowly instead of freezing.
      const breath = 0.5 + 0.5 * Math.sin(time * 0.5);
      const breathSlow = 0.5 + 0.5 * Math.sin(time * 0.21 + 1.7);
      const eBass = lerp(0.16 + 0.26 * breath, sBass, liveness);
      const eTreble = lerp(0.02 + 0.05 * breathSlow, sTreble, liveness);
      const eLevel = lerp(0.08 + 0.12 * breath, sLevel, liveness);

      const voiced = sBass + sMid * 0.4 + sTreble + 1e-4;
      const tiltLive = clamp01((sTreble + sMid * 0.22) / voiced);
      // Slow ease, so colour drifts instead of snapping.
      sTilt = ease(sTilt, lerp(0.14 + 0.18 * breathSlow, tiltLive, liveness), 1.5);
      const hue = (HUE_BASS + sTilt * HUE_SPAN) % 360;

      time += dt * (0.3 + eBass * 0.55);

      const bright = 0.5 + 0.85 * eLevel;
      const cx = w / 2;
      const cy = h / 2;
      const coreR = Math.min(w, h) * 0.2 * (1 + eBass * 0.5 + eLevel * 0.18);

      // Fade instead of clear, to leave trails.
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = "source-over";
      c.fillStyle = hsla(hue, 60, 3.5, 0.13 + 0.09 * eLevel);
      c.fillRect(0, 0, canvas.width, canvas.height);

      // Volume pulses the whole scene.
      const pulse = 1 + eLevel * 0.11 + eBass * 0.045;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.translate(cx, cy);
      c.scale(pulse, pulse);
      c.translate(-cx, -cy);
      c.globalCompositeOperation = "lighter";

      const wash = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.75);
      wash.addColorStop(0, hsla(hue, 72, 46, 0.085 * bright));
      wash.addColorStop(1, hsla(hue, 72, 46, 0));
      c.fillStyle = wash;
      c.fillRect(0, 0, w, h);

      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const seed = i * 37.4;
        const bx = cx + noise3D(seed, 0, time * 0.22) * coreR * layer.drift;
        const by = cy + noise3D(0, seed, time * 0.22) * coreR * layer.drift;
        const radius = coreR * layer.r;
        const deform = 0.15 + eBass * 0.6 + eTreble * 0.1;

        blobPath(bx, by, radius, deform, layer.freq, time * layer.speed, seed, layer.pts);

        const layerHue = hue + layer.hueOff;
        const grad = c.createRadialGradient(bx, by, radius * 0.05, bx, by, radius * 1.45);
        grad.addColorStop(0, hsla(layerHue, layer.sat, layer.light + 14, layer.alpha * bright));
        grad.addColorStop(0.55, hsla(layerHue, layer.sat, layer.light, layer.alpha * 0.7 * bright));
        grad.addColorStop(1, hsla(layerHue, layer.sat, layer.light - 12, 0));
        c.fillStyle = grad;
        c.fill();
      }

      // Ring traced from the waveform, wobbling so it never sits still.
      const ringR = coreR * 1.62;
      c.beginPath();
      for (let i = 0; i <= RING_POINTS; i++) {
        const idx = i % RING_POINTS;
        const a = (idx / RING_POINTS) * TAU;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const sample = graph
          ? (graph.wave[Math.floor((idx / RING_POINTS) * graph.wave.length)] - 128) / 128
          : 0;
        const wobble = noise3D(ca * 1.6, sa * 1.6, time * 0.8 + 61) * 0.055;
        const r = ringR * (1 + wobble + sample * 0.3 * liveness);
        const x = cx + ca * r;
        const y = cy + sa * r;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.closePath();
      c.lineWidth = 1 + eLevel * 2.2;
      c.strokeStyle = hsla(hue + 28, 92, 74, 0.06 + 0.22 * bright);
      c.stroke();

      // Treble above its rolling floor is a transient, so throw sparks.
      trebleFloor = ease(trebleFloor, sTreble, 0.9);
      const attack = Math.max(0, sTreble - trebleFloor - 0.015);
      spawnAcc += eTreble * eTreble * 260 * dt;
      const steady = Math.floor(spawnAcc);
      spawnAcc -= steady;
      const toSpawn = Math.min(60, Math.floor(attack * 260 * liveness) + steady);

      for (let i = 0; i < toSpawn && particles.length < MAX_PARTICLES; i++) {
        const a = Math.random() * TAU;
        const rr = coreR * (0.72 + Math.random() * 0.75);
        const speed = 55 + Math.random() * (140 + eTreble * 520);
        const maxLife = 0.5 + Math.random() * 1.1;
        particles.push({
          x: cx + Math.cos(a) * rr,
          y: cy + Math.sin(a) * rr,
          vx: Math.cos(a) * speed + (Math.random() - 0.5) * 70,
          vy: Math.sin(a) * speed + (Math.random() - 0.5) * 70,
          life: maxLife,
          maxLife,
          size: 0.8 + Math.random() * 1.9,
          hueShift: (Math.random() - 0.5) * 46,
        });
      }

      const drag = Math.pow(0.965, dt * 60);
      c.lineCap = "round";
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) {
          particles[i] = particles[particles.length - 1];
          particles.pop();
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= drag;
        p.vy *= drag;

        const k = p.life / p.maxLife;
        c.beginPath();
        c.moveTo(p.x, p.y);
        c.lineTo(p.x - p.vx * 0.028, p.y - p.vy * 0.028);
        c.lineWidth = p.size * k;
        c.strokeStyle = hsla(hue + 34 + p.hueShift, 95, 76, k * k * (0.5 + 0.5 * bright));
        c.stroke();
      }

      c.globalCompositeOperation = "source-over";
      c.setTransform(1, 0, 0, 1, 0, 0);
    };

    rafRef.current = requestAnimationFrame(frame);

    return () => {
      window.removeEventListener("resize", resize);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  const listening = phase === "listening";

  return (
    <div className="fixed inset-0 overflow-hidden bg-black font-sans text-white">
      <canvas ref={canvasRef} className="block h-full w-full" aria-hidden="true" />

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center p-6 sm:p-10">
        <p className="text-[11px] font-medium uppercase tracking-[0.38em] text-white/35">
          Sound of Silence
        </p>

        <div className="flex flex-1 items-center">
          <div
            className={`flex flex-col items-center gap-4 transition-all duration-700 ${
              listening ? "translate-y-3 opacity-0" : "translate-y-0 opacity-100"
            }`}
          >
            <button
              type="button"
              onClick={handleStart}
              disabled={listening || phase === "requesting"}
              className="pointer-events-auto rounded-full border border-white/25 bg-white/10 px-8 py-3 text-sm font-medium tracking-wide text-white backdrop-blur-md transition hover:border-white/50 hover:bg-white/15 disabled:pointer-events-none disabled:opacity-40"
            >
              {phase === "requesting"
                ? "Requesting microphone…"
                : phase === "error"
                  ? "Try again"
                  : "Start Listening"}
            </button>
            {error && (
              <p className="max-w-xs text-center text-xs leading-relaxed text-white/45">
                {error}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-5">
          <span
            className={`flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-white/40 transition-opacity duration-700 ${
              listening ? "opacity-100" : "opacity-0"
            }`}
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/70" />
            Listening
          </span>
          <button
            type="button"
            onClick={handleSnapshot}
            className="pointer-events-auto rounded-full border border-white/20 bg-white/5 px-6 py-2.5 text-[13px] font-medium tracking-wide text-white/85 backdrop-blur-md transition hover:border-white/40 hover:bg-white/10 hover:text-white"
          >
            Snapshot
          </button>
        </div>
      </div>
    </div>
  );
}
