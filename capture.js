/* =========================================================
   DocFill · Página pública de captura
   Pasos: foto (fondo blanco) → firma (tinta negra) → huella (tinta negra)
   ========================================================= */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const QS = new URLSearchParams(location.search);
let LOCAL_REQ = null;
try {
  const raw = new URLSearchParams(location.hash.slice(1)).get('r');
  if (raw) LOCAL_REQ = JSON.parse(b64uDecode(raw));
} catch (e) { LOCAL_REQ = null; }

const TOKEN = (LOCAL_REQ && LOCAL_REQ.t) || QS.get('t') || '';
const API = '';

function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

const S = {
  session: null,
  step: 0,
  steps: ['photo', 'signature', 'fingerprint'],
  data: { photo: null, signature: null, fingerprint: null }, // canvas listos
  photo: { src: null, mask: null, w: 0, h: 0, tol: 28, feather: 2, auto: true, brush: false },
  sign: { mode: 'draw', raw: null },
  finger: { raw: null, con: 50, clean: 30 },
  sending: false,
};

const LABEL = { photo: 'Foto', signature: 'Firma', fingerprint: 'Huella' };

/* ---------------------------------------------------------- utilidades */
function show(id) {
  ['viewLoad','viewError','viewMenu','viewPhoto','viewSign','viewFinger','viewReview','viewDone']
    .forEach((v) => $('#' + v).classList.add('hidden'));
  if (id) $('#' + id).classList.remove('hidden');
}

function setFoot(html) { $('#foot').innerHTML = html; }

function toast(msg, isErr) {
  let t = $('#miniToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'miniToast';
    t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:96px;' +
      'background:#1f2937;border:1px solid #374151;color:#fff;padding:10px 16px;' +
      'border-radius:10px;font-size:13px;z-index:99;transition:.25s;opacity:0;pointer-events:none;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.borderColor = isErr ? '#7f2b2f' : '#374151';
  t.style.background = isErr ? '#3a1a1c' : '#1f2937';
  t.style.opacity = '1';
  clearTimeout(t._tm);
  t._tm = setTimeout(() => (t.style.opacity = '0'), 2400);
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

function fileToDataURL(file) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
}

function fitCanvas(img, maxSide) {
  const r = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * r));
  c.height = Math.max(1, Math.round(img.naturalHeight * r));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/* ---------------------------------------------------------- progreso */
function renderProgress() {
  const box = $('#progress');
  box.innerHTML = '';
  S.steps.forEach((k, i) => {
    const d = document.createElement('div');
    d.className = 'pstep' + (i < S.step ? ' done' : i === S.step ? ' active' : '');
    d.innerHTML = '<div class="pbar"><i></i></div><span>' + LABEL[k] + '</span>';
    box.appendChild(d);
  });
}

/* =========================================================
   PROCESAMIENTO: QUITAR FONDO
   ========================================================= */
function median(arr) {
  const a = Array.from(arr).sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

/* Rellena desde los bordes el fondo de color similar al del borde */
/* Piel: no se debe borrar nunca (cara, cuello, manos, brazos) */
function isSkin(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return r > 88 && g > 38 && b > 18 && r > g && r > b &&
         (mx - mn) > 14 && (r - g) > 12;
}

function buildBgMask(data, w, h, tol) {
  const mask = new Uint8Array(w * h).fill(1); // 1 = conservar
  const edges = [];

  const push = (x, y) => {
    const i = (y * w + x) * 4;
    edges.push([data[i], data[i + 1], data[i + 2]]);
  };
  for (let x = 0; x < w; x += 2) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += 2) { push(0, y); push(w - 1, y); }

  const br = median(edges.map((e) => e[0]));
  const bg = median(edges.map((e) => e[1]));
  const bb = median(edges.map((e) => e[2]));

  const t2 = tol * tol * 3;
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;

  const seed = (x, y) => {
    const p = y * w + x;
    if (visited[p]) return;
    const i = p * 4;
    if (isSkin(data[i], data[i + 1], data[i + 2])) return;
    const dr = data[i] - br, dg = data[i + 1] - bg, db = data[i + 2] - bb;
    if (dr * dr + dg * dg + db * db <= t2) {
      visited[p] = 1;
      stack[sp++] = p;
    }
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

  while (sp > 0) {
    const p = stack[--sp];
    mask[p] = 0;
    const x = p % w, y = (p / w) | 0;
    const nb = [
      x > 0 ? p - 1 : -1,
      x < w - 1 ? p + 1 : -1,
      y > 0 ? p - w : -1,
      y < h - 1 ? p + w : -1,
    ];
    for (const q of nb) {
      if (q < 0 || visited[q]) continue;
      const i = q * 4;
      if (isSkin(data[i], data[i + 1], data[i + 2])) continue;
      const dr = data[i] - br, dg = data[i + 1] - bg, db = data[i + 2] - bb;
      if (dr * dr + dg * dg + db * db <= t2) {
        visited[q] = 1;
        stack[sp++] = q;
      }
    }
  }
  return mask;
}

/* Suaviza la máscara para que el borde no quede duro */
function featherMask(mask, w, h, radius) {
  if (radius <= 0) return mask;
  let src = Float32Array.from(mask);
  let dst = new Float32Array(w * h);
  for (let pass = 0; pass < radius; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += src[yy * w + xx]; n++;
          }
        }
        dst[y * w + x] = s / n;
      }
    }
    const t = src; src = dst; dst = t;
  }
  return src;
}

