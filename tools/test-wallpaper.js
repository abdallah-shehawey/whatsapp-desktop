'use strict';

/* The doodles drawn once into a bitmap instead of from 360 stroked paths in
   every chat -- see src/page/wallpaper.js. Replayed against a fake page: no
   browser, no network, no canvas. */

const assert = require('assert');
const { start, OVERLAY } = require('../src/page/wallpaper.js');

const SVG = 'https://static.whatsapp.net/rsrc.php/yx/r/voSdkk88H7C.svg';
const doodleStyle = url => `mask-image: url("${url}"); mask-repeat: repeat; mask-mode: alpha; mask-size: 540px 960px;`;

const rig = ({ scale = 1.4, fetchFails = false, cached = [] } = {}) => {
  const overlays = [];
  const idle = [];
  const logs = [];
  const fetched = [];
  const drawnSizes = [];
  let objectUrls = 0;
  const store = new Map(cached.map(([key, body]) => [key, body]));
  const head = { children: [], appendChild(el) { el.isConnected = true; this.children.push(el); } };
  const document = {
    head,
    documentElement: head,
    createElement: tag => tag === 'canvas' ? {
      width: 0, height: 0,
      getContext: () => ({ drawImage(img, x, y, w, h) { drawnSizes.push([w, h]); } }),
      toBlob(cb, type) { cb({ type, bytes: this.width * this.height }); },
    } : { tag, textContent: '', isConnected: false },
    querySelectorAll: selector => {
      assert.equal(selector, OVERLAY);
      return overlays;
    },
  };
  const view = {
    document,
    devicePixelRatio: scale,
    fetch: async url => {
      fetched.push(url);
      if (fetchFails) throw new Error('offline');
      return { ok: true, status: 200, text: async () => '<svg/>' };
    },
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts.type; } },
    URL: { createObjectURL: () => 'blob:https://web.whatsapp.com/' + (++objectUrls), revokeObjectURL() {} },
    Image: class { decode() { return Promise.resolve(); } },
    Response: class { constructor(body, init) { this.body = body; this.headers = init.headers; } },
    requestIdleCallback: fn => idle.push(fn),
    setTimeout: fn => idle.push(fn),
    caches: {
      open: async () => ({
        put: async (key, res) => { store.set(key, res.body); },
        keys: async () => [...store.keys()].map(url => ({ url })),
        match: async request => store.has(request.url) ? { blob: async () => store.get(request.url) } : null,
        delete: async request => store.delete(request.url),
      }),
    },
  };
  const wallpaper = start({ window: view, log: line => logs.push(line) });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    wallpaper, overlays, idle, logs, fetched, drawnSizes, store,
    sheet: () => head.children.find(el => el.id === 'whatsapp-desktop-wallpaper'),
    runIdle: async () => { while (idle.length) idle.shift()(); for (let i = 0; i < 5; i++) await settle(); },
    settle,
  };
};

(async () => {
  /* A chat with the doodles: drawn once, at the size shown times the scale. */
  const r = rig();
  await r.wallpaper.restored;
  r.overlays.push({ getAttribute: () => doodleStyle(SVG) });
  r.wallpaper.scan();
  assert.equal(r.fetched.length, 0, 'nothing is drawn on the path of a chat opening; it waits for idle');
  await r.runIdle();
  assert.deepEqual(r.fetched, [SVG]);
  assert.deepEqual(r.drawnSizes, [[756, 1344]], '540x960 at 1.4x is drawn 756x1344: one bitmap pixel per screen pixel');
  const rule = r.sheet().textContent;
  assert.match(rule, new RegExp('\\[data-testid\\^="conversation-background"\\]\\[style\\*="' + SVG.replace(/[.?]/g, '\\$&') + '"\\]'),
    'the rule is keyed on the SVG file itself, so another wallpaper matches nothing');
  assert.match(rule, /mask-image: url\("blob:https:\/\/web\.whatsapp\.com\/\d+"\) !important;/);
  assert.doesNotMatch(rule, /mask-size/, 'the size stays WhatsApp\'s own');
  assert.ok(r.logs.some(line => /drawn once at 756x1344/.test(line)));

  /* The next chat: the same file is not drawn again. */
  r.wallpaper.scan();
  await r.runIdle();
  assert.equal(r.fetched.length, 1, 'a second chat with the same doodles reuses the bitmap');

  /* Kept for the next launch. */
  assert.equal(r.store.size, 1, 'the bitmap is kept in Cache Storage');

  /* An image wallpaper, or no mask at all, is left exactly as it is. */
  const plain = rig();
  plain.overlays.push({ getAttribute: () => 'background-image: url("https://example.invalid/a.jpg");' });
  plain.overlays.push({ getAttribute: () => '' });
  plain.wallpaper.scan();
  await plain.runIdle();
  assert.equal(plain.fetched.length, 0, 'only an SVG mask is redrawn');

  /* Offline: logged once, no rule, and the next chat tries again. */
  const offline = rig({ fetchFails: true });
  offline.overlays.push({ getAttribute: () => doodleStyle(SVG) });
  offline.wallpaper.scan();
  await offline.runIdle();
  assert.ok(offline.logs.some(line => /left as WhatsApp draws them: offline/.test(line)));
  assert.ok(!offline.sheet() || offline.sheet().textContent === '', 'a failed draw publishes nothing');
  offline.wallpaper.scan();
  await offline.runIdle();
  assert.equal(offline.fetched.length, 2, 'a failed draw is retried by the next scan');

  /* A later launch: the bitmap for this scale is back before any chat opens,
     and one drawn at another scale is not used. */
  const key = scale => 'https://whatsapp-desktop.invalid/doodle/' + encodeURIComponent(`${SVG} 540x960 @${scale}`);
  const relaunch = rig({ cached: [[key(1.4), { png: true }], [key(2), { png: true }]] });
  await relaunch.wallpaper.restored;
  const restoredRule = relaunch.sheet().textContent;
  assert.equal((restoredRule.match(/\[style\*=/g) || []).length, 1, 'only the bitmap drawn at this screen\'s scale is restored');
  relaunch.overlays.push({ getAttribute: () => doodleStyle(SVG) });
  relaunch.wallpaper.scan();
  await relaunch.runIdle();
  assert.equal(relaunch.fetched.length, 0, 'the first chat after a launch draws nothing at all');

  /* The cache keeps the newest few files, not every one ever drawn. */
  const many = rig();
  for (let i = 0; i < 6; i++) {
    many.overlays.length = 0;
    many.overlays.push({ getAttribute: () => doodleStyle(SVG.replace('.svg', i + '.svg')) });
    many.wallpaper.scan();
    await many.runIdle();
  }
  assert.equal(many.store.size, 4, 'four bitmaps are kept; older doodle files are let go');

  console.log('wallpaper checks pass');
})().catch(err => { console.error(err); process.exit(1); });
