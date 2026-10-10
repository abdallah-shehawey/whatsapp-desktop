/*
 * The chat wallpaper's doodles, drawn once instead of in every chat.
 *
 * WhatsApp draws them as a mask: an overlay the size of the conversation,
 * coloured, carrying `mask-image: url(...svg)` inline -- one SVG of 360 stroked
 * paths, repeated every 540x960. A mask is rastered with the layer it masks,
 * and the overlay is a new element in every chat, so every chat opened or
 * switched to triangulates those 360 strokes again, tile by tile. Traced in the
 * GPU process on a 2560x1440 panel at 1.4x: twelve tiles of about 6ms each,
 * 1440 TriangulatingPathOps, 75ms of raster per switch -- and it lands in the
 * middle of the chat's entrance, which stalls for 30-60ms while it runs.
 *
 * So the SVG is drawn once, into a bitmap the size it is shown at on this
 * screen, and the overlay masks with that instead. A bitmap mask is one
 * texture per tile. The pixels are the same ones: the same file, drawn at the
 * same device size, read through the same alpha.
 *
 * The bitmap goes in through an author !important rule keyed on the SVG's own
 * URL, which outranks the inline declaration without touching it -- React
 * owns that style attribute, and a wallpaper that is an image rather than the
 * doodles, or a doodle file this has not drawn yet, matches nothing here and is
 * left exactly as WhatsApp draws it.
 */
'use strict';

const OVERLAY = '[data-testid^="conversation-background"]';
const SVG_MASK = /url\("?([^")]+\.svg(?:\?[^")]*)?)"?\)/;
/* Kept between launches, so the first chat after a start is drawn from the
   bitmap too. Cache Storage takes only http(s) keys; this one never leaves the
   page. */
const CACHE = 'whatsapp-desktop-wallpaper-v1';
const CACHE_KEY = 'https://whatsapp-desktop.invalid/doodle/';
const KEEP = 4;

const start = ({ log = () => {}, window: view = window } = {}) => {
  const doc = view.document;
  /* svg url + mask size + scale -> object URL of the bitmap */
  const drawn = new Map();
  const drawing = new Set();
  let sheet = null;

  const keyOf = (url, size, scale) => `${url} ${size} @${scale}`;

  const publish = () => {
    const head = doc.head || doc.documentElement;
    if (!head) return;
    if (!sheet || !sheet.isConnected) {
      sheet = doc.createElement('style');
      sheet.id = 'whatsapp-desktop-wallpaper';
      head.appendChild(sheet);
    }
    const scale = view.devicePixelRatio || 1;
    const rules = [];
    for (const [key, png] of drawn) {
      const [url, size, at] = key.split(' ');
      if (at !== '@' + scale) continue;
      /* The size is WhatsApp's, still inline: the bitmap is drawn at that
         size times the screen's scale, so it lands one pixel per pixel. */
      if (!size) continue;
      rules.push(`${OVERLAY}[style*=${JSON.stringify(url)}] {
  mask-image: url("${png}") !important;
  -webkit-mask-image: url("${png}") !important;
}`);
    }
    sheet.textContent = rules.join('\n');
  };

  /* One file, once per scale, off the path of anything moving: fetched from
     WhatsApp's own CDN (it answers this origin's CORS), drawn from a blob so
     the canvas stays readable, encoded off the main thread by toBlob. */
  const draw = async (url, width, height, scale) => {
    const res = await view.fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const source = view.URL.createObjectURL(new view.Blob([await res.text()], { type: 'image/svg+xml' }));
    try {
      const image = new view.Image();
      image.src = source;
      await image.decode();
      const canvas = doc.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) =>
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('no bitmap')), 'image/png'));
    } finally {
      view.URL.revokeObjectURL(source);
    }
  };

  const idle = fn => typeof view.requestIdleCallback === 'function'
    ? view.requestIdleCallback(fn, { timeout: 1000 }) : view.setTimeout(fn, 200);

  const scan = () => {
    const scale = view.devicePixelRatio || 1;
    /* A rule restored at document start may have had no head to go in, or
       gone with the html element the parser replaced. */
    if (drawn.size && (!sheet || !sheet.isConnected)) publish();
    for (const overlay of doc.querySelectorAll(OVERLAY)) {
      const inline = overlay.getAttribute('style') || '';
      const match = SVG_MASK.exec(inline);
      if (!match) continue;
      const size = /mask-size:\s*([\d.]+)px\s+([\d.]+)px/.exec(inline);
      if (!size) continue;
      const [width, height] = [Number(size[1]), Number(size[2])];
      const key = keyOf(match[1], `${width}x${height}`, scale);
      if (drawn.has(key) || drawing.has(key)) continue;
      drawing.add(key);
      idle(() => {
        draw(match[1], width, height, scale).then(png => {
          drawn.set(key, view.URL.createObjectURL(png));
          publish();
          keep(key, png);
          log(`wallpaper: doodles drawn once at ${Math.round(width * scale)}x${Math.round(height * scale)}`);
        }).catch(err => {
          log('wallpaper: doodles left as WhatsApp draws them: ' + err.message);
        }).finally(() => drawing.delete(key));
      });
    }
  };

  const store = () => (view.caches && typeof view.caches.open === 'function')
    ? view.caches.open(CACHE) : Promise.reject(new Error('no cache storage'));

  /* The newest few, the rest let go: a doodle file WhatsApp has replaced is
     not coming back. */
  const keep = (key, png) => store().then(async cache => {
    await cache.put(CACHE_KEY + encodeURIComponent(key),
      new view.Response(png, { headers: { 'content-type': 'image/png' } }));
    const old = await cache.keys();
    for (const request of old.slice(0, Math.max(0, old.length - KEEP))) await cache.delete(request);
  }).catch(() => {});

  /* Whatever this screen's scale has already been drawn at, back before the
     first chat opens. */
  const restored = store().then(async cache => {
    const scale = view.devicePixelRatio || 1;
    for (const request of await cache.keys()) {
      const key = decodeURIComponent(request.url.slice(CACHE_KEY.length));
      if (!key.endsWith(' @' + scale) || drawn.has(key)) continue;
      const res = await cache.match(request);
      if (res) drawn.set(key, view.URL.createObjectURL(await res.blob()));
    }
    if (drawn.size) publish();
  }).catch(() => {});

  return { scan, restored };
};

module.exports = { start, OVERLAY };