/* Compone: persona sobre fondo blanco */
function compositeWhite(srcCanvas, mask, feather) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const sctx = srcCanvas.getContext('2d');
  const src = sctx.getImageData(0, 0, w, h);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);

  const m = featherMask(mask, w, h, feather);
  const d = src.data, o = img.data;
  for (let p = 0; p < w * h; p++) {
    const a = Math.max(0, Math.min(1, m[p]));
    const i = p * 4;
    // mezcla con blanco según el alfa
    o[i] = d[i] * a + 255 * (1 - a);
    o[i + 1] = d[i + 1] * a + 255 * (1 - a);
    o[i + 2] = d[i + 2] * a + 255 * (1 - a);
    o[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* Caja de la persona dentro de la máscara (ignora motas de ruido) */
function subjectBBox(mask, w, h) {
  if (!mask) return null;
  const col = new Int32Array(w), row = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[base + x]) { col[x]++; row[y]++; }
    }
  }
  const colThr = Math.max(2, h * 0.008);
  const rowThr = Math.max(2, w * 0.008);
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
  while (x0 < w && col[x0] < colThr) x0++;
  while (x1 > x0 && col[x1] < colThr) x1--;
  while (y0 < h && row[y0] < rowThr) y0++;
  while (y1 > y0 && row[y1] < rowThr) y1--;
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* Recorta a 3x4 (carné) SIN cortar a la persona: la encaja completa
   y rellena el resto con blanco puro. */
function cropTo3x4(src, targetW, bbox) {
  const ratio = 3 / 4;                 // ancho / alto
  const W = targetW || 600;
  const H = Math.round(W / ratio);     // 3x4 -> 600x800

  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // zona útil de la persona
  let bx = 0, by = 0, bw = src.width, bh = src.height;
  if (bbox && bbox.w > 8 && bbox.h > 8) {
    const pad = Math.round(Math.max(bbox.w, bbox.h) * 0.015);
    bx = Math.max(0, bbox.x - pad);
    by = Math.max(0, bbox.y - pad);
    bw = Math.min(src.width - bx, bbox.w + pad * 2);
    bh = Math.min(src.height - by, bbox.h + pad * 2);
  }

  // márgenes: aire sobre la cabeza, lados y hombros (nunca recorta)
  const mL = 0.07, mR = 0.07, mT = 0.085, mB = 0.045;
  const availW = W * (1 - mL - mR);
  const availH = H * (1 - mT - mB);
  const sc = Math.min(availW / bw, availH / bh);
  const dw = bw * sc, dh = bh * sc;
  const dx = W * mL + (availW - dw) / 2;
  const dy = H * mT + (availH - dh) / 2;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, bx, by, bw, bh, dx, dy, dw, dh);
  return out;
}

function renderPhoto() {
  if (!S.photo.src) return;
  const base = S.photo.src;
  let out;
  if (S.photo.auto) {
    out = compositeWhite(base, S.photo.mask, S.photo.feather);
  } else {
    out = document.createElement('canvas');
    out.width = base.width; out.height = base.height;
    out.getContext('2d').drawImage(base, 0, 0);
  }
  // tamaño carné 3x4 con fondo blanco garantizado, sin cortar cara ni cuerpo
  const bbox = (S.photo.auto && S.photo.mask)
    ? subjectBBox(S.photo.mask, base.width, base.height)
    : null;
  out = cropTo3x4(out, 600, bbox);
  S.photo.out = out;

  const box = $('#photoPreview');
  box.innerHTML = '';
  const c = document.createElement('canvas');
  c.width = out.width; c.height = out.height;
  c.getContext('2d').drawImage(out, 0, 0);
  c.style.maxHeight = '340px';
  c.style.width = 'auto';
  box.appendChild(c);

  if (S.photo.brush) attachBrush(c);
}

/* Pincel para corregir el recorte con el dedo */
function attachBrush(canvas) {
  canvas.style.cursor = 'crosshair';
  let painting = false;
  const paint = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * S.photo.w);
    const y = Math.round(((e.clientY - r.top) / r.height) * S.photo.h);
    const rad = Math.round(Math.max(S.photo.w, S.photo.h) * 0.035);
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (dx * dx + dy * dy > rad * rad) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= S.photo.w || yy >= S.photo.h) continue;
        S.photo.mask[yy * S.photo.w + xx] = 0;
      }
    }
    renderPhoto();
    // re-enganchar tras re-render
    const c2 = $('#photoPreview canvas');
    if (c2) attachBrush(c2);
    painting = true;
  };
  canvas.onpointerdown = (e) => { e.preventDefault(); painting = true; paint(e); };
  canvas.onpointermove = (e) => { if (painting) paint(e); };
  canvas.onpointerup = () => (painting = false);
  canvas.onpointerleave = () => (painting = false);
}

