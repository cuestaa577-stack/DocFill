/* =========================================================
   DocFill — Editor de documentos con datos vinculados
   Todo se ejecuta en el navegador (nada se sube a un servidor)
   ========================================================= */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'assets/vendor/pdf.worker.min.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));


/* ---- Resolucion segura: evita que el navegador se quede sin memoria ---- */
const MAX_PX = 100 * 1000 * 1000;   // 100 megapixeles por lienzo
const MAX_LADO = 16384;             // limite practico de canvas en moviles
function escalaSegura(ps, pedida) {
  let k = Math.max(0.1, pedida);
  const lado = Math.max(ps.w, ps.h) * k;
  if (lado > MAX_LADO) k = MAX_LADO / Math.max(ps.w, ps.h);
  const px = ps.w * k * ps.h * k;
  if (px > MAX_PX) k *= Math.sqrt(MAX_PX / px);
  return k;
}
function avisarCalidad(ps, k, pedida) {
  if (k < pedida - 0.01) {
    toast('Para ese tamano se exporto a ' + Math.round(k * 72) + ' DPI (limite del navegador).', 'warn');
  }
}

const state = {
  doc: null,          // {type:'pdf'|'image', bytes, pdf, src, numPages, pageSizes:[{w,h}], name}
  page: 1,
  zoom: 1.2,
  tool: 'select',
  overlays: {},       // { [pageNum]: [overlay,...] }
  vars: [],           // [{id, key, value}]
  selected: null,     // overlay id
  editing: null,      // overlay id en edición
  customFont: null,   // {name, bytes}
  textCache: {},      // pageNum -> items
  ocrCache: {},       // pageNum -> items (palabras reconocidas)
  ocrDone: {},        // pageNum -> true
  ocrWorker: null,
  paper: {},          // pageNum -> {color:'#rrggbb', auto:bool}
  pageRaster: {},     // pageNum -> dataURL (página rasterizada/limpiada)
  paperTint: false,   // ver como impreso
  bgPick: null,       // {color, x, y} para el borrador de fondo
};

/* ========================= UTILIDADES ========================= */
let toastTimer;
function toast(msg, type) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (type === 'err' ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

function overlaysOf(p) {
  if (!state.overlays[p]) state.overlays[p] = [];
  return state.overlays[p];
}
function allOverlays() {
  const out = [];
  Object.keys(state.overlays).forEach((p) => {
    state.overlays[p].forEach((o) => out.push({ o, page: Number(p) }));
  });
  return out;
}
function findOverlay(id) {
  for (const p of Object.keys(state.overlays)) {
    const o = state.overlays[p].find((x) => x.id === id);
    if (o) return { o, page: Number(p) };
  }
  return null;
}
function varById(id) { return state.vars.find((v) => v.id === id); }
function varByKey(key) { return state.vars.find((v) => v.key === key); }

function slugKey(text) {
  const base = (text || 'dato')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 22);
  let k = base || 'dato';
  let i = 2;
  while (state.vars.some((v) => v.key === k)) k = base + '_' + i++;
  return k;
}

/* ========================= CARGA DE DOCUMENTO ========================= */
/* Detecta el tipo real del archivo (Android a veces manda type vacío) */
async function sniffType(file) {
  const name = (file.name || '').toLowerCase();
  if (file.type === 'application/pdf' || /\.pdf$/.test(name)) return 'pdf';
  if (/^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/.test(name)) return 'image';
  // último recurso: leer los primeros bytes
  try {
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    const sig = String.fromCharCode.apply(null, head);
    if (sig === '%PDF-') return 'pdf';
  } catch (e) { /* ignore */ }
  return file.type ? 'image' : 'pdf';
}

async function fillPageSizes(pdf, arr) {
  for (let i = 2; i <= pdf.numPages; i++) {
    if (arr[i - 1]) continue;
    try {
      const p = await pdf.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      arr[i - 1] = { w: vp.width, h: vp.height };
    } catch (e) {
      arr[i - 1] = arr[0] || { w: 595, h: 842 };
    }
  }
}

async function abrirArchivo(file) {
  if (!file) return;
  const mb = file.size / (1024 * 1024);
  if (mb > 120) {
    toast('Archivo grande (' + mb.toFixed(0) + ' MB). Puede tardar y usar bastante memoria.', 'warn');
  }
  try {
    await openFile(file);
    autoguardar();
  } catch (err) {
    console.error(err);
    const detalle = String((err && err.message) || '');
    const texto = /bounding box/i.test(detalle)
      ? 'Este PDF está dañado: le falta el recuadro de la página. Intenté repararlo y no fue posible.'
      : 'No se pudo abrir el archivo: ' + (detalle || 'formato no compatible');
    toast(texto, 'err');
    const l = document.querySelector('#loadOverlay');
    if (l) l.classList.remove('show');
  }
}


/* ====== Reparacion de PDF mal formado ======
   Algunos PDF traen un grupo de transparencia (Form XObject con /Group) sin
   /BBox. pdf.js lanza "Bounding box is required." y la pagina no se dibuja.
   Se le pone una caja al grupo y se vuelve a cargar el documento. */
async function repararGrupos(buf) {
  if (typeof PDFLib === 'undefined') return null;
  try {
    const { PDFDocument, PDFName } = PDFLib;
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    const ctx = doc.context;
    let tocados = 0;
    for (const par of ctx.enumerateIndirectObjects()) {
      const obj = par[1];
      const dict = obj && obj.dict ? obj.dict : obj;
      if (!dict || typeof dict.get !== 'function') continue;
      const grupo = dict.lookup ? dict.lookup(PDFName.of('Group')) : dict.get(PDFName.of('Group'));
      if (!grupo) continue;
      const caja = dict.lookup ? dict.lookup(PDFName.of('BBox')) : dict.get(PDFName.of('BBox'));
      if (caja) continue;
      dict.set(PDFName.of('BBox'), ctx.obj([0, 0, 612, 792]));
      tocados++;
    }
    if (!tocados) return null;
    return await doc.save();
  } catch (e) {
    console.warn('No se pudo reparar el PDF', e);
    return null;
  }
}

async function repararDocumento() {
  if (!state.doc || state.doc.type !== 'pdf' || !state.doc.bytes) return false;
  const nuevo = await repararGrupos(state.doc.bytes);
  if (!nuevo) return false;
  try {
    const pdf = await pdfjsLib.getDocument({ data: nuevo.slice(0), isEvalSupported: false }).promise;
    const p1 = await pdf.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    state.doc.bytes = nuevo;
    state.doc.pdf = pdf;
    state.doc.numPages = pdf.numPages;
    state.doc.pageSizes = new Array(pdf.numPages).fill(null);
    state.doc.pageSizes[0] = { w: vp.width, h: vp.height };
    fillPageSizes(pdf, state.doc.pageSizes);
    state.pageRaster = {};
    toast('Documento reparado: ya se puede editar.');
    return true;
  } catch (e) {
    console.warn('El PDF reparado tampoco abre', e);
    return false;
  }
}

async function openFile(file) {
  if (!file) return;
  let kind = 'pdf';
  try {
    kind = await sniffType(file);
  } catch (e) { kind = 'pdf'; }
  const isPdf = kind === 'pdf';
  const loading = $('#loadOverlay');
  if (loading) loading.classList.add('show');

  state.overlays = {};
  state.vars = [];
  state.selected = null;
  state.page = 1;
  state.textCache = {};
  state.ocrCache = {};
  state.ocrDone = {};
  state.paper = {};
  state.pageRaster = {};
  state.bgPick = null;
  state.reparado = false;

  if (isPdf) {
    const buf = await file.arrayBuffer();
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: buf.slice(0), isEvalSupported: false }).promise;
    } catch (err) {
      if (loading) loading.classList.remove('show');
      const msg = /password/i.test(String(err && err.name) + String(err && err.message))
        ? 'El PDF está protegido con contraseña.'
        : 'No se pudo abrir el PDF (archivo dañado o formato no compatible).';
      toast(msg, 'err');
      return;
    }
    // Solo se mide la primera página: los PDF grandes abren al instante
    const p1 = await pdf.getPage(1);
    const vp1 = p1.getViewport({ scale: 1 });
    const pageSizes = new Array(pdf.numPages).fill(null);
    pageSizes[0] = { w: vp1.width, h: vp1.height };
    state.doc = {
      type: 'pdf', bytes: buf, pdf, numPages: pdf.numPages,
      pageSizes, name: (file.name || 'documento').replace(/\.pdf$/i, ''),
    };
    // completar tamaños en segundo plano (sin bloquear la apertura)
    fillPageSizes(pdf, pageSizes);
  } else {
    const dataUrl = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(file);
    });
    const img = new Image();
    img.src = dataUrl;
    await img.decode();

    // Normalizar a PNG/JPEG (pdf-lib no soporta WEBP/GIF directamente)
    let src = dataUrl;
    if (!/^data:image\/(png|jpe?g)/i.test(dataUrl)) {
      const lado = Math.max(img.naturalWidth, img.naturalHeight);
      const k = lado > MAX_LADO ? MAX_LADO / lado : 1;
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      src = c.toDataURL('image/png');
    }

    const w = img.naturalWidth * 0.75;   // px @96dpi -> pt @72dpi
    const h = img.naturalHeight * 0.75;
    state.doc = {
      type: 'image', src, numPages: 1,
      pageSizes: [{ w, h }], name: file.name.replace(/\.[^.]+$/, ''),
    };
  }

  $('#dropzone').classList.add('hidden');
  $('#pageCount').textContent = state.doc.numPages;
  $('#pageNum').max = state.doc.numPages;
  $('#pageNum').value = 1;
  fitZoom();
  await renderPage();
  renderAll();
  if (loading) loading.classList.remove('show');
  // asegurar que el documento quede visible
  const v = $('#viewer');
  if (v) v.scrollTop = 0;
  toast('Documento cargado: ' + (file.name || 'documento'));
  ofrecerRestaurar(file);
}

function fitZoom() {
  if (!state.doc) return;
  const v = $('#viewer');
  const pad = window.innerWidth <= 900 ? 18 : 60;
  const vw = Math.max(120, v.clientWidth - pad);
  const vh = Math.max(120, v.clientHeight - pad);
  const ps = state.doc.pageSizes[state.page - 1] || state.doc.pageSizes[0];
  const z = Math.min(vw / ps.w, vh / ps.h);
  state.zoom = clamp(z, 0.15, 4);
}

function pageSize(n) {
  if (!state.doc) return { w: 595, h: 842 };
  const ps = state.doc.pageSizes[n - 1];
  if (ps) return ps;
  const first = state.doc.pageSizes.find((x) => x) || { w: 595, h: 842 };
  // si aún no se midió, se mide en segundo plano y se vuelve a pintar
  if (state.doc.type === 'pdf' && state.doc.pdf) {
    state.doc.pdf.getPage(n).then((p) => {
      const vp = p.getViewport({ scale: 1 });
      state.doc.pageSizes[n - 1] = { w: vp.width, h: vp.height };
    }).catch(() => {});
  }
  return first;
}

/* ========================= RENDER DE PÁGINA ========================= */
async function _renderPage() {
  if (!state.doc) return;
  const wrap = $('#pageWrap');
  wrap.innerHTML = '';
  const scale = state.zoom;
  const ps = pageSize(state.page);

  // Si la página fue limpiada/rasterizada, se muestra esa versión
  const override = state.doc.type === 'pdf'
    ? state.pageRaster[state.page]
    : (state.doc.cleanSrc || null);

  if (override) {
    const img = document.createElement('img');
    img.src = override;
    img.style.width = ps.w * scale + 'px';
    img.style.height = ps.h * scale + 'px';
    wrap.appendChild(img);
  } else if (state.doc.type === 'pdf') {
    const p = await state.doc.pdf.getPage(state.page);
    const vp = p.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    await p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    wrap.appendChild(canvas);
  } else {
    const img = document.createElement('img');
    img.src = state.doc.src;
    img.style.width = ps.w * scale + 'px';
    img.style.height = ps.h * scale + 'px';
    wrap.appendChild(img);
  }

  // tinte de papel (vista de impresión)
  const tint = document.createElement('div');
  tint.className = 'paper-tint';
  tint.style.background = paperColor(state.page);
  wrap.appendChild(tint);
  wrap.classList.toggle('show-paper', !!state.paperTint);

  const layer = document.createElement('div');
  layer.className = 'overlay-layer tool-' + state.tool;
  layer.id = 'overlayLayer';
  layer.style.width = ps.w * scale + 'px';
  layer.style.height = ps.h * scale + 'px';
  wrap.appendChild(layer);

  bindLayerEvents(layer);
  renderOverlays();
  $('#zoomLabel').textContent = Math.round(scale * 100) + '%';
  const mp = $('#mobPage');
  if (mp) {
    mp.classList.toggle('show', !!state.doc && state.doc.numPages > 1);
    const lbl = $('#mobPageLabel');
    if (lbl) lbl.textContent = state.page + ' / ' + (state.doc ? state.doc.numPages : 1);
  }

  // color real del papel: se detecta solo la primera vez que se ve la página
  if (!state.paper[state.page]) {
    await ensurePaper(state.page);
  } else {
    renderPaperUI();
  }
}

async function renderPage() {
  try {
    return await _renderPage();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/bounding box/i.test(msg) && !state.reparado && await repararDocumento()) {
      state.reparado = true;
      return await _renderPage();
    }
    throw e;
  }
}

/* ========================= OVERLAYS ========================= */
function positionEl(el, o) {
  const s = state.zoom;
  el.style.left = o.x * s + 'px';
  el.style.top = o.y * s + 'px';
  el.style.width = o.w * s + 'px';
  el.style.height = o.h * s + 'px';
  if (o.type === 'text') el.style.fontSize = o.fontSize * s + 'px';
}

function makeOverlayEl(o) {
  const s = state.zoom;
  const el = document.createElement('div');
  el.className = 'ov ov-' + o.type;
  el.dataset.id = o.id;
  positionEl(el, o);

  if (o.type === 'text') {
    el.style.color = o.color || '#000000';
    el.style.fontWeight = o.bold ? '700' : '400';
    el.style.fontStyle = o.italic ? 'italic' : 'normal';
    el.style.textAlign = o.align || 'left';
    el.style.fontFamily = o.fontFamily || 'Helvetica, Arial, sans-serif';
    el.style.background = o.cover ? (o.coverColor || '#ffffff') : 'transparent';
    el.textContent = o.text || '';
    el.contentEditable = 'false';

    if (o.varId) {
      el.classList.add('bound');
      const v = varById(o.varId);
      const tag = document.createElement('span');
      tag.className = 'var-tag';
      tag.textContent = v ? v.key : '?';
      el.appendChild(tag);
    }

    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startEdit(o.id, el);
    });
    el.addEventListener('input', () => onTextInput(o.id, el));
    el.addEventListener('blur', () => {
      el.contentEditable = 'false';
      if (state.editing === o.id) state.editing = null;
    });
  } else if (o.type === 'image') {
    const img = document.createElement('img');
    img.src = o.src;
    el.appendChild(img);
  }

  const handle = document.createElement('div');
  handle.className = 'handle';
  handle.addEventListener('pointerdown', (e) => startDrag(e, o, el, 'resize'));
  el.appendChild(handle);

  el.addEventListener('pointerdown', (e) => {
    if (state.editing === o.id) return;
    startDrag(e, o, el, 'move');
  });

  if (state.selected === o.id) el.classList.add('selected');
  return el;
}

function renderOverlays() {
  const layer = $('#overlayLayer');
  if (!layer) return;
  layer.innerHTML = '';
  overlaysOf(state.page).forEach((o) => layer.appendChild(makeOverlayEl(o)));
  renderElementList();
}

