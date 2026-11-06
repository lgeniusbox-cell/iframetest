(() => {
  'use strict';
  if (window.__videoCanvasOverride) return;
  window.__videoCanvasOverride = true;

  const origPlay = HTMLMediaElement.prototype.play;
  const states = new WeakMap();

  /* ------------------------------------------------------------------ */
  /* Worker: receives VideoFrames, draws them on an OffscreenCanvas at   */
  /* their scheduled presentation time (already shifted by audio latency)*/
  /* ------------------------------------------------------------------ */
const workerSrc = `
  let canvas, ctx, queue = [];
  let offset = 0;            // ms added to every timestamp; grows when we fall behind
  const MAX_LAG = 40;        // tolerated lateness before we stretch the timeline

  onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') {
      canvas = m.canvas;
      ctx = canvas.getContext('2d', { alpha: false });
      loop();
    } else if (m.type === 'frame') {
      queue.push({ frame: m.frame, at: m.at - performance.timeOrigin });
      postMessage({ type: 'queue', size: queue.length });
    } else if (m.type === 'flush') {
      queue.forEach(q => q.frame.close());
      queue = [];
      offset = 0;
      postMessage({ type: 'queue', size: 0 });
    }
  };

  function loop() {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(loop);
    else setTimeout(loop, 8);
    tick();
  }

  function tick() {
    if (!queue.length) return;
    const now = performance.now();
    const due = queue[0].at + offset;
    if (due > now) return;                       // not time yet

    const lag = now - due;
    if (lag > MAX_LAG) offset += lag;            // stretch timeline instead of skipping

    const { frame: f } = queue.shift();          // always the NEXT frame, never skip
    const w = f.displayWidth, h = f.displayHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(f, 0, 0, w, h);
    f.close();
    postMessage({ type: 'queue', size: queue.length });
  }

  postMessage({ type: 'ready' });
`;
  /* ------------------------------------------------------------------ */
  /* Worker creation that survives Trusted Types / CSP                   */
  /* ------------------------------------------------------------------ */
  function makeWorker() {
    const url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
    let arg = url;
    if (window.trustedTypes && trustedTypes.createPolicy) {
      try {
        // Page enforces "require-trusted-types-for 'script'": wrap the URL in a policy.
        const policy = trustedTypes.createPolicy(
          'video-canvas-' + Math.random().toString(36).slice(2),
          { createScriptURL: (u) => u }
        );
        arg = policy.createScriptURL(url);
      } catch (e) {
        // Policy creation blocked by a "trusted-types" allowlist: if the page has a
        // 'default' policy it will process the plain string; otherwise Worker() throws
        // or errors and we fall back to main-thread rendering.
        console.warn('[video-canvas] trusted types policy refused:', e.message);
      }
    }
    return new Worker(arg);
  }

  // Same drawing logic, on the main thread (fallback when no worker is allowed)
  function mainThreadRenderer(canvas) {
    const ctx = canvas.getContext('2d');
    let queue = [];
    const timer = setInterval(() => {
      if (!queue.length) return;
      const now = performance.now();
      let pick = -1;
      while (pick + 1 < queue.length && queue[pick + 1].at <= now) pick++;
      if (pick < 0) return;
      for (let i = 0; i < pick; i++) queue[i].frame.close();
      const f = queue[pick].frame;
      const w = f.displayWidth, h = f.displayHeight;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(f, 0, 0, w, h);
      f.close();
      queue.splice(0, pick + 1);
    }, 4);
    return {
      mode: 'main-thread',
      frame(frame, at) {
        queue.push({ frame, at: at - performance.timeOrigin });
        while (queue.length > 12) queue.shift().frame.close();
      },
      flush() { queue.forEach(q => q.frame.close()); queue = []; },
      stop() { clearInterval(timer); },
    };
  }

  async function createRenderer(canvas) {
    let worker;
    try {
      worker = makeWorker();
      // Handshake BEFORE transferring the canvas, so a blocked worker leaves it usable
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('worker did not start (CSP?)')), 1500);
        worker.onmessage = (e) => {
          if (e.data && e.data.type === 'ready') { clearTimeout(t); resolve(); }
        };
        worker.onerror = (ev) => { clearTimeout(t); reject(new Error(ev.message || 'worker error')); };
      });
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
      return {
        mode: 'worker',
        frame: (frame, at) => worker.postMessage({ type: 'frame', frame, at }, [frame]),
        flush: () => worker.postMessage({ type: 'flush' }),
        stop: () => worker.terminate(),
      };
    } catch (e) {
      console.warn('[video-canvas] worker unavailable, rendering on main thread:', e.message);
      worker && worker.terminate();
      return mainThreadRenderer(canvas);
    }
  }

  async function setup(video) {
    const parent = video.parentElement;
    if (!parent) throw new Error('video has no parent');
    if (!video.requestVideoFrameCallback) throw new Error('requestVideoFrameCallback unsupported');

    // Measure + build the canvas BEFORE hiding the video
    const rect = parent.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width =  Math.round(rect.width) || 300;
    canvas.height = Math.round(rect.height) || 150;
    canvas.className = video.className;
    canvas.style.cssText = video.style.cssText;
    if (rect.width && rect.height) {
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
    }
    canvas.style.boxSizing = 'border-box';
    canvas.style.border = '3px solid lime';        // proof that the canvas is what you see
    canvas.style.objectFit = getComputedStyle(video).objectFit || 'contain';
canvas.style.top='100px';

    let actx, renderer;
    try {
      // Audio: route the element through Web Audio (the element itself goes silent)
      actx = new AudioContext({ latencyHint: 'playback' });
      const src = actx.createMediaElementSource(video);
      src.connect(actx.destination);

      const resume = () => actx.state !== 'running' && actx.resume().catch(() => {});
      resume();
      ['pointerdown', 'keydown', 'touchend'].forEach(ev =>
        window.addEventListener(ev, resume, { capture: true, passive: true }));
      video.addEventListener('play', resume);

      // Video: canvas + renderer (worker, or main thread if workers are blocked)
      parent.insertBefore(canvas, video.nextSibling);
      renderer = await createRenderer(canvas);
      console.log('[video-canvas] rendering mode:', renderer.mode);

      // Hide the real video (audio keeps flowing through the AudioContext)
      video.hidden = true;
      video.style.visibility = 'hidden';
video.style.display='none';
      const onFrame = (now, meta) => {
        try {
          const frame = new VideoFrame(video, { timestamp: Math.round(meta.mediaTime * 1e6) });
          const latencyMs = ((actx.baseLatency || 0) + (actx.outputLatency || 0)) * 1000;
          const present = meta.presentationTime || now;
          renderer.frame(frame, performance.timeOrigin + present + latencyMs);
        } catch (e) { /* video not ready / frame unavailable */ }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);

      video.addEventListener('seeking', () => renderer.flush());
      video.addEventListener('emptied', () => renderer.flush());

      states.set(video, { canvas, renderer, actx });
    } catch (err) {
      console.error('[video-canvas] falling back to the native video:', err);
      canvas.remove();
      renderer && renderer.stop();
      video.hidden = false;
      video.style.visibility = '';
      states.set(video, { failed: true });
    }
  }

  HTMLVideoElement.prototype.play = function () {
    if (states.has(this)) return origPlay.call(this);
    states.set(this, { pending: true });
    const p = origPlay.call(this);
    Promise.resolve(p).then(() => setup(this)).catch((e) => {
      states.delete(this);
      console.warn('[video-canvas] play rejected:', e);
    });
    return p;
  };
})();