async function loadPhotoFile(file) {
  if (!file) return;
  const url = await fileToDataURL(file);
  const img = await loadImage(url);
  const base = fitCanvas(img, 900);
  S.photo.src = base;
  S.photo.w = base.width;
  S.photo.h = base.height;
  S.photo.mask = buildBgMask(
    base.getContext('2d').getImageData(0, 0, base.width, base.height).data,
    base.width, base.height, S.photo.tol
  );
  $('#photoPick').classList.add('hidden');
  $('#photoEdit').classList.remove('hidden');
  renderPhoto();
  setFoot('<button class="btn ok" id="footNext">Continuar →</button>');
  $('#footNext').onclick = () => usePhoto();
}

function usePhoto() {
  if (!S.photo.out) return;
  S.data.photo = S.photo.out;
  nextStep();
}

/* =========================================================
   PROCESAMIENTO: TINTA NEGRA (firma / huella)
   ========================================================= */
function toGray(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  return { g, w, h };
}

function boxBlur(g, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let sum = 0, count = 0;
    for (let x = -r; x <= r; x++) {
      const xx = Math.min(w - 1, Math.max(0, x));
      sum += g[y * w + xx]; count++;
    }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / count;
      const add = Math.min(w - 1, x + r + 1);
      const rem = Math.max(0, x - r);
      sum += g[y * w + add] - g[y * w + rem];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0, count = 0;
    for (let y = -r; y <= r; y++) {
      const yy = Math.min(h - 1, Math.max(0, y));
      sum += tmp[yy * w + x]; count++;
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / count;
      const add = Math.min(h - 1, y + r + 1);
      const rem = Math.max(0, y - r);
      sum += tmp[add * w + x] - tmp[rem * w + x];
    }
  }
  return out;
}

/* Integral image para media local rápida */
function integral(g, w, h) {
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += g[y * w + x];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return ii;
}

function localMean(ii, w, x0, y0, x1, y1) {
  const W = w + 1;
  const a = ii[y0 * W + x0];
  const b = ii[y0 * W + (x1 + 1)];
  const c = ii[(y1 + 1) * W + x0];
  const d = ii[(y1 + 1) * W + (x1 + 1)];
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  return (d - b - c + a) / area;
}

/* Convierte una foto de tinta en PNG negro con transparencia */
function inkFromPhoto(canvas, opts) {
  const { g, w, h } = toGray(canvas);
  const smooth = boxBlur(g, w, h, Math.max(1, Math.round(Math.max(w, h) / 700)));
  const ii = integral(smooth, w, h);

  const win = Math.max(8, Math.round(Math.max(w, h) / (opts.window || 12)));
  const C = (opts.strength / 100) * 60;   // umbral adaptativo
  const clean = opts.clean || 0;

  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - win), y1 = Math.min(h - 1, y + win);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - win), x1 = Math.min(w - 1, x + win);
      const mean = localMean(ii, w, x0, y0, x1, y1);
      const v = smooth[y * w + x];
      // cuánto más oscuro que su entorno
      const diff = mean - v;
      let a = (diff - C * 0.35) / Math.max(1, C);
      a = Math.max(0, Math.min(1, a));
      alpha[y * w + x] = a;
    }
  }

  // limpieza morfológica (elimina motas del papel)
  let fin = alpha;
  if (clean > 0) {
    const rad = Math.max(1, Math.round((clean / 90) * 2));
    let cur = alpha;
    for (let pass = 0; pass < rad; pass++) {
      const er = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let mn = 1;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= w) continue;
              mn = Math.min(mn, cur[yy * w + xx]);
            }
          }
          er[y * w + x] = mn;
        }
      }
      const di = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let mx = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= w) continue;
              mx = Math.max(mx, er[yy * w + xx]);
            }
          }
          di[y * w + x] = mx;
        }
      }
      cur = di;
    }
    fin = cur;
  }

  // recorte automático de márgenes vacíos
  let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (fin[y * w + x] > 0.25) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) { minX = 0; minY = 0; maxX = w - 1; maxY = h - 1; }
  const pad = Math.round(Math.max(w, h) * 0.02);
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;

  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  const octx = out.getContext('2d');
  const img = octx.createImageData(cw, ch);
  const o = img.data;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const a = fin[(y + minY) * w + (x + minX)];
      const i = (y * cw + x) * 4;
      o[i] = 12; o[i + 1] = 12; o[i + 2] = 14;  // tinta negra
      o[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* Muestra un canvas con transparencia sobre blanco */
function previewInk(canvas, box) {
  box.innerHTML = '';
  const holder = document.createElement('div');
  holder.style.cssText = 'background:#fff;padding:10px;width:100%;display:grid;place-items:center;';
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, 0, 0);
  c.style.maxWidth = '100%';
  c.style.maxHeight = '300px';
  holder.appendChild(c);
  box.appendChild(holder);
}