function startEdit(id, el) {
  state.selected = id;
  state.editing = id;
  el.contentEditable = 'true';
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  renderOverlays();
  const again = document.querySelector(`.ov[data-id="${id}"]`);
  if (again) {
    again.contentEditable = 'true';
    again.focus();
    const r2 = document.createRange();
    r2.selectNodeContents(again);
    const s2 = window.getSelection();
    s2.removeAllRanges();
    s2.addRange(r2);
  }
  renderProps();
}

function onTextInput(id, el) {
  const f = findOverlay(id);
  if (!f) return;
  f.o.text = el.textContent;
  if (f.o.varId) {
    const v = varById(f.o.varId);
    if (v) {
      v.value = el.textContent;
      // propagar a TODAS las demás casillas vinculadas
      allOverlays().forEach(({ o }) => {
        if (o.varId === v.id && o.id !== id) {
          o.text = v.value;
          const other = document.querySelector(`.ov[data-id="${o.id}"]`);
          if (other) other.textContent = v.value;
        }
      });
      const inp = document.querySelector(`.var-item[data-vid="${v.id}"] input.vval`);
      if (inp && inp !== document.activeElement) inp.value = v.value;
    }
  }
  renderElementList();
}

function startDrag(e, o, el, mode) {
  if (state.tool !== 'select' && mode === 'move') return;
  e.preventDefault();
  e.stopPropagation();
  selectOverlay(o.id);

  const s = state.zoom;
  const sx = e.clientX, sy = e.clientY;
  const ox = o.x, oy = o.y, ow = o.w, oh = o.h;

  const move = (ev) => {
    const dx = (ev.clientX - sx) / s;
    const dy = (ev.clientY - sy) / s;
    if (mode === 'move') {
      o.x = ox + dx;
      o.y = oy + dy;
    } else {
      o.w = Math.max(6, ow + dx);
      o.h = Math.max(6, oh + dy);
    }
    positionEl(el, o);
    updatePropNumbers(o);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function selectOverlay(id) {
  state.selected = id;
  $$('.ov').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
  renderProps();
  renderElementList();
}

/* ========================= EVENTOS DE LA CAPA ========================= */
function bindLayerEvents(layer) {
  layer.addEventListener('pointerdown', async (e) => {
    if (e.target.closest('.ov')) return;
    const rect = layer.getBoundingClientRect();
    const x = (e.clientX - rect.left) / state.zoom;
    const y = (e.clientY - rect.top) / state.zoom;

    if (state.tool === 'select') {
      state.selected = null;
      $$('.ov').forEach((el) => el.classList.remove('selected'));
      renderProps();
      renderElementList();
      return;
    }

    if (state.tool === 'text') {
      const o = {
        id: uid(), type: 'text', x, y: y - 7, w: 170, h: 22,
        text: '', fontSize: 11, color: '#000000', bold: false, italic: false,
        align: 'left', cover: false, varId: null, fontFamily: 'Helvetica',
      };
      overlaysOf(state.page).push(o);
      renderOverlays();
      selectOverlay(o.id);
      setTimeout(() => {
        const el = document.querySelector(`.ov[data-id="${o.id}"]`);
        if (el) startEdit(o.id, el);
      }, 30);
      return;
    }

    if (state.tool === 'pick') {
      pickTextAt(x, y);
      return;
    }

    if (state.tool === 'erase') {
      const startX = x, startY = y;
      const ghost = document.createElement('div');
      ghost.className = 'ov ov-erase';
      ghost.style.left = x * state.zoom + 'px';
      ghost.style.top = y * state.zoom + 'px';
      ghost.style.width = '0px';
      ghost.style.height = '0px';
      ghost.style.opacity = '.7';
      layer.appendChild(ghost);

      const move = (ev) => {
        const cx = (ev.clientX - rect.left) / state.zoom;
        const cy = (ev.clientY - rect.top) / state.zoom;
        const nx = Math.min(startX, cx), ny = Math.min(startY, cy);
        const nw = Math.abs(cx - startX), nh = Math.abs(cy - startY);
        ghost.style.left = nx * state.zoom + 'px';
        ghost.style.top = ny * state.zoom + 'px';
        ghost.style.width = nw * state.zoom + 'px';
        ghost.style.height = nh * state.zoom + 'px';
      };
      const up = (ev) => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        ghost.remove();
        const cx = (ev.clientX - rect.left) / state.zoom;
        const cy = (ev.clientY - rect.top) / state.zoom;
        const nx = Math.min(startX, cx), ny = Math.min(startY, cy);
        const nw = Math.abs(cx - startX), nh = Math.abs(cy - startY);
        if (nw < 3 || nh < 3) return;
        const o = { id: uid(), type: 'erase', x: nx, y: ny, w: nw, h: nh };
        overlaysOf(state.page).push(o);
        renderOverlays();
        selectOverlay(o.id);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      return;
    }

    if (state.tool === 'image') {
      placeImageAt(x, y);
      return;
    }

    if (state.tool === 'bg') {
      await openBgPanel(x, y);
      return;
    }
  });
}

/* Inserta una imagen usando un input persistente (más fiable en Android) */
let _imgPos = null;
function placeImageAt(x, y) {
  _imgPos = { x, y };
  const inp = $('#imgInput');
  if (!inp) return;
  inp.value = '';
  inp.click();
}

async function onImagePicked(file) {
  if (!file) return;
  const pos = _imgPos || { x: 40, y: 40 };
  try {
    const src = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const img = new Image();
    img.src = src;
    await img.decode();
    const ps = pageSize(state.page);
    const maxW = Math.min(220, ps.w * 0.45);
    let w = Math.min(maxW, img.naturalWidth * 0.75);
    let h = w * (img.naturalHeight / img.naturalWidth);
    if (h > ps.h * 0.6) { h = ps.h * 0.6; w = h * (img.naturalWidth / img.naturalHeight); }
    const o = {
      id: uid(), type: 'image',
      x: clamp(pos.x, 0, Math.max(0, ps.w - w)),
      y: clamp(pos.y, 0, Math.max(0, ps.h - h)),
      w, h, src, srcOrig: src,
    };
    overlaysOf(state.page).push(o);
    renderOverlays();
    selectOverlay(o.id);
    renderElementList();
    toast('Imagen insertada. Arrástrala o redimensiónala.');
  } catch (e) {
    toast('No se pudo insertar la imagen', 'err');
  }
}

/* ========================= TEXTO EXISTENTE (OCR de PDF) ========================= */
async function getTextItems(pageNum) {
  if (state.textCache[pageNum]) {
    // si el PDF no traía texto, intentar con lo que haya reconocido el OCR
    if (state.textCache[pageNum].length === 0 && state.ocrCache[pageNum]) {
      return state.ocrCache[pageNum];
    }
    return state.textCache[pageNum];
  }
  if (!state.doc) return [];

  let items = [];
  if (state.doc.type === 'pdf') {
    const p = await state.doc.pdf.getPage(pageNum);
    const tc = await p.getTextContent();
    const vp = p.getViewport({ scale: 1 });
    tc.items.forEach((it) => {
      if (!it.str || !it.str.trim()) return;
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      const fontSize = Math.hypot(tx[2], tx[3]) || it.height || 10;
      const left = tx[4];
      const baseline = tx[5];
      items.push({
        str: it.str,
        left,
        top: baseline - fontSize * 0.82,
        width: it.width || it.str.length * fontSize * 0.5,
        height: fontSize * 1.2,
        fontSize,
        src: 'pdf',
      });
    });
  }

  state.textCache[pageNum] = items;
  if (items.length === 0 && state.ocrCache[pageNum]) return state.ocrCache[pageNum];
  return items;
}

/* ========================= OCR (Tesseract) ========================= */
function ocrStatus(msg, pct) {
  const box = $('#ocrStatus');
  if (!box) return;
  if (!msg) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = msg + (pct != null
    ? `<div class="obar"><i style="width:${Math.round(pct * 100)}%"></i></div>` : '');
}

async function cargarTesseract() {
  if (typeof Tesseract !== 'undefined') return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = window.TESSERACT_CDN || 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('el lector de texto necesita internet la primera vez'));
    document.head.appendChild(s);
  });
}

async function getOcrWorker() {
  if (state.ocrWorker) return state.ocrWorker;
  ocrStatus('Preparando el reconocimiento de texto…', 0.05);
  await cargarTesseract();
  const worker = await Tesseract.createWorker('spa', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        ocrStatus('Leyendo el texto del documento…', m.progress);
      }
    },
  });
  state.ocrWorker = worker;
  return worker;
}

/* Ejecuta OCR sobre una página y devuelve palabras con coordenadas en puntos PDF */
async function runOcr(pageNum) {
  if (!state.doc) return [];
  if (state.ocrCache[pageNum]) return state.ocrCache[pageNum];

  const ps = pageSize(pageNum);
  const scale = Math.min(3, Math.max(2, 1600 / Math.max(ps.w, ps.h)));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(ps.w * scale);
  canvas.height = Math.round(ps.h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state.doc.type === 'pdf') {
    const p = await state.doc.pdf.getPage(pageNum);
    const vp = p.getViewport({ scale });
    const tmp = document.createElement('canvas');
    tmp.width = Math.round(vp.width);
    tmp.height = Math.round(vp.height);
    await p.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise;
    ctx.drawImage(tmp, 0, 0);
  } else {
    const img = new Image();
    img.src = state.doc.src;
    await img.decode();
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }

  const worker = await getOcrWorker();
  const { data } = await worker.recognize(canvas);

  const words = [];
  const lines = data.lines || [];
  lines.forEach((line, li) => {
    (line.words || []).forEach((w, wi) => {
      const txt = (w.text || '').trim();
      if (!txt) return;
      const b = w.bbox;
      const h = (b.y1 - b.y0) / scale;
      words.push({
        str: txt,
        left: b.x0 / scale,
        top: b.y0 / scale,
        width: (b.x1 - b.x0) / scale,
        height: h,
        fontSize: Math.round(h * 0.82 * 10) / 10,
        line: li,
        wi,
        src: 'ocr',
        conf: w.confidence,
      });
    });
  });

  state.ocrCache[pageNum] = words;
  state.ocrDone[pageNum] = true;
  return words;
}

/* Agrupa palabras OCR en líneas para buscar frases completas */
function ocrLines(words) {
  const byLine = {};
  words.forEach((w) => {
    (byLine[w.line] = byLine[w.line] || []).push(w);
  });
  return Object.keys(byLine).map((k) => {
    const ws = byLine[k].sort((a, b) => a.left - b.left);
    let text = '';
    const offsets = [];
    ws.forEach((w, i) => {
      if (i > 0) text += ' ';
      offsets.push({ start: text.length, w });
      text += w.str;
    });
    return { words: ws, text, offsets };
  });
}

/* Busca todas las apariciones de `target` en las palabras OCR */
function findOcrMatches(words, target) {
  const out = [];
  const t = target.trim();
  if (!t) return out;
  const tWords = t.split(/\s+/);
  const lines = ocrLines(words);

  lines.forEach((line) => {
    const ws = line.words;
    // 1) palabra o frase exacta
    for (let i = 0; i < ws.length; i++) {
      if (ws[i].str.toLowerCase() !== tWords[0].toLowerCase()) continue;
      let ok = true;
      for (let j = 1; j < tWords.length; j++) {
        const cand = ws[i + j];
        if (!cand || cand.str.toLowerCase() !== tWords[j].toLowerCase()) { ok = false; break; }
      }
      if (!ok) continue;
      const first = ws[i];
      const last = ws[i + tWords.length - 1];
      out.push({
        left: first.left,
        top: Math.min(first.top, last.top),
        width: last.left + last.width - first.left,
        height: Math.max(first.height, last.height),
        fontSize: first.fontSize,
      });
    }
    // 2) aparición dentro de una palabra/frase más larga (ej: "Pérez," o "PérezGómez")
    if (tWords.length === 1) {
      ws.forEach((w) => {
        const low = w.str.toLowerCase();
        const tl = t.toLowerCase();
        if (low === tl) return;
        const idx = low.indexOf(tl);
        if (idx === -1) return;
        const charW = w.width / Math.max(w.str.length, 1);
        out.push({
          left: w.left + idx * charW,
          top: w.top,
          width: tl.length * charW,
          height: w.height,
          fontSize: w.fontSize,
        });
      });
    }
  });
  return out;
}

async function ocrCurrentPage(silent) {
  if (!state.doc) { toast('Abre un documento primero.', 'err'); return; }
  const p = state.page;
  if (state.ocrCache[p]) {
    if (!silent) toast('Esta página ya está reconocida.');
    return state.ocrCache[p];
  }
  try {
    ocrStatus('Preparando el reconocimiento de texto…', 0.05);
    const words = await runOcr(p);
    ocrStatus(null);
    if (!silent) {
      toast(words.length
        ? `Texto reconocido: ${words.length} palabras. Ya puedes usar "Editar texto".`
        : 'No se detectó texto en esta página.');
    }
    return words;
  } catch (e) {
    ocrStatus(null);
    console.error(e);
    if (!silent) toast('El OCR falló: ' + e.message, 'err');
    return [];
  }
}

/* Toma el color de fondo real alrededor de una zona (para que el "tapado" no se note) */
function sampleBgColor(x, y, w, h) {
  try {
    const wrap = $('#pageWrap');
    const canvas = wrap.querySelector('canvas');
    let ctx, cw, ch;
    if (canvas) {
      ctx = canvas.getContext('2d');
      cw = canvas.width; ch = canvas.height;
    } else {
      const img = wrap.querySelector('img');
      if (!img) return '#ffffff';
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      ctx = cx; cw = c.width; ch = c.height;
    }
    const s = state.zoom;
    const pts = [];
    // franjas por encima y por debajo del texto (zonas casi siempre de fondo)
    for (let i = 0; i <= 6; i++) {
      const px = x + (w * i) / 6;
      pts.push([px, y - 3]);
      pts.push([px, y + h + 3]);
    }
    // laterales
    pts.push([x - 4, y + h / 2]);
    pts.push([x + w + 4, y + h / 2]);

    const rs = [], gs = [], bs = [];
    pts.forEach(([px, py]) => {
      const cx = Math.round(px * s), cy = Math.round(py * s);
      if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) return;
      const d = ctx.getImageData(cx, cy, 1, 1).data;
      rs.push(d[0]); gs.push(d[1]); bs.push(d[2]);
    });
    if (!rs.length) return '#ffffff';
    const med = (arr) => {
      const a = arr.slice().sort((p, q) => p - q);
      return a[Math.floor(a.length / 2)];
    };
    const hex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + hex(med(rs)) + hex(med(gs)) + hex(med(bs));
  } catch (e) {
    return '#ffffff';
  }
}

/* =========================================================
   COLOR REAL DEL PAPEL  (detección automática al abrir)
   ========================================================= */
function loadImg(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}

