'use strict';

/*
 * The name, application id and command this copy of the client goes by.
 *
 * The source tree and the project's own packages carry data/brand.json: the
 * client as its users know it. A build made for a store or a distribution
 * archive -- which take neither a vendor's name nor its logo on a client that
 * vendor did not make -- installs data/brands/<brand>/brand.json in its place,
 * with that brand's icons and desktop entries beside it (BRAND= in the
 * Makefile). Nothing at run time chooses between them: the file that was
 * installed is the brand.
 */
const brand = require('../data/brand.json');

for (const key of ['id', 'name', 'bin']) {
  if (typeof brand[key] !== 'string' || !brand[key]) {
    throw new Error(`data/brand.json has no "${key}"`);
  }
}

/* The client's own pages are written under the default name, and every element
   that names the client rather than the service is marked data-brand. Under
   another brand a page's preload hands its document here, and those elements
   are rewritten as the page is parsed, before anything has been laid out. */
const brandDocument = doc => {
  const apply = () => {
    for (const el of doc.querySelectorAll('[data-brand]')) {
      el.textContent = el.textContent.replace(/WhatsApp/g, brand.name);
    }
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
};

module.exports = Object.freeze({ id: brand.id, name: brand.name, bin: brand.bin, brandDocument });