/* =========================================================
   PASO: FIRMA (dibujar)
   ========================================================= */
let sigCtx, sigDrawing = false, sigLast = null, sigHasInk = false;

function initSignature() {
  const canvas = $('#sigcanvas');
  sigCtx = canvas.getContext('2d');
  sigCtx.lineCap = 'round';
  sigCtx.lineJoin = 'round';
  sigCtx.strokeStyle = '#111';
  sigCtx.fillStyle = '#111';

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  };
  const width = () => parseInt($('#pen').value, 10) / 10;

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    sigDrawing = true;
    sigLast = pos(e);
    sigCtx.lineWidth = width();
    sigCtx.beginPath();
    sigCtx.moveTo(sigLast.x, sigLast.y);
    sigCtx.lineTo(sigLast.x + 0.1, sigLast.y + 0.1);
    sigCtx.stroke();
    sigHasInk = true;
    $('#sighint').style.display = 'none';
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!sigDrawing) return;
    e.preventDefault();
    const p = pos(e);
    const mid = { x: (sigLast.x + p.x) / 2, y: (sigLast.y + p.y) / 2 };
    sigCtx.lineWidth = width();
    sigCtx.beginPath();
    sigCtx.moveTo(sigLast.x, sigLast.y);
    sigCtx.quadraticCurveTo(sigLast.x, sigLast.y, mid.x, mid.y);
    sigCtx.stroke();
    sigLast = p;
  });

  const end = () => { sigDrawing = false; sigLast = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', end);
}

function clearSignature() {
  const canvas = $('#sigcanvas');
  sigCtx.clearRect(0, 0, canvas.width, canvas.height);
  sigHasInk = false;
  $('#sighint').style.display = '';
}

function signatureCanvas() {
  const src = $('#sigcanvas');
  // recortar al contenido
  const { g, w, h } = toGray(src);
  let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (g[y * w + x] < 200) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) return null;
  const pad = 12;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);

  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/* =========================================================
   FLUJO
   ========================================================= */
function nextStep() {
  S.step = Math.min(S.step + 1, S.steps.length);
  if (S.step >= S.steps.length) {
    renderProgress();
    showReview();
    return;
  }
  renderStep();
}

function renderMenu() {
  show('viewMenu');
  S.steps.forEach((k) => {
    const el = document.querySelector('.mi-st[data-st="' + k + '"]');
    if (!el) return;
    const done = !!S.data[k];
    el.textContent = done ? 'Listo ✔' : 'Pendiente';
    el.classList.toggle('done', done);
  });
  const all = S.steps.every((k) => !!S.data[k]);
  const start = $('#btnStartMenu');
  if (start) {
    start.textContent = all ? 'Revisar y enviar' : 'Empezar';
    start.onclick = () => {
      if (all) { showReview(); return; }
      let i = S.steps.findIndex((k) => !S.data[k]);
      if (i < 0) i = 0;
      S.step = i;
      renderStep();
    };
  }
  setFoot('');
}

function renderStep() {
  renderProgress();
  const k = S.steps[S.step];
  if (k === 'photo') {
    show('viewPhoto');
    setFoot(S.photo.out
      ? '<button class="btn ok" id="footNext">Continuar →</button>'
      : '<button class="btn primary" id="footNext">Elegir foto</button>');
    const b = $('#footNext');
    if (b) b.onclick = () => {
      if (S.photo.out) usePhoto();
      else $('#btnCamera').click();
    };
  } else if (k === 'signature') {
    show('viewSign');
    setFoot('<button class="btn ok" id="footNext">Continuar →</button>');
    $('#footNext').onclick = () => useSignature();
  } else {
    show('viewFinger');
    // si ya hay huella, mostrar el resultado; si no, el sensor listo
    const has = !!S.data.fingerprint;
    $('#fingerEdit').classList.toggle('hidden', !has);
    $('#fpSensor').classList.toggle('hidden', has);
    $('#fingerPick').classList.add('hidden');
    if (!has) fpSetStatus('Sensor apagado');
    setFoot('<button class="btn ok" id="footNext">Continuar →</button>');
    $('#footNext').onclick = () => useFinger();
  }
}

function useSignature() {
  let c = null;
  if (S.sign.mode === 'draw') {
    if (!sigHasInk) { toast('Primero firma en el recuadro', true); return; }
    c = signatureCanvas();
  } else {
    c = S.data.signature;
  }
  if (!c) { toast('Primero agrega tu firma', true); return; }
  S.data.signature = c;
  nextStep();
}

function useFinger() {
  if (!S.data.fingerprint) { toast('Primero captura tu huella', true); return; }
  nextStep();
}