function hexToRgbArr(hex) {
  const h = (hex || '#ffffff').replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(s, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbArrToHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

/* Lienzo de la página (respeta la versión limpia / rasterizada) */
async function pageSourceCanvas(pageNum, maxSide) {
  const ps = pageSize(pageNum);
  const scale = maxSide ? Math.min(3, Math.max(0.5, maxSide / Math.max(ps.w, ps.h))) : 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(ps.w * scale));
  c.height = Math.max(1, Math.round(ps.h * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });

  const override = state.doc.type === 'pdf'
    ? state.pageRaster[pageNum]
    : (state.doc.cleanSrc || null);

  if (override) {
    const img = await loadImg(override);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  if (state.doc.type === 'pdf') {
    const p = await state.doc.pdf.getPage(pageNum);
    const vp = p.getViewport({ scale });
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
  } else {
    const img = await loadImg(state.doc.src);
    ctx.drawImage(img, 0, 0, c.width, c.height);
  }
  return c;
}

/* Analiza el color dominante del papel (zonas claras + borde de la hoja) */
function detectPaperFromCanvas(c) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let img;
  try { img = ctx.getImageData(0, 0, c.width, c.height); } catch (e) { return '#ffffff'; }
  const d = img.data;
  const W = c.width, H = c.height;

  const buckets = new Map();
  let total = 0;
  const step = Math.max(1, Math.round(Math.sqrt((W * H) / 220000)));

  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      if (d[i + 3] < 40) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 128) continue;          // el texto/tinta no es papel
      total++;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let e = buckets.get(key);
      if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, e); }
      e.n++; e.r += r; e.g += g; e.b += b;
    }
  }

  // mediana del marco exterior (el borde de la hoja siempre es papel)
  const rs = [], gs = [], bs = [];
  const band = Math.max(2, Math.round(Math.min(W, H) * 0.012));
  const push = (x, y) => {
    const i = (y * W + x) * 4;
    if (d[i + 3] < 40) return;
    rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
  };
  for (let x = 0; x < W; x += 2) {
    for (let k = 0; k < band; k++) { push(x, k); push(x, H - 1 - k); }
  }
  for (let y = 0; y < H; y += 2) {
    for (let k = 0; k < band; k++) { push(k, y); push(W - 1 - k, y); }
  }
  const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)] || 255; };
  const borderHex = rs.length ? rgbArrToHex(med(rs), med(gs), med(bs)) : '#ffffff';

  let best = null;
  buckets.forEach((e) => { if (!best || e.n > best.n) best = e; });
  if (!best || !total || best.n / total < 0.08) return borderHex;

  return rgbArrToHex(best.r / best.n, best.g / best.n, best.b / best.n);
}

async function detectPaperColor(pageNum) {
  try {
    const c = await pageSourceCanvas(pageNum, 820);
    return detectPaperFromCanvas(c);
  } catch (e) {
    console.warn('No se pudo detectar el papel', e);
    return '#ffffff';
  }
}

async function ensurePaper(pageNum, force) {
  if (!state.doc) return;
  if (state.paper[pageNum] && !force) return state.paper[pageNum].color;

  let color = null;
  // reutilizar el lienzo ya renderizado en pantalla (más rápido)
  if (!force && pageNum === state.page) {
    const cv = $('#pageWrap') && $('#pageWrap').querySelector('canvas');
    if (cv && cv.width > 60) {
      try { color = detectPaperFromCanvas(cv); } catch (e) { color = null; }
    }
  }
  if (!color) color = await detectPaperColor(pageNum);

  state.paper[pageNum] = { color, auto: true };
  renderPaperUI();
  return color;
}

function paperColor(pageNum) {
  const p = state.paper[pageNum || state.page];
  return (p && p.color) || '#ffffff';
}

function renderPaperUI() {
  const inp = $('#paperColor');
  if (!inp) return;
  if (!state.doc) {
    inp.value = '#ffffff';
    $('#paperHex').textContent = '#FFFFFF';
    $('#paperState').textContent = 'Abre un documento';
    return;
  }
  const p = state.paper[state.page];
  const col = (p && p.color) || '#ffffff';
  inp.value = col;
  $('#paperHex').textContent = col.toUpperCase();
  $('#paperState').textContent = p
    ? (p.auto ? 'Detectado automáticamente' : 'Ajustado a mano')
    : 'Sin detectar';
  const ex = $('#exPaperVal');
  if (ex) ex.textContent = col.toUpperCase();
}

function setPaperColor(hex, auto) {
  if (!state.doc) return;
  state.paper[state.page] = { color: hex, auto: !!auto };
  renderPaperUI();
  const wrap = $('#pageWrap');
  const tint = wrap && wrap.querySelector('.paper-tint');
  if (tint) tint.style.background = hex;
}

/* Aplica el color real del papel a todos los tapados del documento */
function applyPaperToCovers() {
  if (!state.doc) return;
  let n = 0;
  Object.keys(state.overlays).forEach((pg) => {
    const col = paperColor(Number(pg));
    state.overlays[pg].forEach((o) => {
      if (o.type === 'text' && o.cover) { o.coverColor = col; n++; }
      if (o.type === 'erase') { o.color = col; n++; }
    });
  });
  renderOverlays();
  if (state.selected) renderProps();
  toast(n ? `Color del papel aplicado a ${n} tapado(s) ✔` : 'No hay tapados todavía.');
}

function applyPaperAllPages() {
  if (!state.doc) return;
  const col = paperColor(state.page);
  for (let p = 1; p <= state.doc.numPages; p++) state.paper[p] = { color: col, auto: false };
  renderPaperUI();
  toast('Color aplicado a todas las páginas ✔');
}

function togglePaperPreview(on) {
  state.paperTint = !!on;
  const wrap = $('#pageWrap');
  if (wrap) wrap.classList.toggle('show-paper', state.paperTint);
}

/* =========================================================
   BORRADOR DE FONDO (background eraser)
   ========================================================= */
function boxBlurMask(a, w, h, r) {
  if (r <= 0) return a;
  const tmp = new Float32Array(a.length);
  const win = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  const out = new Float32Array(a.length);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/* Quita de la página el color muestreado (fondo grisáceo, sombras, etc.) */
async function cleanPageBackground(pageNum, targetHex, tol, feather, transparent) {
  const c = await pageSourceCanvas(pageNum, 2400);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const [tr, tg, tb] = hexToRgbArr(targetHex);
  const soft = Math.max(6, tol * 0.6);
  const mask = new Float32Array(c.width * c.height);

  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    if (d[i + 3] === 0) { mask[p] = 1; continue; }
    const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb;
    const dist = Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);
    mask[p] = dist <= tol ? 1 : dist >= tol + soft ? 0 : 1 - (dist - tol) / soft;
  }

  const m = boxBlurMask(mask, c.width, c.height, Math.round(feather));
  const [pr, pg, pb] = hexToRgbArr(paperColor(pageNum));

  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const k = m[p];
    if (k <= 0.004) continue;
    if (transparent) {
      d[i + 3] = Math.round(d[i + 3] * (1 - k));
    } else {
      d[i] = Math.round(d[i] * (1 - k) + pr * k);
      d[i + 1] = Math.round(d[i + 1] * (1 - k) + pg * k);
      d[i + 2] = Math.round(d[i + 2] * (1 - k) + pb * k);
    }
  }

  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL('image/png');
  if (state.doc.type === 'pdf') state.pageRaster[pageNum] = url;
  else state.doc.cleanSrc = url;
  await renderPage();
}

/* Muestrea el color del punto donde el usuario hace clic */
async function openBgPanel(x, y) {
  if (!state.doc) return;
  const ps = pageSize(state.page);
  const c = await pageSourceCanvas(state.page, 1600);
  const sc = c.width / ps.w;
  const px = clamp(Math.round(x * sc), 0, c.width - 1);
  const py = clamp(Math.round(y * sc), 0, c.height - 1);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const r = 4;
  const box = ctx.getImageData(clamp(px - r, 0, c.width - 1), clamp(py - r, 0, c.height - 1),
    Math.min(r * 2 + 1, c.width), Math.min(r * 2 + 1, c.height)).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < box.length; i += 4) { R += box[i]; G += box[i + 1]; B += box[i + 2]; n++; }
  const hex = n ? rgbArrToHex(R / n, G / n, B / n) : '#ffffff';

  state.bgPick = { color: hex, page: state.page };
  $('#bgpSwatch').style.background = hex;
  $('#bgpInfo').textContent = `Muestreado ${hex.toUpperCase()} · pág. ${state.page}`;
  $('#bgPanel').hidden = false;
  toast('Ajusta la tolerancia y pulsa Aplicar.');
}

async function applyBgPanel() {
  if (!state.bgPick) return;
  const tol = parseInt($('#bgpTol').value, 10) || 26;
  const feather = parseInt($('#bgpFeather').value, 10) || 0;
  const transparent = $('#bgpTransparent').checked;
  $('#bgPanel').hidden = true;
  toast('Quitando fondo…');
  try {
    await cleanPageBackground(state.bgPick.page, state.bgPick.color, tol, feather, transparent);
    toast('Fondo quitado ✔');
  } catch (e) {
    console.error(e);
    toast('No se pudo quitar el fondo', 'err');
  }
}

/* Quita el fondo de una foto/firma insertada (flood fill desde los bordes) */
async function removeImageBg(o, tol, mode) {
  const img = await loadImg(o.src);
  const maxSide = 1500;
  const sc = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * sc));
  const h = Math.max(1, Math.round(img.naturalHeight * sc));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // color de fondo = mediana del marco
  const rs = [], gs = [], bs = [];
  for (let x = 0; x < w; x++) { [0, h - 1].forEach((y) => { const i = (y * w + x) * 4; rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]); }); }
  for (let y = 0; y < h; y++) { [0, w - 1].forEach((x) => { const i = (y * w + x) * 4; rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]); }); }
  const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)] || 255; };
  const br = med(rs), bg = med(gs), bb = med(bs);

  const tol2 = tol * tol * 3;
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, 0, x, h - 1); }
  for (let y = 0; y < h; y++) { stack.push(0, y, w - 1, y); }

  const mask = new Float32Array(w * h);
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = y * w + x;
    if (seen[p]) continue;
    const i = p * 4;
    const dr = d[i] - br, dg = d[i + 1] - bg, db = d[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > tol2) continue;
    seen[p] = 1;
    mask[p] = 1;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }

  const m = boxBlurMask(mask, w, h, 2);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const k = m[p];
    if (k <= 0.004) continue;
    if (mode === 'white') {
      d[i] = Math.round(d[i] * (1 - k) + 255 * k);
      d[i + 1] = Math.round(d[i + 1] * (1 - k) + 255 * k);
      d[i + 2] = Math.round(d[i + 2] * (1 - k) + 255 * k);
    } else {
      d[i + 3] = Math.round(d[i + 3] * (1 - k));
    }
  }
  ctx.putImageData(imgData, 0, 0);

  if (!o.srcOrig) o.srcOrig = o.src;
  o.src = c.toDataURL('image/png');
  renderOverlays();
  if (state.selected === o.id) renderProps();
}

/* =========================================================
   IMPRIMIR (tal como se verá en papel)
   ========================================================= */
async function printDoc() {
  if (!state.doc) { toast('Abre un documento primero.', 'err'); return; }
  const area = $('#printArea');
  area.innerHTML = '';
  toast('Preparando impresión…');
  for (let p = 1; p <= state.doc.numPages; p++) {
    const c = await renderFlattenedCanvas(p, 2, true);
    const img = document.createElement('img');
    img.src = c.toDataURL('image/jpeg', 0.95);
    area.appendChild(img);
  }
  await new Promise((r) => setTimeout(r, 350));
  window.print();
}

function hitTest(items, x, y) {
  let best = null;
  let bestArea = Infinity;
  items.forEach((it) => {
    const pad = 3;
    if (x >= it.left - pad && x <= it.left + it.width + pad &&
        y >= it.top - pad && y <= it.top + it.height + pad) {
      const area = it.width * it.height;
      if (area < bestArea) { bestArea = area; best = it; }
    }
  });
  return best;
}

/* ---------- Campos típicos de un documento de identidad ---------- */
const FIELDS = [
  { key: 'nombre_completo', label: 'Nombres y apellidos',
    re: /(nombres?\s*(y|e)\s*apellidos?|nombre\s*completo)/i },
  { key: 'lugar_nacimiento', label: 'Lugar de nacimiento',
    re: /(lugar\s*(de)?\s*nacimiento)/i },
  { key: 'fecha_nacimiento', label: 'Fecha de nacimiento',
    re: /(fecha\s*(de)?\s*nacimiento|f\.?\s*nacimiento|nacimiento)/i },
  { key: 'fecha_expedicion', label: 'Fecha de expedición',
    re: /(fecha\s*(de)?\s*(expedici[oó]n|expedida|expedido)|f\.?\s*expedici[oó]n|expedici[oó]n)/i },
  { key: 'fecha', label: 'Fecha', re: /\bfecha\b/i },
  { key: 'nombres', label: 'Nombres',
    re: /\b(primer\s*nombre|segundo\s*nombre|nombres?)\b/i },
  { key: 'apellidos', label: 'Apellidos',
    re: /\b(primer\s*apellido|segundo\s*apellido|apellidos?)\b/i },
  { key: 'cedula', label: 'Número de cédula',
    re: /\b(c[eé]dula|cedula|n[uú]mero\s*de\s*c[eé]dula|documento(\s*de\s*identidad)?|identificaci[oó]n|dni|rut|pasaporte|\bcc\b)\b/i },
  { key: 'direccion', label: 'Dirección',
    re: /(direcci[oó]n|domicilio|residencia|direcci[oó]n\s*de\s*residencia)/i },
  { key: 'telefono', label: 'Teléfono',
    re: /(tel[eé]fono|celular|m[oó]vil|whatsapp)/i },
  { key: 'correo', label: 'Correo electrónico',
    re: /(correo|e-?mail)/i },
  { key: 'sexo', label: 'Sexo',
    re: /\b(sexo|g[eé]nero)\b/i },
  { key: 'estado_civil', label: 'Estado civil',
    re: /(estado\s*civil)/i },
  { key: 'nacionalidad', label: 'Nacionalidad', re: /nacionalidad/i },
  { key: 'profesion', label: 'Profesión',
    re: /(profesi[oó]n|ocupaci[oó]n|oficio)/i },
  { key: 'edad', label: 'Edad', re: /\bedad\b/i },
];

function fieldFromText(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 70) return null;
  for (const f of FIELDS) if (f.re.test(s)) return f;
  return null;
}

/* ¿El texto es SOLO una etiqueta (no un valor)? */
function isLabelOnly(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  const f = fieldFromText(s);
  if (!f) return false;
  // "Nombres: JUAN" no es solo etiqueta; "Nombres:" sí lo es
  return s.length <= 45 && !/[:]\s*\S/.test(s);
}

/* Busca a qué campo pertenece un texto capturado, mirando alrededor */
function detectFieldForItem(items, it) {
  const self = fieldFromText(it.str);
  if (self) return self;

  const cy = it.top + it.height / 2;
  const sameLine = items.filter((o) => o !== it &&
    Math.abs((o.top + o.height / 2) - cy) < Math.max(it.height, o.height) * 0.75 &&
    o.left + o.width <= it.left + 3)
    .sort((a, b) => b.left - a.left);
  for (const o of sameLine.slice(0, 3)) {
    const f = fieldFromText(o.str);
    if (f) return f;
  }

  const above = items.filter((o) => o !== it &&
    o.top + o.height <= it.top + 4 &&
    o.top + o.height >= it.top - it.height * 2.4)
    .sort((a, b) => b.top - a.top);
  for (const o of above.slice(0, 4)) {
    const f = fieldFromText(o.str);
    if (f) return f;
  }
  return null;
}

