/*
 * The face a chat wears when it has no picture of its own.
 *
 * A banner for a chat with no photo used to go out wearing the application
 * icon -- the same green WhatsApp mark on every one of them -- because the
 * picture path has exactly two answers, the thumbnail from the store and the
 * <img> the chat list drew, and a chat with no photo has neither. The phone
 * does not do that: it draws a coloured circle with a group or a person in it,
 * a different colour per chat, and that circle is as much a chat's face as a
 * photograph would be. The owner asked for the same thing here, three times:
 * once for groups, once for people, and once for a community's announcement
 * channel, which wears a megaphone on a rounded square rather than a circle.
 *
 * It is WhatsApp's own answer and not a lookalike. Both halves are asked of the
 * page:
 *
 *   useWAWebDefaultProfileColors.getWDSProfilePhotoColor(wid)  ->  "green"
 *   useWAWebDefaultProfileColors.getWDSProfilePhotoType(wid)   ->  "group"
 *   WDSProfilePhotoUtils.colorTokenMap.green                   ->  the two
 *                                        CSS custom properties for that colour
 *
 * so a chat drawn green in the list is drawn green on the banner, and a theme
 * change moves both together. Measured on the live account: eleven colours,
 * each a dark surface and a bright glyph -- green is #103529 behind #25D366 --
 * which is the dark theme this client runs in, resolved from the page's own
 * custom properties rather than written down here.
 *
 * The circle is painted rather than fetched. There is no URL for a picture that
 * does not exist: the chat list draws one as an inline <svg> holding the glyph
 * alone, with the circle behind it a background-color and a border-radius in
 * the page's own stylesheet -- measured, on a row whose group has no photo --
 * and a notification takes a PATH to an image file, not a node and not a rule.
 * So the same two things are drawn onto a canvas, an arc in the surface colour
 * and the icon's own path in the content colour, and handed over as PNG bytes,
 * which is what every other picture in this client already is.
 *
 * The paths are Meta's, lifted from the live page: the three WDS icons its own
 * getPlaceholderIcon names (`ic-person-filled`, `ic-group-filled`,
 * `ic-campaign-megaphone-filled`), the two of `default-community-refreshed`,
 * and the squircle. Copying them is the one thing here that could go stale, and
 * it was still the right way round. They cannot be read at run time: the WDS
 * icon modules are lazy stubs -- `String()` of one is thirty-five characters
 * with no path in it -- and they only draw once WhatsApp's own React has
 * resolved them, which is a render this client has no business starting for a
 * banner. Reading them off whichever row happens to be on screen answers
 * nothing either: while the window is away, no row is. A redrawn icon costs a
 * slightly old glyph on a banner and nothing else.
 */
'use strict';

/*
 * The four faces, and which chat wears which.
 *
 * WhatsApp's own DefaultIcon asks the questions in this order and so does
 * faceFor below: an announcement group first, then a community, then any other
 * group, and a person when it is not a group at all. The first two are drawn on
 * a SQUIRCLE -- the rounded square the chat list gives a community and its
 * announcement channel -- and the other two on a circle. That was the second
 * half of the report: "مفيش بقي ايقونه كمان لل community لو ملهوش صوره".
 *
 * `view` is the box each path was drawn on and `share` how much of the picture
 * the glyph fills. The two WDS icons and the megaphone are 24-unit icons that
 * WhatsApp sizes to 22 of a 48px photo, so they keep that ratio; the community
 * icon is a 48-unit "refreshed" drawing with its own margin already in it, so
 * it is drawn across the whole face.
 */
