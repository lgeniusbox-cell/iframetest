(function () {
  window.captured = {
    api: [],        // RW/WW facade
    q3: [],         // inner player
    loader: [],     // i1/v1 streaming loader
    abr: [],        // uQa
    mediaSource: [],// NL
    mediaElement: [],// e4/y2
  };

  const seen = new WeakSet();

  function classify(obj) {
    if (!obj || typeof obj !== "object" || seen.has(obj)) return;
    try {
      // API facade
      if (typeof obj.getPresentingPlayerType === "function" &&
          typeof obj.getVideoData === "function" &&
          typeof obj.loadVideoByPlayerVars === "function") {
        window.captured.api.push(obj); seen.add(obj); return;
      }
      // q3 inner player
      if (typeof obj.getPlayerType === "function" &&
          obj.videoData && obj.playerState && typeof obj.loader !== "undefined") {
        window.captured.q3.push(obj); seen.add(obj); return;
      }
      // i1 / v1 loader
      if (obj.videoTrack && obj.audioTrack && obj.Jd && obj.qa &&
          typeof obj.seek === "function" && typeof obj.MF === "function") {
        window.captured.loader.push(obj); seen.add(obj); return;
      }
      // uQa ABR
      if (obj.D && Array.isArray(obj.D) && typeof obj.Ly === "function" &&
          typeof obj.Mw === "function") {
        window.captured.abr.push(obj); seen.add(obj); return;
      }
      // NL MediaSource
      if (typeof obj.Au === "function" && typeof obj.clear === "function" &&
          typeof obj.qf === "function") {
        window.captured.mediaSource.push(obj); seen.add(obj); return;
      }
    } catch (e) {}
  }

  const origApply = Function.prototype.apply;
  Function.prototype.apply = function (self, args) {
    try { if (self && typeof self === "object") classify(self); } catch (e) {}
    return origApply.call(this, self, args);
  };
})();
/*
function tuneLoaderForBuffering(targetSeconds = 240) {
  const api = window.captured.api[0];
  const loaders = window.captured.loader || [];
  if (!loaders.length) return console.warn("no loader yet");

  const loader = loaders[0];
  const policy = loader.policy;
  if (!policy) return console.warn("no policy");

  // Bytes (per-stream max buffer size)
  const MB = 1024 * 1024;
  policy.Ka = 256 * MB;   // video: 256 MB buffer
  policy.Jb =  64 * MB;   // audio:  64 MB buffer
  policy.uc =  16 * MB;   // max single request
  policy.Ra =   8 * MB;   // max bitrate (bytes/s)

  // Seconds (buffer health targets)
  policy.ka = Math.max(policy.ka || 120, targetSeconds);   // buffer length seconds
  policy.G_ = 30;          // be patient before downgrading
  policy.wn = 60000;       // slow-start tolerance (60s)
  policy.aB =  8;          // concurrent-ish requests allowed
  policy.ZA =  4;          // parallel chunk requests

  // Reduce ABR flapping
  policy.wq = 2;           // growth rate
  policy.za = 1.05;
  policy.Sa = 1.05;

  // Nudge the loader to apply new values + refill
  try { loader.hd && loader.hd(); } catch (e) {}

  // Force chunk fetching to run even in background tabs
  try { loader.TF && loader.TF.start(0); } catch (e) {}

  console.log("loader tuned:", {
    Ka: policy.Ka, Jb: policy.Jb, ka: policy.ka,
    G_: policy.G_, wn: policy.wn,
  });
}
tuneLoaderForBuffering(300);
function lockQuality(itagLabel) {
  const api = window.captured.api[0];
  // Example labels: "hd1080", "hd720", "large", "medium"
  api.setPlaybackQualityRange(itagLabel, itagLabel);
}
// safest for fast download of a whole video:
lockQuality("hd1080");  // 720p streams are cheap and download fast

// or if you know the video is short (<10min), go higher:
// lockQuality("hd1080");

const loader = window.captured.loader[0];
loader.policy.Sd = 100;   // 100 ms instead of default (often 200-500 ms)
loader.policy.D7 = 500;   // pacing poll minimum health ms
loader.hd();     

(function () {
  // Global buffer for all media
  window.__sbChunks = window.__sbChunks || [];
  // Map from SB -> mime (persist even if prototype is reset)
  const sbMime = new WeakMap();

  function patchSB(sb, mime) {
    try {
      sbMime.set(sb, mime);

      if (sb.appendBuffer && !sb.appendBuffer.__hooked) {
        const orig = sb.appendBuffer;
        sb.appendBuffer = function (buf, ...rest) {
          try {
            const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf)
                     : buf instanceof Uint8Array ? buf
                     : new Uint8Array(buf);
            window.__sbChunks.push({
              mime: sbMime.get(this) || '',
              bytes: u8.slice(),
              t: performance.now(),
            });
          } catch (e) {}
          return orig.call(this, buf, ...rest);
        };
        sb.appendBuffer.__hooked = true;
      }

      if (sb.append && !sb.append.__hooked) {
        const orig = sb.append;
        sb.append = function (buf) {
          try {
            const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf)
                     : buf instanceof Uint8Array ? buf
                     : new Uint8Array(buf);
            window.__sbChunks.push({
              mime: sbMime.get(this) || '',
              bytes: u8.slice(),
              t: performance.now(),
            });
          } catch (e) {}
          return orig.call(this, buf);
        };
        sb.append.__hooked = true;
      }
    } catch (e) {}
  }

  // Hook every new SB that comes out of addSourceBuffer
  function patchMS(MS) {
    if (!MS || !MS.prototype || MS.prototype.addSourceBuffer.__hooked) return;
    const origAdd = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (mime) {
      const sb = origAdd.call(this, mime);
      patchSB(sb, mime);
      // Also patch in case the player resets appendBuffer on this SB later
      setTimeout(() => patchSB(sb, mime), 0);
      setTimeout(() => patchSB(sb, mime), 500);
      setTimeout(() => patchSB(sb, mime), 2000);
      return sb;
    };
    MS.prototype.addSourceBuffer.__hooked = true;
  }
  patchMS(HTMLMediaElement.prototype.constructor && window.MediaSource);
  patchMS(window.MediaSource);
  patchMS(window.ManagedMediaSource);
  patchMS(window.WebKitMediaSource);

  // Also patch the raw prototype so any SB (even pre-existing) is caught
  if (window.SourceBuffer) {
    const origProto = SourceBuffer.prototype.appendBuffer;
    if (!origProto.__hooked) {
      SourceBuffer.prototype.appendBuffer = function (buf, ...rest) {
        try {
          const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf)
                   : buf instanceof Uint8Array ? buf
                   : new Uint8Array(buf);
          window.__sbChunks.push({
            mime: sbMime.get(this) || '',
            bytes: u8.slice(),
            t: performance.now(),
          });
        } catch (e) {}
        return origProto.call(this, buf, ...rest);
      };
      SourceBuffer.prototype.appendBuffer.__hooked = true;
    }
  }

  // In case SBs were created before our script
  if (window.MediaSource) {
    // nothing to enumerate directly, but the prototype patch covers them
  }
})();

function saveAllTracks() {
  const groups = {};
  for (const c of window.__sbChunks) {
    if (!c.mime) continue;
    (groups[c.mime] = groups[c.mime] || []).push(c.bytes);
  }

  // Sanity: log what we have
  console.table(Object.fromEntries(
    Object.entries(groups).map(([m, arr]) => [m, arr.reduce((a,b)=>a+b.length,0)])
  ));

  // Identify audio + video
  const audioMimes = Object.keys(groups).filter(m => /audio/i.test(m));
  const videoMimes = Object.keys(groups).filter(m => /video/i.test(m));

  function save(mimes, prefix) {
    // If multiple audio/video tracks, join them all into one file
    // (concat works because fragments are self-describing)
    const allBytes = [];
    for (const m of mimes) allBytes.push(...groups[m]);
    const total = allBytes.reduce((a,b)=>a+b.length,0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of allBytes) { out.set(b, off); off += b.length; }

    const isAudio = prefix === 'audio';
    const ext = isAudio ? 'm4a' : 'mp4';
    const blob = new Blob([out], { type: mimes[0] || (isAudio?'audio/mp4':'video/mp4') });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = prefix + '.' + ext;
    a.click();
  }

  if (videoMimes.length) save(videoMimes, 'video');
  if (audioMimes.length) save(audioMimes, 'audio');

  if (!audioMimes.length) {
    console.warn("No audio SB captured. Chunks present for:", Object.keys(groups));
    console.warn("If the player uses SABR, audio may be multiplexed with video in the same SB.");
  }
}
saveAllTracks();
*/