/* Cajas de VALOR asociadas a una etiqueta de campo en una página */
function fieldValueBoxes(items, fieldKey) {
  const out = [];
  const seen = [];
  const add = (b) => {
    if (!b || !b.orig) return;
    if (seen.some((s) => Math.abs(s.x - b.x) < 3 && Math.abs(s.y - b.y) < 3)) return;
    seen.push(b); out.push(b);
  };

  items.forEach((it) => {
    const f = fieldFromText(it.str);
    if (!f || f.key !== fieldKey) return;

    // 1) etiqueta y valor en el mismo texto: "Nombres: JUAN PEREZ"
    const m = it.str.match(/^([^:]{2,60}):\s*(.+)$/);
    if (m) {
      const val = m[2].trim();
      if (val && !isLabelOnly(val)) {
        const idx = it.str.indexOf(val);
        const cw = it.width / Math.max(it.str.length, 1);
        add({ x: it.left + idx * cw, y: it.top, w: Math.max(val.length * cw, 12),
              h: it.height, fs: it.fontSize, orig: val });
      }
      return;
    }

    // 2) valor en otra caja del mismo renglón (a la derecha)
    const cy = it.top + it.height / 2;
    const right = items.filter((o) => o !== it &&
      Math.abs((o.top + o.height / 2) - cy) < Math.max(it.height, o.height) * 0.8 &&
      o.left >= it.left + it.width - 4)
      .sort((a, b) => a.left - b.left);
    if (right.length) {
      const first = right[0];
      const val = first.str.trim();
      if (val && !isLabelOnly(val)) {
        add({ x: first.left, y: first.top, w: first.width, h: first.height,
              fs: first.fontSize, orig: val });
      }
      return;
    }

    // 3) valor en la línea de abajo, alineado con la etiqueta
    const below = items.filter((o) => o !== it &&
      o.top > it.top + it.height * 0.5 && o.top < it.top + it.height * 2.8 &&
      Math.abs(o.left - it.left) < 60)
      .sort((a, b) => a.top - b.top);
    if (below.length) {
      const b = below[0];
      const val = b.str.trim();
      if (val && !isLabelOnly(val)) {
        add({ x: b.left, y: b.top, w: b.width, h: b.height, fs: b.fontSize, orig: val });
      }
    }
  });
  return out;
}

async function pickTextAt(x, y) {
  let items = await getTextItems(state.page);
  let best = hitTest(items, x, y);

  // Si el PDF no tiene texto ahí (escaneo), usar OCR
  if (!best) {
    const words = state.ocrCache[state.page] || await ocrCurrentPage(true);
    if (words && words.length) best = hitTest(words, x, y);
  }

  if (!best) {
    toast('No se detectó texto ahí. Prueba con la herramienta Texto.', 'err');
    return;
  }

  // Si se tocó la ETIQUETA ("Nombre completo:"), capturar la casilla del VALOR
  if (isLabelOnly(best.str)) {
    const cy = best.top + best.height / 2;
    const right = items.filter((o) => o !== best &&
      Math.abs((o.top + o.height / 2) - cy) < Math.max(best.height, o.height) * 0.8 &&
      o.left >= best.left + best.width - 6)
      .sort((a, b) => a.left - b.left);
    if (right.length && !isLabelOnly(right[0].str)) {
      best = right[0];
    } else {
      const below = items.filter((o) => o !== best &&
        o.top > best.top + best.height * 0.5 && o.top < best.top + best.height * 2.8 &&
        Math.abs(o.left - best.left) < 80).sort((a, b) => a.top - b.top);
      if (below.length && !isLabelOnly(below[0].str)) best = below[0];
    }
  }

  const lineText = best.str.trim();
  const field = detectFieldForItem(items, best);

  // Si la línea es "Etiqueta: VALOR", se captura solo el VALOR
  let original = lineText;
  let bx = best.left, bw = best.width;
  const m = lineText.match(/^([^:]{2,60}):\s*(.+)$/);
  if (m && m[2].trim()) {
    const val = m[2].trim();
    const idx = lineText.indexOf(val);
    const cw = best.width / Math.max(lineText.length, 1);
    original = val;
    bx = best.left + idx * cw;
    bw = Math.max(val.length * cw, 12);
  }

  const bg = sampleBgColor(bx, best.top, bw, best.height);

  // Reutilizar el dato del mismo CAMPO (nombres→nombres), no por valor suelto
  let v = field ? state.vars.find((vv) => vv.field === field.key) : null;
  if (!v) v = state.vars.find((vv) => !vv.field && vv.value.trim() === original && original !== '');

  const o = {
    id: uid(), type: 'text',
    x: bx, y: best.top,
    w: Math.max(bw + 4, 20), h: Math.max(best.height, 10),
    text: original, origText: original,
    fontSize: Math.round(best.fontSize * 10) / 10,
    color: '#000000', bold: false, italic: false,
    align: 'left', cover: true, coverColor: bg,
    varId: v ? v.id : null,
    fieldKey: field ? field.key : null,
    fieldLabel: field ? field.label : null,
    fontFamily: 'Helvetica',
  };
  overlaysOf(state.page).push(o);
  renderOverlays();
  selectOverlay(o.id);

  await linkAllOccurrences(o.id, true);
}

/* ========================= VARIABLES / DATOS ========================= */
function addVar(key, value) {
  const v = { id: uid(), key: key || slugKey('dato'), value: value || '' };
  state.vars.push(v);
  renderVars();
  renderProps();
  return v;
}

function setVarValue(vid, value) {
  const v = varById(vid);
  if (!v) return;
  v.value = value;
  allOverlays().forEach(({ o }) => {
    if (o.varId === vid) {
      o.text = value;
      const el = document.querySelector(`.ov[data-id="${o.id}"]`);
      if (el && state.editing !== o.id) el.textContent = value;
    }
  });
  renderElementList();
}

function renameVar(vid, key) {
  const v = varById(vid);
  if (!v) return;
  v.key = key;
  renderOverlays();
  renderProps();
}

function deleteVar(vid) {
  state.vars = state.vars.filter((v) => v.id !== vid);
  allOverlays().forEach(({ o }) => { if (o.varId === vid) o.varId = null; });
  renderVars();
  renderOverlays();
  renderProps();
}

function bindOverlayToVar(oid, vid) {
  const f = findOverlay(oid);
  if (!f) return;
  f.o.varId = vid || null;
  if (vid) {
    const v = varById(vid);
    if (v) {
      if (!v.value) { v.value = f.o.text; }
      else { f.o.text = v.value; }
      renderVars();
    }
  }
  renderOverlays();
  renderProps();
}

async function linkAllOccurrences(oid, silent) {
  const f = findOverlay(oid);
  if (!f) return;
  const o = f.o;
  const target = (o.origText || o.text || '').trim();
  if (!target) { toast('Este elemento no tiene texto de referencia.', 'err'); return; }

  // Campo del dato (nombres, apellidos, cédula, fechas…)
  let fieldKey = o.fieldKey || null;
  let fieldLabel = o.fieldLabel || null;
  if (!fieldKey) {
    const items = await getTextItems(f.page);
    const field = detectFieldForItem(items, { str: o.origText || o.text, left: o.x, top: o.y, width: o.w, height: o.h });
    if (field) { fieldKey = field.key; fieldLabel = field.label; }
    o.fieldKey = fieldKey; o.fieldLabel = fieldLabel;
  }

  let vid = o.varId;
  if (!vid) {
    const key = fieldKey || slugKey(target);
    let v = fieldKey ? state.vars.find((vv) => vv.field === fieldKey) : null;
    if (!v) v = addVar(key, o.text);
    if (fieldKey) { v.field = fieldKey; v.label = fieldLabel; v.key = fieldKey; }
    vid = v.id;
    o.varId = vid;
  } else if (fieldKey) {
    const v = varById(vid);
    if (v && !v.field) { v.field = fieldKey; v.label = fieldLabel; v.key = fieldKey; }
  }

  let added = 0;
  const push = (p, x, y, w, h, fs, orig) => {
    const exists = overlaysOf(p).some((c) => {
      if (c.type !== 'text') return false;
      if (Math.abs(c.x - x) < 2.5 && Math.abs(c.y - y) < 2.5) return true;
      const ox = Math.max(0, Math.min(c.x + c.w, x + w) - Math.max(c.x, x));
      const oy = Math.max(0, Math.min(c.y + c.h, y + h) - Math.max(c.y, y));
      return (ox * oy) > Math.min(c.w * c.h, Math.max(w * h, 1)) * 0.45;
    });
    if (exists) return;
    const samePage = p === state.page;
    const bg = samePage ? sampleBgColor(x, y, w, h) : '#ffffff';
    overlaysOf(p).push({
      id: uid(), type: 'text',
      x, y, w: Math.max(w + 4, 20), h: Math.max(h, 10),
      text: o.text, origText: orig,
      fontSize: Math.round(fs * 10) / 10,
      color: o.color, bold: o.bold, italic: o.italic,
      align: 'left', cover: true, coverColor: bg,
      varId: vid, fontFamily: o.fontFamily,
      fieldKey, fieldLabel,
    });
    added++;
  };

  // Valor actual del dato (para buscar apariciones dentro de frases)
  const value = (varById(vid) ? varById(vid).value : o.text) || target;

  for (let p = 1; p <= state.doc.numPages; p++) {
    const items = await getTextItems(p);

    // --- páginas escaneadas: buscar en el texto reconocido por OCR ---
    if (items.length === 0) {
      const words = state.ocrCache[p] || await runOcr(p).catch(() => []);
      if (words && words.length) {
        if (fieldKey) {
          fieldValueBoxes(words, fieldKey).forEach((b) =>
            push(p, b.x, b.y, b.w, b.h, b.fs, b.orig));
        }
        if (value && value.length >= 3) {
          findOcrMatches(words, value).forEach((mm) =>
            push(p, mm.left, mm.top, mm.width, mm.height, mm.fontSize, value));
        }
        continue;
      }
    }

    // 1) Casillas del MISMO campo (etiqueta → valor)
    if (fieldKey) {
      fieldValueBoxes(items, fieldKey).forEach((b) =>
        push(p, b.x, b.y, b.w, b.h, b.fs, b.orig));
    }

    // 2) El mismo VALOR dentro de frases ("Yo, JUAN PEREZ, declaro…")
    if (value && value.length >= 3) {
      items.forEach((it) => {
        const str = it.str;
        if (!str.includes(value)) return;
        if (isLabelOnly(str)) return;
        const charW = it.width / Math.max(str.length, 1);
        let idx = str.indexOf(value);
        while (idx !== -1) {
          const before = idx > 0 ? str[idx - 1] : ' ';
          const after = idx + value.length < str.length ? str[idx + value.length] : ' ';
          const bounded = !/[A-Za-z0-9ÁÉÍÓÚáéíóúÑñ]/.test(before) &&
                          !/[A-Za-z0-9ÁÉÍÓÚáéíóúÑñ]/.test(after);
          if (bounded) {
            push(p, it.left + idx * charW, it.top, value.length * charW, it.height,
                 it.fontSize, value);
          }
          idx = str.indexOf(value, idx + 1);
        }
      });
    }

    // 3) Sin campo conocido: solo coincidencias exactas del valor
    if (!fieldKey) {
      items.forEach((it) => {
        const str = it.str.trim();
        if (str !== target) return;
        if (isLabelOnly(str)) return;
        push(p, it.left, it.top, it.width, it.height, it.fontSize, str);
      });
    }
  }

  renderOverlays();
  renderVars();
  renderProps();
  if (!silent) {
    toast(added
      ? `Vinculadas ${added} casilla(s) más de "${fieldLabel || value}". Se actualizan juntas.`
      : 'No se encontraron más apariciones de este dato.');
  } else if (added) {
    const v = varById(vid);
    toast(`Dato "${(v && (v.label || v.key)) || value}" vinculado en ${added + 1} lugar(es).`);
  } else {
    toast('Texto capturado. Escribe en "Datos del documento" para cambiarlo.');
  }
}

/* ========================= PANEL DE DATOS ========================= */
function renderVars() {
  const list = $('#varList');
  $('#varCount').textContent = state.vars.length;
  if (!state.vars.length) {
    list.innerHTML = '<p class="empty">Sin datos todavía. Crea uno o captura un texto del documento.</p>';
    return;
  }
  list.innerHTML = '';
  state.vars.forEach((v) => {
    const n = allOverlays().filter(({ o }) => o.varId === v.id).length;
    const div = document.createElement('div');
    div.className = 'var-item';
    div.dataset.vid = v.id;
    div.innerHTML = `
      <div class="vhead">
        <input class="vkey" value="${escapeAttr(v.label || v.key)}" title="Nombre del dato" />
        <button class="vdel" title="Eliminar dato">×</button>
      </div>
      <input class="vval" value="${escapeAttr(v.value)}" placeholder="Escribe el valor…" />
      <div class="var-count">${n} casilla${n === 1 ? '' : 's'} vinculada${n === 1 ? '' : 's'}</div>
    `;
    div.querySelector('.vkey').addEventListener('change', (e) => {
      const nv = e.target.value.trim();
      v.label = nv || v.label;
      renameVar(v.id, nv || v.key);
    });
    div.querySelector('.vval').addEventListener('input', (e) => setVarValue(v.id, e.target.value));
    div.querySelector('.vdel').addEventListener('click', () => deleteVar(v.id));
    list.appendChild(div);
  });
}

function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ========================= LISTA DE ELEMENTOS ========================= */
function renderElementList() {
  const box = $('#elementList');
  const items = allOverlays();
  if (!items.length) {
    box.innerHTML = '<p class="empty">Aún no hay elementos.</p>';
    return;
  }
  box.innerHTML = '';
  items.forEach(({ o, page }) => {
    const div = document.createElement('div');
    div.className = 'el-item' + (state.selected === o.id ? ' active' : '');
    let label = '';
    let color = '#64748b';
    if (o.type === 'text') {
      label = o.text ? o.text.slice(0, 26) : '(texto vacío)';
      color = o.varId ? '#22c55e' : '#3b82f6';
    } else if (o.type === 'erase') {
      label = 'Zona borrada';
      color = '#ef4444';
    } else {
      label = 'Imagen';
      color = '#a855f7';
    }
    div.innerHTML = `<span class="dot" style="background:${color}"></span>
      <span class="lbl">${escapeAttr(label)}</span>
      <span class="pg">p.${page}</span>`;
    div.addEventListener('click', async () => {
      if (page !== state.page) {
        state.page = page;
        $('#pageNum').value = page;
        await renderPage();
      }
      selectOverlay(o.id);
    });
    box.appendChild(div);
  });
}