function showReview() {
  show('viewReview');
  const box = $('#summary');
  box.innerHTML = '';
  S.steps.forEach((k, i) => {
    const row = document.createElement('div');
    row.className = 'sum-row';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const c = S.data[k];
    if (c) {
      const im = document.createElement('img');
      im.src = c.toDataURL('image/png');
      thumb.appendChild(im);
    } else {
      thumb.innerHTML = '<span style="color:#c33;font-size:20px;">!</span>';
    }
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = '<b>' + LABEL[k] + '</b><span>' +
      (c ? 'Listo' : 'Falta') + '</span>';
    const fix = document.createElement('button');
    fix.className = 'fix';
    fix.textContent = 'Corregir';
    fix.onclick = () => { S.step = i; renderStep(); };
    row.appendChild(thumb); row.appendChild(info); row.appendChild(fix);
    box.appendChild(row);
  });

  const missing = S.steps.filter((k) => !S.data[k]);
  setFoot('<button class="btn ok" id="footSend"' + (missing.length ? ' disabled' : '') +
    '>Enviar mis datos</button>');
  const btn = $('#footSend');
  if (btn) btn.onclick = sendAll;
}

async function buildPackage() {
  const files = {};
  for (const k of S.steps) {
    if (S.data[k]) files[k] = S.data[k].toDataURL('image/png');
  }
  return {
    app: 'superEditor', v: 1,
    token: TOKEN,
    label: (S.session && S.session.label) || 'Datos personales',
    steps: S.steps,
    person_name: ($('#personName').value || '').trim(),
    created: Math.floor(Date.now() / 1000),
    files,
  };
}

