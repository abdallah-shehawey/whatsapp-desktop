/* A handle on the inserted user stylesheet, so the scroll probe in debug.js can
   measure the page with it and without it. Nothing else uses this. */
'use strict';

let ref: { get: any; win: any; set: any; } | null = null;

const track = (win: any, get: any, set: any) => { ref = { win, get, set }; };

/* Apply one piece of the sheet on its own. The scroll probe uses it to find
   which rule costs what, which is the only way to answer that honestly. */
const set = async (css: any) => {
  if (!ref) return false;
  const key = ref.get();
  if (key) await ref.win.webContents.removeInsertedCSS(key);
  ref.set(css ? await ref.win.webContents.insertCSS(css, { cssOrigin: 'user' }) : null);
  return true;
};

const drop = async () => {
  if (!ref) return false;
  const key = ref.get();
  if (!key) return false;
  await ref.win.webContents.removeInsertedCSS(key);
  ref.set(null);
  return true;
};

module.exports = { track, drop, set };