/* ========================= PROPIEDADES ========================= */
function renderProps() {
  const box = $('#props');
  const f = state.selected ? findOverlay(state.selected) : null;
  if (!f) {
    box.innerHTML = '<p class="empty">Selecciona un elemento del documento.</p>';
    return;
  }
  const o = f.o;

  if (o.type === 'text') {
    const varOptions = ['<option value="">— sin vincular —</option>']
      .concat(state.vars.map((v) => `<option value="${v.id}" ${o.varId === v.id ? 'selected' : ''}>${escapeAttr(v.key)}</option>`))
      .join('');
    const v = o.varId ? varById(o.varId) : null;

    box.innerHTML = `
      <div class="prop-title">Contenido</div>
      <textarea id="pText" rows="2" style="width:100%;background:#0d1219;border:1px solid #2b3542;color:#fff;border-radius:6px;padding:6px 8px;font-size:12px;resize:vertical;">${escapeAttr(o.text)}</textarea>
      <div class="prop" style="margin-top:8px;">
        <label>Dato</label>
        <select id="pVar">${varOptions}</select>
      </div>
      ${v ? `<div class="chips"><span class="chip">🔗 ${escapeAttr(v.key)}</span></div>` : ''}
      <button class="btn small full" id="pCreateVar">Crear dato con este texto</button>
      <button class="btn small full" id="pLinkAll">Vincular todas las apariciones iguales</button>
      <div class="prop-sep"></div>
      <div class="prop-title">Formato</div>
      <div class="prop"><label>Tamaño</label><input type="number" id="pSize" value="${o.fontSize}" step="0.5" min="4" /></div>
      <div class="prop"><label>Color</label><input type="color" id="pColor" value="${o.color}" /></div>
      <div class="prop"><label>Fuente</label>
        <select id="pFont">
          <option value="Helvetica" ${o.fontFamily === 'Helvetica' ? 'selected' : ''}>Helvetica</option>
          <option value="Times" ${o.fontFamily === 'Times' ? 'selected' : ''}>Times</option>
          <option value="Courier" ${o.fontFamily === 'Courier' ? 'selected' : ''}>Courier</option>
        </select>
      </div>
      <div class="prop"><label>Negrita</label><input type="checkbox" id="pBold" ${o.bold ? 'checked' : ''} /></div>
      <div class="prop"><label>Cursiva</label><input type="checkbox" id="pItalic" ${o.italic ? 'checked' : ''} /></div>
      <div class="prop"><label>Alinear</label>
        <select id="pAlign">
          <option value="left" ${o.align === 'left' ? 'selected' : ''}>Izquierda</option>
          <option value="center" ${o.align === 'center' ? 'selected' : ''}>Centro</option>
          <option value="right" ${o.align === 'right' ? 'selected' : ''}>Derecha</option>
        </select>
      </div>
      <div class="prop"><label>Tapar orig.</label><input type="checkbox" id="pCover" ${o.cover ? 'checked' : ''} /></div>
      <div class="prop-sep"></div>
      <div class="prop-title">Posición y tamaño</div>
      <div class="prop"><label>X</label><input type="number" id="pX" value="${Math.round(o.x)}" /></div>
      <div class="prop"><label>Y</label><input type="number" id="pY" value="${Math.round(o.y)}" /></div>
      <div class="prop"><label>Ancho</label><input type="number" id="pW" value="${Math.round(o.w)}" /></div>
      <div class="prop"><label>Alto</label><input type="number" id="pH" value="${Math.round(o.h)}" /></div>
      <div class="prop-sep"></div>
      <button class="btn small full danger" id="pDelete">Eliminar elemento</button>
    `;

    const refresh = () => { renderOverlays(); };
    $('#pText').addEventListener('input', (e) => {
      o.text = e.target.value;
      if (o.varId) setVarValue(o.varId, o.text);
      refresh();
    });
    $('#pVar').addEventListener('change', (e) => bindOverlayToVar(o.id, e.target.value));
    $('#pCreateVar').addEventListener('click', () => {
      const v2 = addVar(slugKey(o.origText || o.text), o.text);
      o.varId = v2.id;
      renderOverlays();
      renderProps();
      toast('Dato creado: ' + v2.key);
    });
    $('#pLinkAll').addEventListener('click', () => linkAllOccurrences(o.id));
    $('#pSize').addEventListener('input', (e) => { o.fontSize = parseFloat(e.target.value) || 10; refresh(); });
    $('#pColor').addEventListener('input', (e) => { o.color = e.target.value; refresh(); });
    $('#pFont').addEventListener('change', (e) => { o.fontFamily = e.target.value; refresh(); });
    $('#pBold').addEventListener('change', (e) => { o.bold = e.target.checked; refresh(); });
    $('#pItalic').addEventListener('change', (e) => { o.italic = e.target.checked; refresh(); });
    $('#pAlign').addEventListener('change', (e) => { o.align = e.target.value; refresh(); });
    $('#pCover').addEventListener('change', (e) => { o.cover = e.target.checked; refresh(); });
    ['X','Y','W','H'].forEach((k) => {
      const key = { X: 'x', Y: 'y', W: 'w', H: 'h' }[k];
      $('#p' + k).addEventListener('input', (e) => {
        o[key] = parseFloat(e.target.value) || 0;
        refresh();
      });
    });
    $('#pDelete').addEventListener('click', () => deleteOverlay(o.id));

  } else if (o.type === 'erase') {
    box.innerHTML = `
      <div class="prop-title">Zona borrada</div>
      <p class="hint">Cubre el contenido original con blanco al exportar.</p>
      <div class="prop"><label>X</label><input type="number" id="pX" value="${Math.round(o.x)}" /></div>
      <div class="prop"><label>Y</label><input type="number" id="pY" value="${Math.round(o.y)}" /></div>
      <div class="prop"><label>Ancho</label><input type="number" id="pW" value="${Math.round(o.w)}" /></div>
      <div class="prop"><label>Alto</label><input type="number" id="pH" value="${Math.round(o.h)}" /></div>
      <div class="prop-sep"></div>
      <button class="btn small full danger" id="pDelete">Eliminar</button>
    `;
    ['X','Y','W','H'].forEach((k) => {
      const key = { X: 'x', Y: 'y', W: 'w', H: 'h' }[k];
      $('#p' + k).addEventListener('input', (e) => {
        o[key] = parseFloat(e.target.value) || 0;
        renderOverlays();
      });
    });
    $('#pDelete').addEventListener('click', () => deleteOverlay(o.id));

  } else {
    box.innerHTML = `
      <div class="prop-title">Imagen</div>
      <div class="prop"><label>X</label><input type="number" id="pX" value="${Math.round(o.x)}" /></div>
      <div class="prop"><label>Y</label><input type="number" id="pY" value="${Math.round(o.y)}" /></div>
      <div class="prop"><label>Ancho</label><input type="number" id="pW" value="${Math.round(o.w)}" /></div>
      <div class="prop"><label>Alto</label><input type="number" id="pH" value="${Math.round(o.h)}" /></div>
      <div class="prop-sep"></div>
      <div class="prop-title">Quitar fondo</div>
      <p class="hint">Para fotos y firmas: elimina el fondo de la imagen insertada.</p>
      <div class="prop"><label>Tolerancia</label><input type="range" id="pImgTol" min="8" max="90" value="30" /></div>
      <button class="btn small full" id="pImgBg">Fondo transparente</button>
      <button class="btn small full" id="pImgBgWhite">Fondo blanco</button>
      <button class="btn small full" id="pImgRestore" ${o.srcOrig ? '' : 'disabled'}>Restaurar original</button>
      <div class="prop-sep"></div>
      <button class="btn small full danger" id="pDelete">Eliminar</button>
    `;
    ['X','Y','W','H'].forEach((k) => {
      const key = { X: 'x', Y: 'y', W: 'w', H: 'h' }[k];
      $('#p' + k).addEventListener('input', (e) => {
        o[key] = parseFloat(e.target.value) || 0;
        renderOverlays();
      });
    });
    $('#pImgBg').addEventListener('click', async () => {
      toast('Quitando fondo…');
      await removeImageBg(o, parseInt($('#pImgTol').value, 10) || 30, 'transparent');
      toast('Fondo quitado ✔');
    });
    $('#pImgBgWhite').addEventListener('click', async () => {
      toast('Quitando fondo…');
      await removeImageBg(o, parseInt($('#pImgTol').value, 10) || 30, 'white');
      toast('Fondo blanco aplicado ✔');
    });
    $('#pImgRestore').addEventListener('click', () => {
      if (!o.srcOrig) return;
      o.src = o.srcOrig;
      o.srcOrig = null;
      renderOverlays();
      renderProps();
      toast('Imagen original restaurada.');
    });
    $('#pDelete').addEventListener('click', () => deleteOverlay(o.id));
  }
}

function updatePropNumbers(o) {
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = Math.round(v); };
  set('#pX', o.x); set('#pY', o.y); set('#pW', o.w); set('#pH', o.h);
}

function deleteOverlay(id) {
  const f = findOverlay(id);
  if (!f) return;
  state.overlays[f.page] = state.overlays[f.page].filter((o) => o.id !== id);
  state.selected = null;
  renderOverlays();
  renderProps();
}

/* ========================= EXPORTAR A IMAGEN ========================= */
const FONT_MAP = {
  Helvetica: 'Arial, Helvetica, sans-serif',
  Times: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};