const GLYPHS = {
  person: {
    view: 24, share: 22 / 48, shape: 'circle',
    paths: [{ d: 'M12 12c-1.1 0-2.04-.4-2.82-1.18A3.85 3.85 0 0 1 8 8c0-1.1.4-2.04 1.18-2.83A3.85 3.85 0 0 1 12 4c1.1 0 2.04.4 2.82 1.17A3.85 3.85 0 0 1 16 8c0 1.1-.4 2.04-1.18 2.82A3.85 3.85 0 0 1 12 12Zm-6 8c-.55 0-1.02-.2-1.41-.59-.4-.39-.59-.86-.59-1.41v-.8c0-.57.15-1.09.44-1.56a2.9 2.9 0 0 1 1.16-1.09 13.76 13.76 0 0 1 9.65-1.16c1.07.26 2.12.64 3.15 1.16.48.25.87.61 1.16 1.09.3.47.44 1 .44 1.56v.8c0 .55-.2 1.02-.59 1.41-.39.4-.86.59-1.41.59H6Z' }],
  },
  group: {
    view: 24, share: 22 / 48, shape: 'circle',
    paths: [{ d: 'M1 17.2c0-.57.15-1.09.44-1.56a2.9 2.9 0 0 1 1.16-1.09 13.76 13.76 0 0 1 9.65-1.16c1.07.26 2.12.64 3.15 1.16.48.25.87.61 1.16 1.09.3.47.44 1 .44 1.56v.8c0 .55-.2 1.02-.59 1.41-.39.4-.86.59-1.41.59H3c-.55 0-1.02-.2-1.41-.59-.4-.39-.59-.86-.59-1.41v-.8ZM18.45 20a3.65 3.65 0 0 0 .55-2v-1a4 4 0 0 0-.61-2.11 5.4 5.4 0 0 0-1.74-1.74 12.61 12.61 0 0 1 4.5 1.4c.6.33 1.06.7 1.38 1.11.31.41.47.86.47 1.34v1c0 .55-.2 1.02-.59 1.41-.39.4-.86.59-1.41.59h-2.55ZM9 12a3.9 3.9 0 0 1-2.83-1.18A3.85 3.85 0 0 1 5 8c0-1.1.4-2.04 1.17-2.83A3.85 3.85 0 0 1 9 4c1.1 0 2.04.4 2.82 1.17A3.85 3.85 0 0 1 13 8c0 1.1-.4 2.04-1.18 2.82A3.85 3.85 0 0 1 9 12Zm10-4c0 1.1-.4 2.04-1.18 2.82a3.85 3.85 0 0 1-3.52 1.12 6.13 6.13 0 0 1-.7-.14A5.95 5.95 0 0 0 15 8a5.76 5.76 0 0 0-1.4-3.8c.23-.08.47-.14.7-.16.23-.03.47-.04.7-.04 1.1 0 2.04.4 2.82 1.17A3.85 3.85 0 0 1 19 8Z' }],
  },
  /* A community's announcement channel: the megaphone, on a squircle. */
  announcement: {
    view: 24, share: 22 / 48, shape: 'squircle',
    paths: [{ d: 'M21.1 12.93h-2a.97.97 0 0 1-.72-.28.97.97 0 0 1-.28-.72.97.97 0 0 1 1-1h2c.28 0 .52.1.7.3.2.18.3.42.3.7 0 .29-.1.53-.3.72a.93.93 0 0 1-.7.28Zm-4.4 3.8a.91.91 0 0 1 .65-.4c.26-.03.51.04.75.2l1.6 1.2c.23.17.36.39.4.65.03.27-.04.52-.2.75a.91.91 0 0 1-.65.4.98.98 0 0 1-.75-.2l-1.6-1.2a.91.91 0 0 1-.4-.65 1 1 0 0 1 .2-.75Zm3-10.6-1.6 1.2a1 1 0 0 1-.75.2.91.91 0 0 1-.65-.4 1.03 1.03 0 0 1-.2-.75.91.91 0 0 1 .4-.65l1.6-1.2c.23-.16.48-.23.75-.2.26.04.48.17.65.4.16.24.23.49.2.75a.91.91 0 0 1-.4.65Zm-14.6 8.8h-1a2 2 0 0 1-2-2v-2c0-.55.2-1.02.58-1.4.4-.4.87-.6 1.42-.6h4l3.47-2.1c.33-.2.67-.2 1.01 0 .35.2.52.5.52.88v8.45c0 .38-.17.67-.52.87a.9.9 0 0 1-1 0l-3.48-2.1h-1v3c0 .29-.1.53-.3.72a.93.93 0 0 1-.7.28.97.97 0 0 1-.72-.28.97.97 0 0 1-.28-.72v-3Zm9 .35v-6.7a4.57 4.57 0 0 1 1.5 3.35 4.57 4.57 0 0 1-1.5 3.35Z' }],
  },
  /* The community itself. Two paths, and the second is filled by the even-odd
     rule -- drawn with the default rule its heads are filled in solid. */
  community: {
    view: 48, share: 1, shape: 'squircle',
    paths: [{ d: 'M15.03 24.9a9.5 9.5 0 0 0-2.97.35c-.59.16-1.26.44-1.82.87a2.96 2.96 0 0 0-1.2 2.02C8.98 28.57 9 29.5 9 30c.02.93.78 2 1.69 2h3.76a5.83 5.83 0 0 1-.37-1.92c-.02-.55-.06-2.04.05-2.83.05-.4.15-.8.28-1.15a5.4 5.4 0 0 1 .6-1.2M33.95 32h3.76c.91 0 1.67-1.07 1.69-2 .01-.51.02-1.43-.02-1.86a2.97 2.97 0 0 0-1.2-2.02 5.44 5.44 0 0 0-1.83-.87 9.5 9.5 0 0 0-2.97-.35 5.17 5.17 0 0 1 .9 2.35c.1.8.06 2.28.04 2.83a5.83 5.83 0 0 1-.37 1.92' },
            { d: 'M19.8 24.38a16 16 0 0 1 4.4-.61c1.82 0 3.34.3 4.4.61.54.16 1.2.39 1.78.75.6.36 1.19.9 1.48 1.73q.12.32.17.7c.08.56.05 1.82.03 2.46-.03.91-.78 1.98-1.68 1.98H18.02c-.9 0-1.65-1.07-1.68-1.98-.02-.64-.05-1.9.03-2.46q.05-.38.17-.7a3.4 3.4 0 0 1 1.48-1.73 7.28 7.28 0 0 1 1.78-.75m10.6-4.63a3.37 3.37 0 0 1 3.37-3.37 3.37 3.37 0 0 1 3.38 3.37 3.38 3.38 0 0 1-3.38 3.38 3.38 3.38 0 0 1-3.38-3.38m-10.7-2.24A4.51 4.51 0 0 1 24.2 13a4.51 4.51 0 0 1 4.5 4.51 4.5 4.5 0 0 1-4.5 4.5 4.5 4.5 0 0 1-4.5-4.5m-8.45 2.24a3.37 3.37 0 0 1 3.38-3.37 3.37 3.37 0 0 1 3.38 3.37 3.38 3.38 0 0 1-3.38 3.38 3.38 3.38 0 0 1-3.38-3.38', rule: 'evenodd' }],
  },
};