/* Sin servidor: se genera un paquete que la persona comparte por WhatsApp */
async function sendLocal() {
  const pkg = await buildPackage();
  const blob = new Blob([JSON.stringify(pkg)], { type: 'application/json' });
  const fname = 'superEditor_datos_' + String(TOKEN).slice(-6) + '.json';

  let shared = false;
  try {
    const file = new File([blob], fname, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: 'Datos para superEditor',
        text: 'Aquí están mi foto, firma y huella.',
      });
      shared = true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      S.sending = false;
      const b = $('#footSend');
      if (b) { b.disabled = false; b.textContent = 'Enviar mis datos'; }
      return;
    }
  }

  if (!shared) downloadBlob(blob, fname);

  show('viewDone');
  const h = $('#viewDone').querySelector('h2');
  const p = $('#viewDone').querySelector('p');
  if (h) h.textContent = shared ? '¡Datos listos y compartidos!' : '¡Datos listos!';
  if (p) p.innerHTML = shared
    ? 'Tu foto, firma y huella se enviaron al responsable.<br/>Ya puedes cerrar esta página.'
    : 'Se descargó el archivo <b>' + fname + '</b>.<br/>Envíalo por WhatsApp al responsable ' +
      'para que quede registrado.';
  setFoot('');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function sendAll() {
  if (S.sending) return;
  S.sending = true;
  const btn = $('#footSend');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  $('#sendErr').classList.add('hidden');

  const name = ($('#personName').value || '').trim();

  // Enlace autónomo: no hay servidor, se devuelve un paquete
  if (LOCAL_REQ) {
    try { await sendLocal(); } catch (e) { showSendError(e); }
    return;
  }

  try {
    if (name) {
      await fetch(API + '/api/sessions/' + TOKEN + '/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person_name: name }),
      }).catch(() => {});
    }

    const caja = document.querySelector('#consentBox');
    if (caja && !caja.checked) {
      throw new Error('Marca la casilla de autorización para poder enviar tus datos.');
    }

    for (const k of S.steps) {
      const canvas = S.data[k];
      if (!canvas) continue;
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      const fd = new FormData();
      fd.append('kind', k);
      fd.append('consent', '1');
      fd.append('file', blob, k + '.png');
      const r = await fetch(API + '/api/sessions/' + TOKEN + '/upload', {
        method: 'POST', body: fd,
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error('Error al enviar ' + LABEL[k] + ' (' + r.status + ') ' + t);
      }
    }

    await fetch(API + '/api/sessions/' + TOKEN + '/submit', { method: 'POST' });

    show('viewDone');
    setFoot('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    console.error(e);
    // Si el servidor no responde, se usa el modo paquete para no perder los datos
    try { await sendLocal(); }
    catch (e2) { showSendError(e); }
  }
}

function showSendError(e) {
  const box = $('#sendErr');
  if (box) {
    box.textContent = 'No se pudo enviar: ' + (e && e.message ? e.message : 'error') +
      '. Revisa tu conexión e inténtalo de nuevo.';
    box.classList.remove('hidden');
  }
  const btn = $('#footSend');
  if (btn) { btn.disabled = false; btn.textContent = 'Enviar mis datos'; }
  S.sending = false;
}

/* =========================================================
   EVENTOS
   ========================================================= */
function bindUI() {
  // ---- foto
  $('#btnCamera').onclick = () => $('#fileCamera').click();
  $('#btnGallery').onclick = () => $('#fileGallery').click();
  $('#fileCamera').onchange = (e) => loadPhotoFile(e.target.files[0]);
  $('#fileGallery').onchange = (e) => loadPhotoFile(e.target.files[0]);

  $('#tol').oninput = (e) => {
    S.photo.tol = parseInt(e.target.value, 10);
    $('#tolVal').textContent = S.photo.tol;
    if (S.photo.src) {
      S.photo.mask = buildBgMask(
        S.photo.src.getContext('2d').getImageData(0, 0, S.photo.w, S.photo.h).data,
        S.photo.w, S.photo.h, S.photo.tol
      );
      renderPhoto();
    }
  };
  $('#feather').oninput = (e) => {
    S.photo.feather = parseInt(e.target.value, 10);
    $('#featVal').textContent = S.photo.feather;
    renderPhoto();
  };
  $('#chipAuto').onclick = () => {
    S.photo.auto = !S.photo.auto;
    $('#chipAuto').classList.toggle('on', S.photo.auto);
    $('#chipAuto').textContent = 'Quitar fondo: ' + (S.photo.auto ? 'sí' : 'no');
    renderPhoto();
  };
  $('#chipBrush').onclick = () => {
    S.photo.brush = !S.photo.brush;
    $('#chipBrush').classList.toggle('on', S.photo.brush);
    if (S.photo.brush) {
      S.photo.auto = true;
      $('#chipAuto').classList.add('on');
      $('#chipAuto').textContent = 'Quitar fondo: sí';
      toast('Pasa el dedo por lo que quieras borrar');
    }
    renderPhoto();
  };
  $('#btnRetakePhoto').onclick = () => {
    $('#photoEdit').classList.add('hidden');
    $('#photoPick').classList.remove('hidden');
    S.photo.out = null;
    setFoot('<button class="btn primary" id="footNext">Elegir foto</button>');
    $('#footNext').onclick = () => $('#btnCamera').click();
  };
  $('#btnUsePhoto').onclick = usePhoto;

  // ---- firma
  initSignature();
  $$('#signModeChips .mode-btn').forEach((c) => {
    c.onclick = () => {
      $$('#signModeChips .mode-btn').forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      S.sign.mode = c.dataset.mode;
      $('#signDraw').classList.toggle('hidden', S.sign.mode !== 'draw');
      $('#signPhoto').classList.toggle('hidden', S.sign.mode !== 'photo');
      // "Buscar en galería": abre el selector de fotos al instante
      if (S.sign.mode === 'photo') setTimeout(() => $('#sigFileGal').click(), 60);
    };
  });
  $('#pen').oninput = (e) => { $('#penVal').textContent = (e.target.value / 10).toFixed(1); };
  $('#btnClearSig').onclick = clearSignature;
  $('#btnUseSigDraw').onclick = () => {
    if (!sigHasInk) { toast('Primero firma en el recuadro', true); return; }
    S.data.signature = signatureCanvas();
    nextStep();
  };

  $('#btnSigCam').onclick = () => $('#sigFileCam').click();
  $('#btnSigGal').onclick = () => $('#sigFileGal').click();
  const onSigPhoto = async (file) => {
    if (!file) return;
    const img = await loadImage(await fileToDataURL(file));
    S.sign.raw = fitCanvas(img, 1000);
    $('#sigPhotoEdit').classList.remove('hidden');
    renderSigPhoto();
  };
  $('#sigFileCam').onchange = (e) => onSigPhoto(e.target.files[0]);
  $('#sigFileGal').onchange = (e) => onSigPhoto(e.target.files[0]);

  $('#sigInk').oninput = (e) => {
    $('#sigInkVal').textContent = e.target.value;
    renderSigPhoto();
  };
  $('#btnSigPhotoRetry').onclick = () => {
    $('#sigPhotoEdit').classList.add('hidden');
    $('#sigFileCam').value = '';
    $('#sigFileGal').value = '';
  };
  $('#btnUseSigPhoto').onclick = () => {
    if (!S.sign.out) { toast('No se detectó la firma en la foto', true); return; }
    S.data.signature = S.sign.out;
    nextStep();
  };

  // ---- huella
  $$('#fpModeChips .mode-btn').forEach((c) => {
    c.onclick = () => {
      $$('#fpModeChips .mode-btn').forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      const mode = c.dataset.fpmode;
      $('#fpSensor').classList.toggle('hidden', mode !== 'sensor');
      $('#fingerPick').classList.toggle('hidden', mode !== 'photo');
      if (mode !== 'sensor') fpStopSensor();
    };
  });
  $('#btnFpStart').onclick = fpStartSensor;
  $('#btnFpCapture').onclick = fpCapture;

  $('#btnFingerCam').onclick = () => $('#fingerFileCam').click();
  $('#btnFingerGal').onclick = () => $('#fingerFileGal').click();
  const onFinger = async (file) => {
    if (!file) return;
    const img = await loadImage(await fileToDataURL(file));
    S.finger.raw = fitCanvas(img, 1000);
    $('#fingerPick').classList.add('hidden');
    $('#fingerEdit').classList.remove('hidden');
    renderFinger();
  };
  $('#fingerFileCam').onchange = (e) => onFinger(e.target.files[0]);
  $('#fingerFileGal').onchange = (e) => onFinger(e.target.files[0]);

  $('#fpCon').oninput = (e) => {
    S.finger.con = parseInt(e.target.value, 10);
    $('#fpConVal').textContent = S.finger.con;
    renderFinger();
  };
  $('#fpClean').oninput = (e) => {
    S.finger.clean = parseInt(e.target.value, 10);
    $('#fpCleanVal').textContent = S.finger.clean;
    renderFinger();
  };
  $('#btnFingerRetry').onclick = () => {
    $('#fingerEdit').classList.add('hidden');
    S.data.fingerprint = null;
    $('#fingerFileCam').value = '';
    $('#fingerFileGal').value = '';
    const sensorOn = $('#fpModeChips .mode-btn[data-fpmode="sensor"]').classList.contains('on');
    $('#fpSensor').classList.toggle('hidden', !sensorOn);
    $('#fingerPick').classList.toggle('hidden', sensorOn);
    fpStopSensor();
    fpSetStatus('Sensor apagado');
  };
  $('#btnUseFinger').onclick = () => {
    if (!S.data.fingerprint) { toast('No se detectó la huella', true); return; }
    nextStep();
  };
}

/* =========================================================
   SENSOR DIGITAL DE HUELLA (cámara macro + captura automática)
   ========================================================= */
const FP = { stream: null, raf: null, timer: null, running: false, good: 0, busy: false };

function fpSetStatus(msg, cls) {
  const el = $('#fpStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'fp-status' + (cls ? ' ' + cls : '');
}

function fpStopSensor() {
  FP.running = false;
  FP.good = 0;
  if (FP.timer) { clearInterval(FP.timer); FP.timer = null; }
  if (FP.stream) {
    FP.stream.getTracks().forEach((t) => t.stop());
    FP.stream = null;
  }
  const v = $('#fpVideo');
  if (v) v.srcObject = null;
  const st = document.querySelector('.fp-stage');
  if (st) st.classList.remove('scanning', 'locked');
  const b1 = $('#btnFpStart'), b2 = $('#btnFpCapture');
  if (b1) { b1.classList.remove('hidden'); b1.textContent = 'Activar sensor'; }
  if (b2) b2.classList.add('hidden');
  fpSetStatus('Sensor apagado');
}

async function fpStartSensor() {
  if (FP.running) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    fpSetStatus('Este navegador no permite la cámara. Usa "Foto de galería".', 'warn');
    return;
  }
  try {
    fpSetStatus('Encendiendo cámara…');
    FP.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 1280 },
      },
      audio: false,
    });
    const v = $('#fpVideo');
    v.srcObject = FP.stream;
    await v.play().catch(() => {});
    // enfoque continuo si el dispositivo lo soporta
    const track = FP.stream.getVideoTracks()[0];
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch (e) {}

    FP.running = true;
    const st = document.querySelector('.fp-stage');
    if (st) st.classList.add('scanning');
    $('#btnFpStart').classList.add('hidden');
    $('#btnFpCapture').classList.remove('hidden');
    fpSetStatus('Buscando la huella… acerca la hoja al círculo');
    FP.timer = setInterval(fpAnalyze, 420);
  } catch (e) {
    fpSetStatus('No se pudo abrir la cámara. Revisa el permiso o usa "Foto de galería".', 'warn');
    fpStopSensor();
  }
}