/* Dibuja todos los overlays de una página sobre un canvas ya renderizado */
function drawOverlaysOnCanvas(ctx, pageNum, scale) {
  const list = overlaysOf(pageNum);
  if (!list.length) return;

  // 1) zonas borradas
  list.filter((o) => o.type === 'erase').forEach((o) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(o.x * scale, o.y * scale, o.w * scale, o.h * scale);
  });

  // 2) imágenes
  list.filter((o) => o.type === 'image').forEach((o) => {
    if (!o._imgEl) {
      const im = new Image();
      im.src = o.src;
      o._imgEl = im;
    }
    if (o._imgEl.complete && o._imgEl.naturalWidth) {
      ctx.drawImage(o._imgEl, o.x * scale, o.y * scale, o.w * scale, o.h * scale);
    }
  });

  // 3) textos
  list.filter((o) => o.type === 'text').forEach((o) => {
    const text = o.varId ? (varById(o.varId)?.value ?? o.text) : o.text;
    if (!text) return;

    const size = o.fontSize * scale;
    ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${size}px ${FONT_MAP[o.fontFamily] || FONT_MAP.Helvetica}`;
    ctx.textBaseline = 'alphabetic';

    const lines = String(text).split('\n');
    const lh = size * 1.18;

    // tapado ajustado al texto nuevo
    if (o.cover) {
      let needW = o.w * scale;
      lines.forEach((ln) => {
        needW = Math.max(needW, ctx.measureText(ln).width + 3 * scale);
      });
      const needH = Math.max(o.h * scale, lines.length * lh + scale);
      ctx.fillStyle = o.coverColor || '#ffffff';
      ctx.fillRect(o.x * scale - scale, o.y * scale, needW + 2 * scale, needH);
    }

    ctx.fillStyle = o.color || '#000000';
    lines.forEach((ln, i) => {
      if (!ln) return;
      const tw = ctx.measureText(ln).width;
      let tx = o.x * scale;
      if (o.align === 'center') tx = o.x * scale + (o.w * scale - tw) / 2;
      else if (o.align === 'right') tx = o.x * scale + o.w * scale - tw;
      const ty = o.y * scale + size * 0.82 + i * lh;
      ctx.fillText(ln, tx, ty);
    });
  });
}

/* Renderiza una página completa (documento + ediciones) a un canvas */
async function renderFlattenedCanvas(pageNum, scale, paperBg) {
  const ps = pageSize(pageNum);
  scale = escalaSegura(ps, scale);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(ps.w * scale);
  canvas.height = Math.round(ps.h * scale);
  const ctx = canvas.getContext('2d');

  const paper = paperColor(pageNum);
  ctx.fillStyle = paperBg ? paper : '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const override = state.doc.type === 'pdf'
    ? state.pageRaster[pageNum]
    : (state.doc.cleanSrc || null);

  if (override) {
    const img = await loadImg(override);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  } else if (state.doc.type === 'pdf') {
    const p = await state.doc.pdf.getPage(pageNum);
    const vp = p.getViewport({ scale });
    const tmp = document.createElement('canvas');
    tmp.width = Math.round(vp.width);
    tmp.height = Math.round(vp.height);
    await p.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise;
    ctx.drawImage(tmp, 0, 0);
  } else {
    const img = new Image();
    img.src = state.doc.src;
    await img.decode();
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }

  // Tinte realista: multiplica el blanco del escaneo por el color del papel
  if (paperBg && paper.toLowerCase() !== '#ffffff') {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  // precargar imágenes de overlays
  const imgs = overlaysOf(pageNum).filter((o) => o.type === 'image');
  await Promise.all(imgs.map((o) => new Promise((res) => {
    if (o._imgEl && o._imgEl.complete) return res();
    const im = new Image();
    im.onload = () => { o._imgEl = im; res(); };
    im.onerror = () => res();
    im.src = o.src;
  })));

  drawOverlaysOnCanvas(ctx, pageNum, scale);
  return canvas;
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((res) => canvas.toBlob(res, mime, quality));
}

function downloadBlob(blob, filename) {
  // Dentro del APK no hay gestor de descargas: se guarda con el puente nativo.
  if (window.AndroidSave && blob.size < 120 * 1024 * 1024) {
    const r = new FileReader();
    r.onload = () => {
      const b64 = String(r.result).split(',')[1] || '';
      try { window.AndroidSave.save(filename, blob.type || 'application/octet-stream', b64); }
      catch (e) { console.warn('no se pudo guardar', e); }
    };
    r.readAsDataURL(blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 6000);
}

async function exportImages(fmt, pages, scale, quality, baseName, paperBg) {
  const mime = fmt === 'png' ? 'image/png'
    : fmt === 'webp' ? 'image/webp'
    : 'image/jpeg';
  const ext = fmt === 'jpg' ? 'jpg' : fmt;
  const q = fmt === 'png' ? undefined : quality / 100;

  toast('Generando ' + ext.toUpperCase() + '…');

  // Varias páginas -> ZIP (evita que el navegador bloquee descargas múltiples)
  if (pages.length > 1 && typeof JSZip !== 'undefined') {
    const zip = new JSZip();
    for (const p of pages) {
      const canvas = await renderFlattenedCanvas(p, scale, paperBg);
      const blob = await canvasToBlob(canvas, mime, q);
      if (!blob) { toast('El navegador no soporta ' + ext.toUpperCase(), 'err'); return; }
      zip.file(`${baseName}_pag${String(p).padStart(2, '0')}.${ext}`, blob);
    }
    const zblob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(zblob, `${baseName}_${ext}.zip`);
    toast(`${pages.length} imágenes exportadas en ZIP ✔`);
    return;
  }

  for (const p of pages) {
    const canvas = await renderFlattenedCanvas(p, scale, paperBg);
    const blob = await canvasToBlob(canvas, mime, q);
    if (!blob) { toast('El navegador no soporta ' + ext.toUpperCase(), 'err'); return; }
    downloadBlob(blob, `${baseName}.${ext}`);
  }
  toast('Imagen exportada ✔');
}


/* ========================= AUTOGUARDADO ========================= */
/* Guarda marcas y datos del documento abierto para no perderlos al recargar.
   El archivo original no se duplica: se reconoce por nombre + tamano. */
const AUTOKEY = 'docfill_autosave_v1';

function autoguardar() {
  if (!state.doc) return;
  try {
    const snap = {
      name: state.doc.name, size: state.doc.bytes ? state.doc.bytes.byteLength : 0,
      page: state.page, zoom: state.zoom,
      overlays: state.overlays, vars: state.vars, paper: state.paper,
      at: Date.now(),
    };
    localStorage.setItem(AUTOKEY, JSON.stringify(snap));
  } catch (e) { /* sin espacio: no es grave */ }
}

function restaurarAutoguardado() {
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(AUTOKEY) || 'null'); } catch (e) { snap = null; }
  if (!snap || !snap.name) return;
  const cuando = new Date(snap.at || Date.now());
  toast('Hay cambios guardados de "' + snap.name + '" (' + cuando.toLocaleString() + '). Abre el mismo archivo y te pregunto si restaurarlos.');
  window.__autosave = snap;
}

function ofrecerRestaurar(file) {
  const snap = window.__autosave;
  if (!snap) return false;
  const igual = snap.name === (file.name || '').replace(/\.[^.]+$/, '') || snap.name === file.name;
  if (!igual) return false;
  if (!confirm('Encontre cambios guardados de "' + snap.name + '". ¿Los restauro?')) return false;
  state.overlays = snap.overlays || {};
  state.vars = snap.vars || [];
  state.paper = snap.paper || {};
  state.page = snap.page || 1;
  window.__autosave = null;
  renderAll();
  renderPage();
  toast('Cambios restaurados ✔');
  return true;
}

/* ========================= EXPORTAR PDF ========================= */
async function exportPdf(pageNums, baseName, paperBg) {
  if (!state.doc) { toast('Abre un documento primero.', 'err'); return; }
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  toast('Generando PDF…');
  const out = await PDFDocument.create();
  const pageMap = [];   // índice en el PDF de salida -> número de página original

  const paperRgb = (n) => {
    const h = paperColor(n).replace('#', '');
    const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
  };

  if (state.doc.type === 'pdf') {
    const loaded = await PDFDocument.load(state.doc.bytes, { ignoreEncryption: true });

    if (paperBg) {
      // Cada página se reconstruye: fondo con el color real del papel + contenido original encima
      for (const n of pageNums) {
        const srcPage = loaded.getPage(n - 1);
        const { width: PW, height: PH } = srcPage.getSize();
        const np = out.addPage([PW, PH]);
        np.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: paperRgb(n) });
        try {
          const [emb] = await out.embedPdf(state.doc.bytes, [n - 1]);
          np.drawPage(emb, { x: 0, y: 0, width: PW, height: PH });
        } catch (e) {
          console.warn('No se pudo incrustar la página', n, e);
        }
        pageMap.push(n);
      }
    } else {
      const idx = pageNums.map((n) => n - 1);
      const copied = await out.copyPages(loaded, idx);
      copied.forEach((p) => out.addPage(p));
      pageNums.forEach((n) => pageMap.push(n));
    }

    // páginas limpiadas con el borrador de fondo -> imagen encima
    for (let i = 0; i < pageNums.length; i++) {
      const n = pageNums[i];
      const raster = state.pageRaster[n];
      if (!raster) continue;
      try {
        const pg = out.getPage(i);
        const { width: PW, height: PH } = pg.getSize();
        const b = await (await fetch(raster)).arrayBuffer();
        const im = await out.embedPng(b);
        pg.drawImage(im, { x: 0, y: 0, width: PW, height: PH });
      } catch (e) { console.warn('raster', e); }
    }
  } else {
    const src = state.doc.cleanSrc || state.doc.src;
    const bytes = await (await fetch(src)).arrayBuffer();
    const isPng = /^data:image\/png/.test(src);
    const img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    const ps = state.doc.pageSizes[0];
    const p = out.addPage([ps.w, ps.h]);
    if (paperBg) p.drawRectangle({ x: 0, y: 0, width: ps.w, height: ps.h, color: paperRgb(1) });
    p.drawImage(img, { x: 0, y: 0, width: ps.w, height: ps.h });
    pageMap.push(1);
  }

  const fontCache = {};
  const getFont = async (bold, italic, family) => {
    const key = family + (bold ? 'B' : '') + (italic ? 'I' : '');
    if (fontCache[key]) return fontCache[key];
    let name = StandardFonts.Helvetica;
    if (family === 'Times') {
      name = bold && italic ? StandardFonts.TimesRomanBoldItalic
        : bold ? StandardFonts.TimesRomanBold
        : italic ? StandardFonts.TimesRomanItalic
        : StandardFonts.TimesRoman;
    } else if (family === 'Courier') {
      name = bold && italic ? StandardFonts.CourierBoldOblique
        : bold ? StandardFonts.CourierBold
        : italic ? StandardFonts.CourierOblique
        : StandardFonts.Courier;
    } else {
      name = bold && italic ? StandardFonts.HelveticaBoldOblique
        : bold ? StandardFonts.HelveticaBold
        : italic ? StandardFonts.HelveticaOblique
        : StandardFonts.Helvetica;
    }
    fontCache[key] = await out.embedFont(name);
    return fontCache[key];
  };

  const safeText = (t) => String(t).replace(/[^\t\n\r\x20-\x7E\u00A0-\u00FF]/g, '?');
  const hexToRgb = (hex) => {
    const h = (hex || '#000000').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };

  const pages = out.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const { width: PW, height: PH } = page.getSize();
    const list = overlaysOf(pageMap[i] || i + 1);
    if (!list.length) continue;

    // 1) zonas borradas
    list.filter((o) => o.type === 'erase').forEach((o) => {
      page.drawRectangle({
        x: o.x, y: PH - (o.y + o.h), width: o.w, height: o.h,
        color: hexToRgb(o.color || paperColor(pageMap[i] || i + 1)),
      });
    });

    // 2) imágenes
    for (const o of list.filter((x) => x.type === 'image')) {
      try {
        const raw = await (await fetch(o.src)).arrayBuffer();
        const emb = /^data:image\/png/.test(o.src)
          ? await out.embedPng(raw)
          : await out.embedJpg(raw);
        page.drawImage(emb, { x: o.x, y: PH - (o.y + o.h), width: o.w, height: o.h });
      } catch (err) {
        console.warn('No se pudo incrustar imagen', err);
      }
    }

    // 3) textos (con su tapado)
    for (const o of list.filter((x) => x.type === 'text')) {
      const text = o.varId ? (varById(o.varId)?.value ?? o.text) : o.text;
      if (!text) continue;
      const font = await getFont(o.bold, o.italic, o.fontFamily);
      const size = o.fontSize;
      const lh = size * 1.18;
      const lines = safeText(text).split('\n');

      if (o.cover) {
        // el tapado se ajusta al texto nuevo si éste es más largo/ancho
        let needW = o.w;
        let needH = o.h;
        lines.forEach((ln) => {
          let tw = 0;
          try { tw = font.widthOfTextAtSize(ln, size); } catch (e) { tw = ln.length * size * 0.5; }
          needW = Math.max(needW, tw + 3);
        });
        needH = Math.max(needH, lines.length * lh + 1);
        const covColor = hexToRgb(o.coverColor || '#ffffff');
        page.drawRectangle({
          x: o.x - 1, y: PH - (o.y + needH), width: needW + 2, height: needH,
          color: covColor,
        });
      }
      lines.forEach((ln, idx) => {
        if (!ln) return;
        let tw = 0;
        try { tw = font.widthOfTextAtSize(ln, size); } catch (e) { tw = ln.length * size * 0.5; }
        let tx = o.x;
        if (o.align === 'center') tx = o.x + (o.w - tw) / 2;
        else if (o.align === 'right') tx = o.x + o.w - tw;
        const baseline = o.y + size * 0.82 + idx * lh;
        try {
          page.drawText(ln, {
            x: tx, y: PH - baseline, size, font,
            color: hexToRgb(o.color),
          });
        } catch (e) {
          console.warn('Texto no dibujable:', ln, e);
        }
      });
    }
  }

  const bytes = await out.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  downloadBlob(blob, (baseName || state.doc.name || 'documento') + '.pdf');
  toast('PDF exportado ✔');
}

/* ========================= ORQUESTADOR DE EXPORTACIÓN ========================= */
async function doExport(opts) {
  if (!state.doc) { toast('Abre un documento primero.', 'err'); return; }
  const fmt = opts.fmt || 'pdf';
  const pages = opts.pages === 'all'
    ? Array.from({ length: state.doc.numPages }, (_, i) => i + 1)
    : [state.page];
  const base = (opts.name || state.doc.name || 'documento').replace(/\.(pdf|png|jpe?g|webp)$/i, '');

  const paperBg = opts.paperBg !== undefined ? !!opts.paperBg : true;
  if (fmt === 'pdf') {
    await exportPdf(pages, base, paperBg);
  } else {
    await exportImages(fmt, pages, opts.scale || 2, opts.quality || 92, base, paperBg);
  }
}

/* ========================= PROYECTO (guardar/cargar) ========================= */
function bufToBase64(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function base64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function saveProject() {
  if (!state.doc) { toast('Abre un documento primero.', 'err'); return; }
  const data = {
    version: 1,
    name: state.doc.name,
    docType: state.doc.type,
    docData: state.doc.type === 'pdf' ? bufToBase64(state.doc.bytes) : state.doc.src,
    overlays: state.overlays,
    vars: state.vars,
    zoom: state.zoom,
    page: state.page,
    paper: state.paper,
    pageRaster: state.pageRaster,
    cleanSrc: state.doc.cleanSrc || null,
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (state.doc.name || 'proyecto') + '.docfill';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Proyecto guardado. Podrás reutilizar la plantilla.');
}

async function loadProject(file) {
  const txt = await file.text();
  let data;
  try { data = JSON.parse(txt); } catch (e) { toast('Archivo de proyecto inválido.', 'err'); return; }

  state.overlays = data.overlays || {};
  state.vars = data.vars || [];
  state.selected = null;
  state.textCache = {};
  state.ocrCache = {};
  state.ocrDone = {};
  state.paper = data.paper || {};
  state.pageRaster = data.pageRaster || {};

  if (data.docType === 'pdf') {
    const buf = base64ToBuf(data.docData);
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    const pageSizes = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      pageSizes.push({ w: vp.width, h: vp.height });
    }
    state.doc = { type: 'pdf', bytes: buf, pdf, numPages: pdf.numPages, pageSizes, name: data.name || 'documento' };
  } else {
    const img = new Image();
    img.src = data.docData;
    await img.decode();
    state.doc = {
      type: 'image', src: data.docData, numPages: 1,
      pageSizes: [{ w: img.naturalWidth * 0.75, h: img.naturalHeight * 0.75 }],
      name: data.name || 'documento',
      cleanSrc: data.cleanSrc || null,
    };
  }

  state.page = data.page || 1;
  state.zoom = data.zoom || 1.2;
  $('#dropzone').classList.add('hidden');
  $('#pageCount').textContent = state.doc.numPages;
  $('#pageNum').max = state.doc.numPages;
  $('#pageNum').value = state.page;
  await renderPage();
  renderAll();
  toast('Proyecto cargado ✔');
}

/* ========================= UI DE EXPORTACIÓN ========================= */
/* ========================= MUESTRA CON MARCA DE AGUA ========================= */
function pickPhotoOverlay(pageNum) {
  const imgs = overlaysOf(pageNum).filter((o) => o.type === 'image' && o.w > 4 && o.h > 4);
  if (!imgs.length) return null;
  const score = (o) => {
    const ar = o.h / o.w;
    let s = o.w * o.h;
    if (Math.abs(ar - 4 / 3) < 0.28) s *= 2.4;        // proporción carné 3×4
    else if (ar > 1.12 && ar < 1.65) s *= 1.35;
    return s;
  };
  return imgs.slice().sort((a, b) => score(b) - score(a))[0];
}

async function generateSample() {
  if (!state.doc) { toast('Abre un documento primero.', 'err'); return; }
  toast('Generando muestra…');
  const scale = 2;
  const canvas = await renderFlattenedCanvas(state.page, scale, true);
  const ctx = canvas.getContext('2d');

  // Marca de agua: SOLO el texto, sin cuadro ni marco, en el centro del documento
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const txt = 'POR ENTREGAR';

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 9);           // ligera inclinación, estilo marca de agua

  let fs = canvas.width * 0.105;
  ctx.font = '700 ' + fs + 'px system-ui, Arial, sans-serif';
  let tw = ctx.measureText(txt).width;
  const maxW = canvas.width * 0.78;
  if (tw > maxW) {
    fs *= maxW / tw;
    ctx.font = '700 ' + fs + 'px system-ui, Arial, sans-serif';
    tw = ctx.measureText(txt).width;
  }

  // Texto translúcido: se lee la marca pero los datos siguen visibles
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(90,98,110,0.30)';
  ctx.fillText(txt, 0, 0);
  ctx.lineWidth = Math.max(1, fs * 0.02);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.strokeText(txt, 0, 0);
  ctx.restore();

  window.__lastSample = { canvas, rect: { rx: cx - tw / 2, ry: cy - fs / 2, rw: tw, rh: fs } };
  const blob = await canvasToBlob(canvas, 'image/png');
  if (!blob) { toast('No se pudo generar la muestra', 'err'); return; }
  const base = (state.doc.name || 'documento').replace(/\.(pdf|png|jpe?g|webp)$/i, '');
  const fname = base + '_muestra.png';
  downloadBlob(blob, fname);

  const url = URL.createObjectURL(blob);
  $('#dataTitle').textContent = 'Muestra · POR ENTREGAR';
  $('#dataBody').innerHTML = `
    <div class="data-item">
      <h4>${escapeAttr(fname)}</h4>
      <div class="imgbox"><img src="${url}" alt="muestra"></div>
      <p class="hint" style="margin:8px 0 0;">Marca de agua <b>POR ENTREGAR</b> al centro del documento,
      sin cuadro y sin tapar los datos personales.</p>
      <div class="acts">
        <button class="btn accent" id="btnDlSample">Descargar imagen</button>
      </div>
    </div>`;
  $('#dataModal').classList.add('open');
  $('#btnDlSample').onclick = () => downloadBlob(blob, fname);
  toast('Muestra generada ✔');
}

function initExportUI() {
  const menu = $('#exportMenu');
  const modal = $('#exportModal');
  const fmtSel = $('#exFmt');
  const scaleRow = $('#exScaleRow');
  const qualityRow = $('#exQualityRow');
  const note = $('#exNote');

  const syncRows = () => {
    const f = fmtSel.value;
    scaleRow.style.display = f === 'pdf' ? 'none' : '';
    qualityRow.style.display = (f === 'jpg' || f === 'webp') ? '' : 'none';
    note.textContent = f === 'pdf'
      ? 'El PDF conserva el texto nítido y seleccionable.'
      : f === 'png'
        ? 'PNG no pierde calidad. A más DPI, más peso.'
        : 'Formato comprimido: ajusta la calidad para controlar el peso.';
  };

  $('#btnExport').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.export-wrap')) menu.classList.remove('open');
  });

  $$('.em-item[data-fmt]').forEach((b) => {
    b.addEventListener('click', () => {
      menu.classList.remove('open');
      doExport({ fmt: b.dataset.fmt, pages: 'current', scale: 2, quality: 92 });
    });
  });

  const emSample = $('#emSample');
  if (emSample) {
    emSample.addEventListener('click', () => {
      menu.classList.remove('open');
      generateSample();
    });
  }

  $('#emOptions').addEventListener('click', () => {
    menu.classList.remove('open');
    if (!state.doc) { toast('Abre un documento primero.', 'err'); return; }
    $('#exName').value = (state.doc.name || 'documento') + '_editado';
    $('#exPages').value = 'current';
    $('#exPaper').checked = true;
    $('#exPaperVal').textContent = paperColor(state.page).toUpperCase();
    $('#exPaperVal').style.opacity = '1';
    modal.classList.add('open');
    syncRows();
  });

  fmtSel.addEventListener('change', syncRows);
  $('#exQuality').addEventListener('input', (e) => {
    $('#exQualityVal').textContent = e.target.value + '%';
  });

  const close = () => modal.classList.remove('open');
  $('#modalClose').addEventListener('click', close);
  $('#modalCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  $('#modalExport').addEventListener('click', async () => {
    close();
    await doExport({
      fmt: fmtSel.value,
      pages: $('#exPages').value,
      scale: parseFloat($('#exScale').value),
      quality: parseInt($('#exQuality').value, 10),
      name: $('#exName').value.trim(),
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); menu.classList.remove('open'); }
  });
}

/* =========================================================
   SOLICITUDES DE DATOS (foto / firma / huella)
   ========================================================= */
const API_BASE = '';
/* Direccion publica donde vive la pagina de captura.
   Dentro del APK el origen es 127.0.0.1 (solo este telefono), asi que los
   enlaces se arman con la copia publicada en GitHub Pages. */
const BASE_PUBLICA = 'https://cuestaa577-stack.github.io/DocFill/';
function origenPublico() {
  const host = location.hostname;
  const local = !host || host === '127.0.0.1' || host === 'localhost' || location.protocol === 'file:';
  if (local) return BASE_PUBLICA;
  return location.origin + location.pathname.replace(/[^/]*$/, '');
}
function esOrigenLocal() {
  const host = location.hostname;
  return !host || host === '127.0.0.1' || host === 'localhost' || location.protocol === 'file:';
}

let lastEventTs = Date.now() / 1000;
let unreadCount = 0;
let pollTimer = null;

function ownerId() {
  let o = localStorage.getItem('docfill_owner');
  if (!o) {
    o = 'u_' + Math.random().toString(36).slice(2, 12);
    localStorage.setItem('docfill_owner', o);
  }
  return o;
}

/* ---------- modo local (sin servidor): enlace autónomo + paquete ---------- */
function b64uEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function getLocalSessions() {
  try { return JSON.parse(localStorage.getItem('docfill_local_sessions') || '[]'); }
  catch (e) { return []; }
}
function saveLocalSessions(arr) {
  try { localStorage.setItem('docfill_local_sessions', JSON.stringify(arr)); }
  catch (e) { toast('Almacenamiento lleno: borra solicitudes antiguas', 'err'); }
}
function findLocalSession(token) {
  return getLocalSessions().find((s) => s.token === token) || null;
}

let pidiendoClave = false;

async function api(path, opts) {
  let r = await fetch(API_BASE + path, Object.assign({ credentials: 'same-origin' }, opts || {}));
  if (r.status === 401 && !pidiendoClave) {
    pidiendoClave = true;
    try {
      const clave = prompt('Contraseña del operador (la de server.py):');
      if (clave) {
        const lg = await fetch(API_BASE + '/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: clave }),
        });
        if (lg.ok) {
          pidiendoClave = false;
          return api(path, opts);
        }
        toast('Contraseña incorrecta.', 'err');
      }
    } finally {
      pidiendoClave = false;
    }
  }
  if (!r.ok) {
    let msg = 'Error ' + r.status;
    try { const j = await r.json(); msg = j.detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.setValueAtTime(1180, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.start(); o.stop(ctx.currentTime + 0.46);
  } catch (e) { /* silencio */ }
}

function setBadge(n) {
  unreadCount = n;
  const b = $('#notifBadge');
  if (!b) return;
  b.hidden = n <= 0;
  b.textContent = n > 9 ? '9+' : n;
}

async function pollEvents() {
  try {
    const data = await api('/api/events?since=' + lastEventTs);
    lastEventTs = data.server_time || Date.now() / 1000;
    setBadge(data.unread || 0);
    (data.events || []).forEach((e) => {
      if (e.kind === 'submitted') {
        toast('✅ ' + e.message);
        beep();
      } else if (e.kind !== 'submitted') {
        toast('📥 ' + e.message);
        beep();
      }
    });
    if ((data.events || []).length) refreshReqList();
  } catch (e) {
    // servidor no disponible: se reintenta en silencio
  }
}

function startPolling() {
  if (pollTimer) return;
  pollEvents();
  pollTimer = setInterval(pollEvents, 6000);
}

/* ---------- crear solicitud ---------- */
async function createRequest() {
  const label = $('#reqLabel').value.trim();
  const steps = [];
  if ($('#stPhoto').checked) steps.push('photo');
  if ($('#stSign').checked) steps.push('signature');
  if ($('#stFinger').checked) steps.push('fingerprint');
  if (!steps.length) { toast('Elige al menos un dato a solicitar', 'err'); return; }

  const titulo = label || 'Solicitud de datos';
  let link = '';
  let mode = 'server';

  // 1) Intentar el servidor (si está disponible, los datos llegan solos)
  try {
    const res = await api('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: titulo, owner: ownerId(), steps }),
    });
    link = origenPublico().replace(/\/$/, '') + res.path;
  } catch (e) {
    // 2) Sin servidor: enlace autónomo. La persona captura y devuelve un paquete
    //    que se importa aquí, así el enlace SIEMPRE se genera.
    mode = 'local';
    const token = 'local_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const payload = { t: token, label: titulo, steps, ts: Math.floor(Date.now() / 1000) };
    link = origenPublico() + 'captura.html#r=' + b64uEncode(JSON.stringify(payload));

    const arr = getLocalSessions();
    arr.unshift({
      token, label: titulo, steps, status: 'pending',
      created: payload.ts, files: {}, local: true,
    });
    saveLocalSessions(arr);
  }

  $('#reqLabel').value = '';
  await refreshReqList();
  showLinkDialog(link, titulo, mode);
}

function showLinkDialog(link, label, mode) {
  const wa = 'https://wa.me/?text=' + encodeURIComponent(
    (label ? label + '\n\n' : '') +
    'Hola, necesito tu foto, firma y huella. Abre este enlace y sigue los pasos:\n' + link
  );
  const nota = (mode === 'local' && esOrigenLocal())
    ? 'Este enlace abre la copia publica del formulario, funciona en cualquier telefono. ' +
      'La persona completa foto, firma y huella y al final te devuelve un archivo que importas ' +
      'con “Importar datos recibidos”.'
    : mode === 'local'
    ? 'Enlace autónomo (funciona sin servidor). La persona verá 3 opciones: <b>Tomar foto</b>, ' +
      '<b>Escribe aquí tu firma</b> y <b>Presiona acá tu dedo pulgar derecho</b>. Al terminar ' +
      'te devuelve un archivo que importas con “Importar datos recibidos”.'
    : 'Compártelo por WhatsApp, correo o mensaje. La persona abre el enlace y completa los ' +
      '3 pasos: <b>Tomar foto</b>, <b>Escribe aquí tu firma</b> y <b>Presiona acá tu dedo pulgar derecho</b>.';
  const html = `
    <div class="data-item">
      <h4>Enlace para la persona</h4>
      <p class="hint" style="margin:0 0 9px;">${nota}</p>
      <input type="text" readonly value="${escapeAttr(link)}" id="linkBox"
        style="width:100%;background:#0d1219;border:1px solid #2b3542;color:#8fb8ff;
        border-radius:8px;padding:9px;font-size:11.5px;" />
      <div class="acts">
        <button class="btn" id="btnCopyLink">Copiar enlace</button>
        <a class="btn" href="${wa}" target="_blank" rel="noopener">Enviar por WhatsApp</a>
      </div>
    </div>`;
  $('#dataTitle').textContent = 'Enlace creado';
  $('#dataBody').innerHTML = html;
  $('#dataModal').classList.add('open');
  $('#btnCopyLink').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Enlace copiado ✔');
    } catch (e) {
      $('#linkBox').select();
      document.execCommand('copy');
      toast('Enlace copiado ✔');
    }
  };
}

/* ---------- lista ---------- */
function linkForSession(s) {
  if (s.local) {
    const payload = { t: s.token, label: s.label, steps: s.steps, ts: s.created };
    const dir = location.pathname.replace(/[^/]*$/, '');
    return origenPublico() + 'captura.html#r=' + b64uEncode(JSON.stringify(payload));
  }
  return location.origin + '/captura.html?t=' + s.token;
}

async function refreshReqList() {
  const box = $('#reqList');
  if (!box) return;
  try {
    let list = [];
    try {
      const data = await api('/api/sessions?owner=' + encodeURIComponent(ownerId()));
      list = data.sessions || [];
    } catch (e) {
      list = [];
    }
    // Sumar las solicitudes locales / importadas (modo sin servidor)
    const local = getLocalSessions();
    local.forEach((ls) => {
      if (!list.some((s) => s.token === ls.token)) list.push(ls);
    });
    list.sort((a, b) => (b.created || 0) - (a.created || 0));
    if (!list.length) {
      box.innerHTML = '<p class="empty">Todavía no has creado solicitudes.</p>';
      return;
    }
    box.innerHTML = '';
    list.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'req-item';
      const stTxt = { pending: 'Pendiente', partial: 'Parcial', submitted: 'Completo' }[s.status] || s.status;
      const when = new Date(s.created * 1000).toLocaleString('es', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      });
      const thumbs = ['photo', 'signature', 'fingerprint'].map((k) => {
        if (!s.steps.includes(k)) return '';
        const f = s.files[k];
        const src = f && (s.local ? f : `/media/${s.token}/${k}.png?ts=${f.ts}`);
        return src
          ? `<div class="t"><img src="${src}" alt="${k}"></div>`
          : `<div class="t empty-t">${k === 'photo' ? 'Foto' : k === 'signature' ? 'Firma' : 'Huella'}</div>`;
      }).join('');

      div.innerHTML = `
        <div class="req-top">
          <div class="lbl">
            <b>${escapeAttr(s.label)}</b>
            <span>${when}${s.person_name ? ' · ' + escapeAttr(s.person_name) : ''}</span>
          </div>
          <span class="st ${s.status}">${stTxt}</span>
        </div>
        <div class="req-thumbs">${thumbs}</div>
        <div class="req-actions">
          <button class="btn" data-act="view">Ver datos</button>
          <button class="btn" data-act="copy">Copiar enlace</button>
          <button class="btn" data-act="wa">WhatsApp</button>
          <button class="btn danger" data-act="del">Eliminar</button>
        </div>`;
      const link = linkForSession(s);
      div.querySelector('[data-act="view"]').onclick = () => openData(s.token);
      div.querySelector('[data-act="copy"]').onclick = async () => {
        try { await navigator.clipboard.writeText(link); toast('Enlace copiado ✔'); }
        catch (e) { toast('No se pudo copiar', 'err'); }
      };
      div.querySelector('[data-act="wa"]').onclick = () => {
        window.open('https://wa.me/?text=' + encodeURIComponent(
          s.label + '\n\nAbre este enlace y sigue los pasos:\n' + link), '_blank');
      };
      div.querySelector('[data-act="del"]').onclick = async () => {
        if (!confirm('¿Eliminar esta solicitud y los datos recibidos?')) return;
        if (s.local) {
          saveLocalSessions(getLocalSessions().filter((x) => x.token !== s.token));
          refreshReqList();
          toast('Solicitud eliminada');
          return;
        }
        try {
          await api('/api/sessions/' + s.token, { method: 'DELETE' });
          refreshReqList();
          toast('Solicitud eliminada');
        } catch (e) { toast('Error: ' + e.message, 'err'); }
      };
      box.appendChild(div);
    });
  } catch (e) {
    box.innerHTML = '<p class="empty">No se pudo conectar con el servidor de solicitudes.</p>';
  }
}

/* ---------- ver datos recibidos ---------- */
async function openData(token) {
  try {
    const localS = findLocalSession(token);
    const s = localS || await api('/api/sessions/' + token);
    const names = { photo: 'Foto', signature: 'Firma', fingerprint: 'Huella' };
    let html = '';
    if (s.person_name) {
      html += `<div class="person-name">Enviado por: <strong>${escapeAttr(s.person_name)}</strong></div>`;
    }
    html += '<div class="data-grid">';
    s.steps.forEach((k) => {
      const url = s.files[k];
      html += `<div class="data-item">
        <h4>${names[k]}</h4>
        <div class="imgbox">${url
          ? `<img src="${s.local ? url : url + '?ts=' + Date.now()}" alt="${k}">`
          : '<span style="color:#c33;font-size:12px;">No recibido</span>'}</div>
        ${url ? `<div class="acts">
          <button class="btn" data-dl="${url}" data-kind="${k}">Descargar</button>
          <button class="btn accent" data-ins="${url}" data-kind="${k}">Insertar en documento</button>
        </div>` : ''}
      </div>`;
    });
    html += '</div>';
    $('#dataTitle').textContent = s.label || 'Datos recibidos';
    $('#dataBody').innerHTML = html;
    $('#dataModal').classList.add('open');

    $$('#dataBody [data-dl]').forEach((b) => {
      b.onclick = () => {
        const a = document.createElement('a');
        a.href = b.dataset.dl;
        a.download = (s.label || 'dato').replace(/\s+/g, '_') + '_' + b.dataset.kind + '.png';
        a.click();
      };
    });
    $$('#dataBody [data-ins]').forEach((b) => {
      b.onclick = () => insertRemoteImage(b.dataset.ins, b.dataset.kind);
    });

    if (!s.local) {
      await api('/api/sessions/' + token + '/seen', { method: 'POST' });
      pollEvents();
    }
  } catch (e) {
    toast('No se pudieron cargar los datos: ' + e.message, 'err');
  }
}

/* ---------- insertar imagen recibida en el documento ---------- */
async function insertRemoteImage(url, kind) {
  if (!state.doc) { toast('Abre primero el documento donde quieres insertarla', 'err'); return; }
  try {
    const blob = await (await fetch(url)).blob();
    const src = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(blob);
    });
    const img = new Image();
    img.src = src;
    await img.decode();

    const ps = pageSize(state.page);
    // tamaño por defecto según el tipo (la foto va a 3x4 cm, tamaño carné)
    const CM = 28.3465; // 1 cm en puntos
    let w, h;
    if (kind === 'photo') {
      w = Math.min(3 * CM, ps.w * 0.35);
      h = w * 4 / 3;
      if (h > ps.h * 0.45) { h = ps.h * 0.45; w = h * 3 / 4; }
    } else if (kind === 'signature') {
      w = Math.min(ps.w * 0.34, 160);
      h = w * (img.naturalHeight / img.naturalWidth);
    } else {
      w = Math.min(ps.w * 0.16, 80);
      h = w * (img.naturalHeight / img.naturalWidth);
    }

    const o = {
      id: uid(), type: 'image',
      x: Math.max(10, (ps.w - w) / 2),
      y: Math.max(10, ps.h * 0.45),
      w, h, src,
    };
    overlaysOf(state.page).push(o);
    renderOverlays();
    selectOverlay(o.id);
    $('#dataModal').classList.remove('open');
    toast('Insertada. Arrástrala y ajusta el tamaño.');
  } catch (e) {
    toast('No se pudo insertar: ' + e.message, 'err');
  }
}

/* ---------- importar paquete devuelto por la persona (modo sin servidor) ---------- */
async function importPackage(file) {
  try {
    const txt = await file.text();
    const p = JSON.parse(txt);
    if (!p || !p.files || typeof p.files !== 'object') {
      throw new Error('El archivo no es un paquete de datos válido');
    }
    const token = p.token || ('local_' + Date.now().toString(36));
    const item = {
      token,
      label: p.label || 'Datos importados',
      steps: Array.isArray(p.steps) && p.steps.length ? p.steps : Object.keys(p.files),
      status: 'submitted',
      created: p.created || Math.floor(Date.now() / 1000),
      files: p.files,
      person_name: p.person_name || '',
      local: true,
    };
    const arr = getLocalSessions();
    const i = arr.findIndex((x) => x.token === token);
    if (i >= 0) arr[i] = item; else arr.unshift(item);
    saveLocalSessions(arr);
    await refreshReqList();
    toast('Datos importados ✔');
    openData(token);
  } catch (e) {
    toast('No se pudo importar: ' + e.message, 'err');
  }
}

function initRequests() {
  const impBtn = $('#reqImport');
  const impFile = $('#reqImportFile');
  if (impBtn && impFile) {
    impBtn.addEventListener('click', () => impFile.click());
    impFile.addEventListener('change', () => {
      const f = impFile.files && impFile.files[0];
      impFile.value = '';
      if (f) importPackage(f);
    });
  }
  $('#btnRequests').addEventListener('click', () => {
    $('#reqModal').classList.add('open');
    refreshReqList();
    setBadge(0);
    api('/api/events/read', { method: 'POST' }).catch(() => {});
  });
  $('#reqClose').addEventListener('click', () => $('#reqModal').classList.remove('open'));
  $('#reqModal').addEventListener('click', (e) => {
    if (e.target === $('#reqModal')) $('#reqModal').classList.remove('open');
  });
  $('#dataClose').addEventListener('click', () => $('#dataModal').classList.remove('open'));
  $('#dataModal').addEventListener('click', (e) => {
    if (e.target === $('#dataModal')) $('#dataModal').classList.remove('open');
  });
  $('#reqCreate').addEventListener('click', createRequest);
  $('#reqLabel').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createRequest();
  });
  startPolling();
}

/* =========================================================
   TUTORIAL GUIADO (letras A, B, C…)
   ========================================================= */
const TOUR_STEPS = [
  {
    letter: 'A',
    sel: '.top-actions label.btn.primary',
    title: 'Abre tu documento',
    text: 'Carga el PDF o la foto del documento que quieres llenar. Todo se procesa en tu navegador: nada se sube a internet.',
  },
  {
    letter: 'B',
    sel: '.tools',
    title: 'Elige una herramienta',
    text: 'Seleccionar para mover cosas, Texto para escribir, Borrar zona para tapar, Imagen para pegar fotos.',
  },
  {
    letter: 'C',
    sel: '.tool[data-tool="pick"]',
    title: 'El truco: Editar texto',
    text: 'Haz clic sobre un dato del documento (por ejemplo el nombre). La app lo captura y busca solo todas las demás veces que aparece.',
  },
  {
    letter: 'D',
    sel: '#varList',
    title: 'Escribe una sola vez',
    text: 'Aquí escribes el dato. Se actualiza automáticamente en todas las casillas vinculadas, aunque estén en otras páginas.',
  },
  {
    letter: 'E',
    sel: '#btnOcr',
    title: 'Documentos escaneados',
    text: 'Si el documento es una foto o un escaneo, pulsa aquí: se reconoce el texto y ya puedes editarlo igual que un PDF normal.',
  },
  {
    letter: 'F',
    sel: '#btnRequests',
    title: 'Pide foto, firma y huella',
    text: 'Crea un enlace y mándalo por WhatsApp. La persona lo abre en su celular y envía su foto, firma y huella paso por paso. Te llega una notificación.',
  },
  {
    letter: 'G',
    sel: '#btnExport',
    title: 'Descarga el resultado',
    text: 'Exporta en PDF, PNG, JPG o WEBP, con la calidad y la resolución que necesites. Igual que en Photopea.',
  },
];

let tourIdx = 0;

function tourTargets() {
  return TOUR_STEPS.map((s) => document.querySelector(s.sel)).filter(Boolean);
}

function placeTour() {
  const step = TOUR_STEPS[tourIdx];
  const el = document.querySelector(step.sel);
  const tour = $('#tour');
  if (!el) return;

  const r = el.getBoundingClientRect();
  const pad = 7;
  const spot = $('#tourSpot');
  const badge = $('#tourBadge');
  const card = $('#tourCard');

  spot.style.left = r.left - pad + 'px';
  spot.style.top = r.top - pad + 'px';
  spot.style.width = r.width + pad * 2 + 'px';
  spot.style.height = r.height + pad * 2 + 'px';

  let bx = r.left - pad - 11;
  let by = r.top - pad - 11;
  if (bx < 4) bx = 4;
  if (by < 4) by = r.top - pad + 3; // objetivo pegado arriba: insignia dentro
  badge.style.left = bx + 'px';
  badge.style.top = by + 'px';
  badge.textContent = step.letter;

  $('#tourLetter').textContent = step.letter;
  $('#tourTitle').textContent = step.title;
  $('#tourText').textContent = step.text;
  $('#tourCount').textContent = (tourIdx + 1) + ' de ' + TOUR_STEPS.length;
  $('#tourPrev').style.visibility = tourIdx === 0 ? 'hidden' : 'visible';
  $('#tourNext').textContent = tourIdx === TOUR_STEPS.length - 1 ? 'Empezar' : 'Siguiente';

  // colocar la tarjeta cerca del objetivo
  const cw = 330;
  const ch = card.offsetHeight || 180;
  let left = r.left;
  let top = r.bottom + 18;

  if (top + ch > window.innerHeight - 12) {
    top = r.top - ch - 18;
  }
  if (top < 12) top = Math.min(window.innerHeight - ch - 12, 12);
  if (left + cw > window.innerWidth - 12) left = window.innerWidth - cw - 12;
  if (left < 12) left = 12;

  card.style.left = left + 'px';
  card.style.top = top + 'px';
}

function showTourStep(i) {
  tourIdx = Math.max(0, Math.min(i, TOUR_STEPS.length - 1));
  const step = TOUR_STEPS[tourIdx];
  const el = document.querySelector(step.sel);
  if (el && el.scrollIntoView) {
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
  }
  placeTour();
}

function startTour() {
  $('#tour').hidden = false;
  showTourStep(0);
}

function closeTour() {
  $('#tour').hidden = true;
  localStorage.setItem('docfill_tour_v1', 'done');
}

function initTour() {
  $('#tourNext').addEventListener('click', () => {
    if (tourIdx >= TOUR_STEPS.length - 1) { closeTour(); toast('Listo. Ya puedes empezar.'); return; }
    showTourStep(tourIdx + 1);
  });
  $('#tourPrev').addEventListener('click', () => showTourStep(tourIdx - 1));
  $('#tourSkip').addEventListener('click', closeTour);
  $('#btnHelp').addEventListener('click', startTour);
  window.addEventListener('resize', () => {
    if (!$('#tour').hidden) placeTour();
  });
  document.addEventListener('keydown', (e) => {
    if ($('#tour').hidden) return;
    if (e.key === 'Escape') closeTour();
    if (e.key === 'ArrowRight') $('#tourNext').click();
    if (e.key === 'ArrowLeft') $('#tourPrev').click();
  });

  if (!localStorage.getItem('docfill_tour_v1')) {
    setTimeout(startTour, 500);
  }
}

/* ========================= RENDER GLOBAL ========================= */
function renderAll() {
  renderVars();
  renderElementList();
  renderProps();
}

/* ========================= EVENTOS UI ========================= */
function setTool(tool) {
  state.tool = tool;
  $$('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  const layer = $('#overlayLayer');
  if (layer) layer.className = 'overlay-layer tool-' + tool;
  const hints = {
    select: 'Haz clic para seleccionar y arrastrar. Doble clic sobre un texto para editarlo.',
    text: 'Haz clic en el documento para crear una caja de texto.',
    pick: 'Haz clic sobre un texto existente del documento para reemplazarlo.',
    erase: 'Arrastra sobre la zona que quieres borrar.',
    image: 'Haz clic donde quieras colocar una imagen o foto.',
    bg: 'Haz clic sobre el fondo que quieres quitar (papel grisáceo, sombras, manchas).',
  };
  $('#toolHint').textContent = hints[tool] || '';
}

/* =========================================================
   MÓVIL: cajones, barra inferior y menú de acciones
   ========================================================= */
function initMobile() {
  const back = $('#sheetBack');
  const left = document.querySelector('.panel.left');
  const right = document.querySelector('.panel.right');
  const topActions = document.querySelector('.top-actions');

  const closeAll = () => {
    if (left) left.classList.remove('open');
    if (right) right.classList.remove('open');
    if (back) back.classList.remove('show');
    if (topActions) topActions.classList.remove('open');
    $$('.mob-bar button').forEach((b) => b.classList.remove('active'));
  };

  const openPanel = (which) => {
    closeAll();
    const el = which === 'left' ? left : right;
    if (!el) return;
    el.classList.add('open');
    if (back) back.classList.add('show');
    const btn = document.querySelector('.mob-bar button[data-sheet="' + which + '"]');
    if (btn) btn.classList.add('active');
  };

  $$('.mob-bar button[data-sheet]').forEach((b) => {
    b.addEventListener('click', () => {
      const which = b.dataset.sheet;
      if (which === 'more') {
        closeAll();
        if (topActions) topActions.classList.toggle('open');
        b.classList.add('active');
        return;
      }
      const isOpen = (which === 'left' ? left : right).classList.contains('open');
      if (isOpen) closeAll(); else openPanel(which);
    });
  });

  const fit = $('#mobFit');
  if (fit) fit.addEventListener('click', async () => {
    if (!state.doc) { toast('Abre un documento primero.', 'err'); return; }
    fitZoom(); await renderPage();
  });

  if (back) back.addEventListener('click', closeAll);
  const more = $('#btnMore');
  if (more) more.addEventListener('click', (e) => {
    e.stopPropagation();
    if (topActions) topActions.classList.toggle('open');
  });

  // al elegir herramienta, cerrar el cajón para ver el documento
  $$('.tool').forEach((b) => b.addEventListener('click', () => {
    if (window.innerWidth <= 900) closeAll();
  }));

  // cerrar el menú de acciones al usar cualquier botón
  if (topActions) topActions.addEventListener('click', (e) => {
    if (e.target.closest('button, label.btn')) setTimeout(closeAll, 120);
  });

  // input de imagen persistente
  const inp = $('#imgInput');
  if (inp) inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (f) onImagePicked(f);
  });

  // navegador de páginas flotante (documentos grandes)
  const mp = $('#mobPage');
  const go = async (d) => {
    if (!state.doc) return;
    const n = clamp(state.page + d, 1, state.doc.numPages);
    if (n === state.page) return;
    state.page = n;
    $('#pageNum').value = n;
    await renderPage();
  };
  const mpPrev = $('#mobPrev');
  const mpNext = $('#mobNext');
  if (mpPrev) mpPrev.addEventListener('click', () => go(-1));
  if (mpNext) mpNext.addEventListener('click', () => go(1));

  // reajustar al girar el teléfono
  let rt = null;
  window.addEventListener('resize', () => {
    if (!state.doc) return;
    clearTimeout(rt);
    rt = setTimeout(async () => { fitZoom(); await renderPage(); }, 250);
  });
}


/* ===================== VISTA ESCRITORIO / TELEFONO ===================== */
function aplicarVista(modo) {
  const escritorio = modo !== 'movil';
  document.documentElement.classList.toggle('vista-escritorio', escritorio);
  localStorage.setItem('docfill_vista', escritorio ? 'escritorio' : 'movil');
  const b = $('#btnVista');
  if (b) b.textContent = escritorio ? 'Vista: escritorio' : 'Vista: teléfono';
  const left = document.querySelector('.panel.left');
  const right = document.querySelector('.panel.right');
  if (left) left.classList.remove('open');
  if (right) right.classList.remove('open');
  setTimeout(async () => {
    if (!state.doc) return;
    fitZoom();
    await renderPage();
  }, 120);
}

function initVista() {
  // En el APK arranca como escritorio; en el navegador como telefono.
  const guardado = localStorage.getItem('docfill_vista');
  const porDefecto = window.AndroidSave ? 'escritorio' : 'movil';
  aplicarVista(guardado || porDefecto);

  const b = $('#btnVista');
  if (b) b.addEventListener('click', () => {
    aplicarVista(document.documentElement.classList.contains('vista-escritorio') ? 'movil' : 'escritorio');
  });

  const left = document.querySelector('.panel.left');
  const right = document.querySelector('.panel.right');
  const dl = $('#dockLeft');
  const dr = $('#dockRight');
  if (dl) dl.addEventListener('click', () => {
    if (left) left.classList.toggle('open');
    if (right) right.classList.remove('open');
  });
  if (dr) dr.addEventListener('click', () => {
    if (right) right.classList.toggle('open');
    if (left) left.classList.remove('open');
  });
}

function init() {
  initVista();
  setInterval(autoguardar, 20000);
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) abrirArchivo(f);
  });
  const dz = $('#dropzone');
  if (dz) dz.addEventListener('click', (e) => {
    if (e.target.closest('#btnPickFile') || e.target === dz || e.target.closest('.drop-inner')) {
      $('#fileInput').click();
    }
  });
  const bp = $('#btnPickFile');
  if (bp) bp.addEventListener('click', (e) => { e.stopPropagation(); $('#fileInput').click(); });
  restaurarAutoguardado();
  $('#projectInput').addEventListener('change', (e) => loadProject(e.target.files[0]));
  $('#btnSaveProject').addEventListener('click', saveProject);
  initExportUI();
  initRequests();
  initTour();
  initMobile();

  $('#btnOcr').addEventListener('click', () => ocrCurrentPage(false));
  $('#btnPrint').addEventListener('click', printDoc);

  // --- Papel real ---
  $('#paperColor').addEventListener('input', (e) => {
    setPaperColor(e.target.value, false);
    const wrap = $('#pageWrap');
    if (wrap) wrap.classList.toggle('show-paper', state.paperTint);
  });
  $('#paperDetect').addEventListener('click', async () => {
    if (!state.doc) { toast('Abre un documento primero.', 'err'); return; }
    toast('Detectando color del papel…');
    await ensurePaper(state.page, true);
    toast('Color del papel: ' + paperColor(state.page).toUpperCase());
  });
  $('#paperApplyCovers').addEventListener('click', applyPaperToCovers);
  $('#paperAllPages').addEventListener('click', applyPaperAllPages);
  $('#printPreview').addEventListener('change', (e) => togglePaperPreview(e.target.checked));

  // --- Quitar fondo ---
  $('#bgpClose').addEventListener('click', () => { $('#bgPanel').hidden = true; });
  $('#bgpTol').addEventListener('input', (e) => { $('#bgpTolVal').textContent = e.target.value; });
  $('#bgpFeather').addEventListener('input', (e) => { $('#bgpFeatherVal').textContent = e.target.value; });
  $('#bgpApply').addEventListener('click', applyBgPanel);
  $('#bgpAuto').addEventListener('click', async () => {
    if (!state.doc) return;
    const col = await ensurePaper(state.page);
    state.bgPick = { color: col, page: state.page };
    $('#bgpSwatch').style.background = col;
    $('#bgpInfo').textContent = 'Color del papel ' + col.toUpperCase();
  });
  $('#exPaper').addEventListener('change', (e) => {
    $('#exPaperVal').style.opacity = e.target.checked ? '1' : '.4';
  });

  $$('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  $('#zoomIn').addEventListener('click', async () => {
    state.zoom = clamp(state.zoom * 1.15, 0.15, 5); await renderPage();
  });
  $('#zoomOut').addEventListener('click', async () => {
    state.zoom = clamp(state.zoom / 1.15, 0.15, 5); await renderPage();
  });
  $('#zoomFit').addEventListener('click', async () => { fitZoom(); await renderPage(); });

  $('#prevPage').addEventListener('click', async () => {
    if (state.page > 1) { state.page--; $('#pageNum').value = state.page; await renderPage(); }
  });
  $('#nextPage').addEventListener('click', async () => {
    if (state.doc && state.page < state.doc.numPages) {
      state.page++; $('#pageNum').value = state.page; await renderPage();
    }
  });
  $('#pageNum').addEventListener('change', async (e) => {
    if (!state.doc) return;
    state.page = clamp(parseInt(e.target.value) || 1, 1, state.doc.numPages);
    e.target.value = state.page;
    await renderPage();
  });

  $('#btnAddVar').addEventListener('click', () => {
    const v = addVar(slugKey('dato'), '');
    renderVars();
    const inp = document.querySelector(`.var-item[data-vid="${v.id}"] input.vval`);
    if (inp) inp.focus();
  });

  // arrastrar y soltar
  const viewer = $('#viewer');
  ['dragenter', 'dragover'].forEach((ev) =>
    viewer.addEventListener(ev, (e) => {
      e.preventDefault();
      $('#dropzone').classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    viewer.addEventListener(ev, (e) => {
      e.preventDefault();
      $('#dropzone').classList.remove('drag');
    })
  );
  viewer.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) abrirArchivo(f);
  });

  // atajos
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select, [contenteditable="true"]')) return;
    const k = e.key.toLowerCase();
    if (k === 'v') setTool('select');
    if (k === 't') setTool('text');
    if (k === 'e') setTool('pick');
    if (k === 'b') setTool('erase');
    if (k === 'i') setTool('image');
    if (k === 'f') setTool('bg');
    if (k === 'p' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); printDoc(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
      e.preventDefault();
      deleteOverlay(state.selected);
    }
    if (e.key === 'Escape') {
      state.selected = null;
      $$('.ov').forEach((el) => el.classList.remove('selected'));
      renderProps();
    }
  });

  setTool('select');
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