/* WhatsApp's own squircle, WDSProfilePhotoUtils.SQUIRCLE_PATH, on the 200-unit
   box it is written for. Copied for the same reason the glyphs are: it is a
   constant in a module that has no other way in. */
const SQUIRCLE = 'M 0, 100 C 0, 20 20, 0 100, 0 S 200, 20 200, 100 180, 200 100, 200 0, 180 0, 100';
const SQUIRCLE_VIEW = 200;

/* Which group type wears which face, in WhatsApp's own order. Anything else --
   a plain group, a subgroup, the community's General -- is a group. */
const KINDS = {
  LINKED_ANNOUNCEMENT_GROUP: 'announcement',
  COMMUNITY: 'community',
};

/* What is drawn. A banner shows this at about 48px, twice that on a screen that
   doubles, and a flat shape with one glyph in it costs a couple of kilobytes
   as a PNG at any of those -- so it is drawn big enough that nothing has to
   guess, once per colour and kind for the life of the client. */
const SIZE = 192;

const make = ({ grab }) => {
  /* Keyed on what is actually drawn -- the kind and the two colours -- rather
     than on the colour's name, so a theme change draws a new circle instead of
     handing back the one from the old theme. */
  const drawn = new Map();

  /* The value behind a `var(--name)`, asked of the page. The tokens are custom
     properties on the document element and their values are what the theme
     currently says they are. */
  const resolved = value => {
    const said = String(value == null ? '' : value).trim();
    const named = /var\((--[\w-]+)\)/.exec(said);
    if (!named) return said;
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(named[1]).trim();
    } catch (e) { return ''; }
  };

  const paint = (surface, content, glyph) => {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof Path2D !== 'function') return '';

    /* The face itself. A squircle is a path like any other and is scaled from
       its own box the same way the glyph is. */
    ctx.fillStyle = surface;
    if (glyph.shape === 'squircle') {
      ctx.save();
      ctx.scale(SIZE / SQUIRCLE_VIEW, SIZE / SQUIRCLE_VIEW);
      ctx.fill(new Path2D(SQUIRCLE));
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    const scale = (SIZE * glyph.share) / glyph.view;
    const inset = (SIZE - glyph.view * scale) / 2;
    ctx.translate(inset, inset);
    ctx.scale(scale, scale);
    ctx.fillStyle = content;
    for (const part of glyph.paths) ctx.fill(new Path2D(part.d), part.rule || 'nonzero');

    /* Nothing tainted the canvas -- the shape and the paths are drawn, not
       loaded -- so the bytes come straight back out of it. */
    const url = canvas.toDataURL('image/png');
    const comma = url.indexOf(',');
    return comma > 0 ? url.slice(comma + 1) : '';
  };

  /* The placeholder for one account, as base64 PNG, or '' when the page cannot
     say what it would draw. Empty is a real answer and the caller has one: the
     application icon, which is where every one of these used to end up.

     `groupType` is the chat's own, and it is the only place the difference
     between a group, a community and its announcement channel is written down:
     the colour module answers "group" for all three. */
  const faceFor = (wid, groupType) => {
    if (!wid || typeof document === 'undefined') return '';

    const colors = grab('useWAWebDefaultProfileColors');
    const utils = grab('WDSProfilePhotoUtils');
    if (!colors || !utils || !utils.colorTokenMap) return '';

    let name = '';
    let kind = '';
    try {
      name = String(colors.getWDSProfilePhotoColor(wid) || '');
      kind = KINDS[groupType] || String(colors.getWDSProfilePhotoType(wid) || '');
    } catch (e) { return ''; }

    const token = utils.colorTokenMap[name] || utils.colorTokenMap.gray;
    if (!token) return '';
    const surface = resolved(token.surface);
    const content = resolved(token.content);
    if (!surface || !content) return '';

    const key = kind + '|' + surface + '|' + content;
    if (drawn.has(key)) return drawn.get(key);

    let face = '';
    try { face = paint(surface, content, GLYPHS[kind] || GLYPHS.person); } catch (e) { face = ''; }
    /* Kept even when it is empty: a page that cannot draw one will not draw the
       next one either, and the alternative is a canvas per banner. */
    if (drawn.size > 64) drawn.clear();
    drawn.set(key, face);
    return face;
  };

  return { faceFor };
};

module.exports = { make, GLYPHS, KINDS, SIZE, SQUIRCLE };