/* Mide nitidez y presencia de tinta en el círculo central */
function fpAnalyze() {
  if (!FP.running || FP.busy) return;
  const v = $('#fpVideo');
  if (!v || !v.videoWidth) return;

  const side = Math.min(v.videoWidth, v.videoHeight);
  const cx = (v.videoWidth - side) / 2;
  const cy = (v.videoHeight - side) / 2;
  const N = 160;
  const c = document.createElement('canvas');
  c.width = N; c.height = N;
  const ctx = c.getContext('2d');
  ctx.drawImage(v, cx, cy, side, side, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;

  // solo el círculo central (r = 36% del lado)
  const R = N * 0.36, cc = N / 2;
  let n = 0, sum = 0, sum2 = 0, dark = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cc, dy = y - cc;
      if (dx * dx + dy * dy > R * R) continue;
      const i = (y * N + x) * 4;
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      n++; sum += g; sum2 += g * g;
      if (g < 110) dark++;
    }
  }
  if (!n) return;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const darkRatio = dark / n;

  const hasInk = darkRatio > 0.02 && darkRatio < 0.62;
  const sharp = std > 16;

  if (hasInk && sharp) {
    FP.good++;
    fpSetStatus('Huella detectada… mantén firme (' + FP.good + '/3)', 'ok');
    const st = document.querySelector('.fp-stage');
    if (st) st.classList.add('locked');
    if (FP.good >= 3) fpCapture();
  } else {
    FP.good = 0;
    const st = document.querySelector('.fp-stage');
    if (st) st.classList.remove('locked');
    if (!hasInk) fpSetStatus('No veo la huella: entíntala y acerca la hoja');
    else fpSetStatus('Enfocando… no muevas la hoja');
  }
}

async function fpCapture() {
  if (FP.busy) return;
  FP.busy = true;
  const v = $('#fpVideo');
  if (!v || !v.videoWidth) { FP.busy = false; return; }

  const side = Math.min(v.videoWidth, v.videoHeight);
  const cx = (v.videoWidth - side) / 2;
  const cy = (v.videoHeight - side) / 2;
  const c = document.createElement('canvas');
  c.width = 900; c.height = 900;
  const ctx = c.getContext('2d');
  ctx.drawImage(v, cx, cy, side, side, 0, 0, 900, 900);

  // recorte circular: fuera del círculo queda blanco (como en el papel)
  const out = document.createElement('canvas');
  out.width = 900; out.height = 900;
  const o = out.getContext('2d');
  o.fillStyle = '#ffffff';
  o.fillRect(0, 0, 900, 900);
  o.save();
  o.beginPath();
  o.arc(450, 450, 372, 0, Math.PI * 2);
  o.clip();
  o.drawImage(c, 0, 0);
  o.restore();

  fpSetStatus('Capturando huella…', 'ok');
  fpStopSensor();
  S.finger.raw = out;
  $('#fpSensor').classList.add('hidden');
  $('#fingerPick').classList.add('hidden');
  $('#fingerEdit').classList.remove('hidden');
  renderFinger();
  const ok = S.data.fingerprint && S.data.fingerprint.width > 0;
  fpSetStatus(ok ? 'Huella capturada ✔' : 'No se detectó tinta', ok ? 'ok' : 'warn');
  FP.busy = false;
}

function renderSigPhoto() {
  if (!S.sign.raw) return;
  const strength = parseInt($('#sigInk').value, 10);
  S.sign.out = inkFromPhoto(S.sign.raw, { strength, clean: 20, window: 14 });
  previewInk(S.sign.out, $('#sigPhotoPreview'));
}

function renderFinger() {
  if (!S.finger.raw) return;
  S.data.fingerprint = inkFromPhoto(S.finger.raw, {
    strength: S.finger.con,
    clean: S.finger.clean,
    window: 9,
  });
  previewInk(S.data.fingerprint, $('#fingerPreview'));
}

/* =========================================================
   ARRANQUE
   ========================================================= */
function bindMenu() {
  $$('#viewMenu .menu-item').forEach((b) => {
    b.onclick = () => {
      const i = parseInt(b.dataset.go, 10);
      if (!isNaN(i)) { S.step = i; renderStep(); }
    };
  });
}

async function boot() {
  bindUI();
  bindMenu();

  // Enlace autónomo (sin servidor): los datos vienen dentro del enlace
  if (LOCAL_REQ) {
    S.session = LOCAL_REQ;
    S.steps = Array.isArray(LOCAL_REQ.steps) && LOCAL_REQ.steps.length
      ? LOCAL_REQ.steps : ['photo', 'signature', 'fingerprint'];
    $('#reqTitle').textContent = LOCAL_REQ.label || 'Solicitud de datos';
    $('#reqSub').textContent = 'Completa los ' + S.steps.length +
      ' pasos. Puedes repetir cada uno hasta que quede bien.';
    renderMenu();
    return;
  }

  if (!TOKEN) {
    show('viewError');
    $('#errMsg').textContent = 'Falta el código de la solicitud en el enlace.';
    return;
  }
  try {
    const r = await fetch(API + '/api/sessions/' + TOKEN);
    if (!r.ok) throw new Error('no encontrada');
    const s = await r.json();
    S.session = s;
    S.steps = s.steps && s.steps.length ? s.steps : ['photo', 'signature', 'fingerprint'];
    $('#reqTitle').textContent = s.label || 'Solicitud de datos';
    $('#reqSub').textContent = 'Completa los ' + S.steps.length +
      ' pasos. Puedes repetir cada uno hasta que quede bien.';

    if (s.status === 'submitted') {
      show('viewDone');
      $('#viewDone').querySelector('h2').textContent = 'Ya enviaste tus datos';
      $('#viewDone').querySelector('p').innerHTML =
        'Esta solicitud ya fue completada.<br/>Si necesitas corregir algo, pide un enlace nuevo.';
      return;
    }
    renderMenu();
  } catch (e) {
    show('viewError');
  }
}

document.addEventListener('DOMContentLoaded', boot);
