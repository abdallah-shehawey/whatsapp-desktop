'use strict';

const assert = require('assert');
const style = require('../src/style.js');

const shipped = style.build({ fontSize: 16 });
/* The element this build actually scrolls. It was checked on the live page: the
   panel body is not the scroller, and this build spells the marker data-testid,
   so the rule as first written applied to nothing at all. */
assert.match(shipped, /#main \[data-testid="conversation-panel-messages"\]/);
assert.doesNotMatch(shipped, /conversation-panel-body/);
assert.match(shipped, /will-change:\s*scroll-position/);
assert.match(shipped, /transform:\s*translate3d\(0, 0, 0\)/);
assert.doesNotMatch(shipped, /::\-webkit-scrollbar/);
assert.doesNotMatch(shipped, /\*\s*\{\s*font-family/);

/* The Arabic clip and the bidi rules are not switchable and never were worth
   being: every build carries them. */
assert.match(shipped, /padding-bottom: 0\.2em !important/);
assert.match(shipped, /\[contenteditable="true"\][\s\S]*padding-bottom: 0\.35em !important/);

/* Which way a line of a message reads. The body is a block of its own so that a
   wrapping Arabic message aligns to the right and the timestamp is pushed off
   the last line; the lines inside it take their direction from their own first
   strong character. `isolate` on the body and `plaintext` on the lines, never
   the other way round -- plaintext on an inline box hides the only Arabic in it
   from the paragraph around it, and text-align: start then resolves to left. */
const body = shipped.slice(shipped.indexOf('span.selectable-text.copyable-text {'));
assert.match(body, /display: block !important/);
assert.match(body, /unicode-bidi: isolate !important/);
assert.doesNotMatch(body.slice(0, body.indexOf('}')), /plaintext/);
/* And it is the SPAN that is named, with no #main and no div.copyable-text in
   front of it. A picture's caption is the same body under three plain divs, and
   its viewer is mounted outside #main -- the scoped selector this replaced
   reached neither, so an Arabic caption wrapped flush left in both. */
assert.doesNotMatch(body.slice(0, body.indexOf('{')), /#main|div\.copyable-text/);
const lines = shipped.slice(shipped.indexOf('span.selectable-text.copyable-text > span'));
assert.match(lines, /unicode-bidi: plaintext !important/);
/* text-align: start, never `right` -- an English line inside an Arabic message
   belongs on the left, which is the whole point of doing this per line. */
assert.match(lines, /text-align: start !important/);

/* The LAST line of a message, which WhatsApp leaves inline -- so text-align
   says nothing about it and it takes the body's direction, which is the one
   worked out for the whole message. An Arabic opening put every following
   English line on the left correctly and the last one on the right. It is made
   a block like its siblings so the rule above reaches it too. */
const last = shipped.slice(shipped.indexOf('> span:last-child'));
assert.match(shipped, /span\.selectable-text\.copyable-text:not\(\.quoted-mention\) > span:last-child:not\(\.selectable-text\) \{/);
assert.match(last.slice(0, last.indexOf('}')), /display: block !important/);
/* Both guards, and each one is a measured regression if it goes. Without the
   first, a quoted voice note grows a storey -- its preview is inline on purpose
   and a block cannot share that line (24px -> 38px, measured). Without the
   second, a one-line message ending in a mention drops the mention onto a line
   of its own: a piece is a plain span, a mention wears selectable-text. */
assert.match(shipped, /:not\(\.quoted-mention\) > span:last-child/);
assert.match(shipped, /> span:last-child:not\(\.selectable-text\)/);
/* And it stays a `display` rule: the body keeps `isolate`, which is what places
   a one-line Arabic message. plaintext there hides the only Arabic in the box
   behind an isolate and the whole fix undoes itself -- measured, twice. */
assert.doesNotMatch(last.slice(0, last.indexOf('}')), /unicode-bidi/);

/* User origin: a normal declaration there loses to the page's own, and
   WhatsApp writes `text-align: end` on exactly the lines this has to correct. */
assert.doesNotMatch(shipped.slice(shipped.indexOf('span.selectable-text')),
                    /text-align: (start|end)(?! !important)/);

/* A community thread. Its panel is outside #main and holds no copyable-text, so
   a rule scoped to either reaches none of it -- which is how thread replies came
   out flush left with the conversation behind them flush right. */
const thread = shipped.slice(shipped.indexOf('[data-testid="comment-row"] span'));
assert.match(shipped, /\n\[data-testid="comment-row"\] span\[data-testid="selectable-text"\] \{/);
assert.match(thread, /display: block !important/);
assert.match(thread, /text-align: start !important/);
/* plaintext HERE and isolate above, and the two are not interchangeable: a
   reply is one span with white-space: pre-line and the newlines still in it, so
   the block IS the thing whose paragraphs need a direction each. Measured with
   isolate instead: an English line inside an Arabic reply went flush right. */
assert.match(thread.slice(0, thread.indexOf('}')), /unicode-bidi: plaintext !important/);
assert.doesNotMatch(thread.slice(0, thread.indexOf('}')), /isolate/);

/* The drawer's own entrance animates flex-basis, which lays the whole app out
   again on every frame of it. Here it is made instant; the motion it loses is
   put back on the compositor by slideTheDrawer() in src/page/inject.js.

   Never `animation: none`: the keyframes END at the width, so cancelling them
   leaves the drawer nought pixels wide and Message info stops opening. */
assert.match(shipped, /\[data-testid="drawer-right"\][\s\S]*animation-duration: 1ms !important/);
assert.doesNotMatch(shipped, /animation: none/);
/* And no motion of our own on THAT panel: a CSS animation on it plays once,
   because it is never unmounted. The slide is inject.js's, on animationstart. */
const drawer = shipped.slice(shipped.indexOf('[data-testid="drawer-right"]'));
assert.doesNotMatch(drawer.slice(0, drawer.indexOf('}')), /animation-name|@keyframes/);

/* The reply bar over the composer is the case turned round -- its panel IS
   unmounted every time, so keyframes on it fire on every mount and that is the
   event inject.js hangs its own entrance and exit on. The rule carries no
   motion itself; it exists to be started. */
assert.match(shipped, /footer \[data-testid="popup_panel"\] \{\n  animation: whatsapp-desktop-panel 1ms !important;/);
assert.match(shipped, /@keyframes whatsapp-desktop-panel/);
/* Not scoped to #main: a community thread draws its composer in a panel of its
   own, outside #main, and a reply written there deserves the same motion. */
assert.doesNotMatch(shipped, /#main footer \[data-testid="popup_panel"\]/);

/* A list of names is a column drawn one way round, and every name in it starts
   where the column does: an Arabic name sits where an English name sits, and
   only the words inside it read right to left.

   The name is the span that carries a dir attribute -- measured on the live
   list, every one of them says dir="auto" and NOT dir="rtl", so a rule written
   for the latter matches nothing at all. That is what the rule this replaced
   did, and it is why the names went on hanging off the right margin. */
const list = shipped.slice(shipped.indexOf('#pane-side span[title][dir]'));
assert.match(list, /text-align: left !important/);
assert.doesNotMatch(list.slice(0, list.indexOf('}')), /text-align: right/);
assert.doesNotMatch(shipped, /#pane-side[^{]*dir="rtl"/);
/* And which way round the column is drawn is WhatsApp's answer, not a constant:
   an Arabic interface puts <html dir="rtl">, the list on the right of the
   window and the picture at the right of every row, and a hard `left` there is
   the whole column pinned to the far side from the pictures. So the second half
   of the rule aligns the names to the right when the pane resolves rtl. */
assert.match(shipped, /#pane-side:dir\(rtl\) span\[title\]\[dir\]/);
assert.match(list.slice(list.indexOf(':dir(rtl)')), /text-align: right !important;/);
/* On the PANE, never on the name. `:dir()` against the span itself is the
   original bug written a second way -- dir="auto" resolves per name, so the
   Arabic ones would go right and the English ones left, which is exactly the
   report both halves of this rule exist to answer. */
assert.doesNotMatch(shipped, /span\[title\]\[dir\]:dir\(/);
/* And neither rule says anything about direction. Alignment is where the text
   sits in its box; `direction` or `unicode-bidi` on a name would be this client
   deciding which way a name reads, which is WhatsApp's answer to give. */
assert.doesNotMatch(list.slice(0, list.indexOf('}')), /direction:|unicode-bidi:/);
assert.doesNotMatch(list.slice(list.indexOf(':dir(rtl)')), /direction:|unicode-bidi:/);

/* The chat list is only one of those columns. The same names are listed again
   in the forward picker, on the Status tab, under New chat and in the search
   results, and each of those is a panel `#pane-side` cannot see -- so the scope
   is the row, which names itself `cell-frame-*` in every one of them. */
assert.match(shipped, /\[data-testid\^="cell-frame-"\] span\[title\]\[dir\]/);
assert.match(shipped, /\[data-testid\^="cell-frame-"\]:dir\(rtl\) span\[title\]\[dir\]/);
/* A PREFIX, and not `cell-frame-title`. A community's name above a group's is
   `cell-frame-label` -- 5 of the 76 names in the live chat list -- so a rule
   aimed at the title alone would drop them out of the column it claims to be
   generalising. `cell-frame-secondary`, the line underneath, comes with it and
   is meant to: it is furniture in the same row. */
assert.doesNotMatch(shipped, /\[data-testid="cell-frame-title"\] span\[title\]/);
/* Both halves of the pane rule stay, or neither does. `#pane-side` carries an
   id, so the plain one (1,2,1) outranks the general `:dir(rtl)` rule (0,4,1);
   drop `#pane-side:dir(rtl)` alone and an Arabic interface pins the chat list
   back to the left, which is the bug the pane rules were written to fix. */
assert.strictEqual(/#pane-side span\[title\]\[dir\]/.test(shipped),
                   /#pane-side:dir\(rtl\) span\[title\]\[dir\]/.test(shipped));

/* And the bio travels with the name it sits under -- "يبقي مع ال bio كمان يعني
   نحركهم الاتنين". A contact's About wears selectable-text and copyable-text on
   a plain div, so BODY above claims it as a message body at (0,3,2) and beats
   the row rule's (0,3,1); the name moved and the bio stayed against the right
   margin. Naming the class lifts the row rule over it. */
assert.match(shipped, /\[data-testid\^="cell-frame-"\] span\[title\]\[dir\]\.selectable-text/);
assert.match(shipped, /\[data-testid\^="cell-frame-"\]:dir\(rtl\) span\[title\]\[dir\]\.selectable-text/);
/* Both directions, or the bio is pinned left in an Arabic interface -- the same
   trap as the pane pair, one rule further down. */
assert.strictEqual(
  (shipped.match(/\[data-testid\^="cell-frame-"\] span\[title\]\[dir\]\.selectable-text/g) || []).length,
  (shipped.match(/\[data-testid\^="cell-frame-"\]:dir\(rtl\) span\[title\]\[dir\]\.selectable-text/g) || []).length);
/* The lift is specificity, not a second declaration: the class is named on the
   SAME rule, so a bio and the name above it can never disagree. */
const rowRule = shipped.slice(shipped.indexOf('#pane-side span[title][dir]'));
assert.match(rowRule.slice(0, rowRule.indexOf('}')), /\.selectable-text[\s\S]*text-align: left/);

/* A name does not always carry a `title`, so the name is asked for by the box
   it sits in as well. The Communities tab draws a community's OWN name with no
   title attribute on the span -- measured, all 5 of them -- so the rule that
   asks for one matched none of them and the Arabic community sat 29px off in
   an English list while its own subgroups were flush. */
assert.match(shipped, /\[data-testid="cell-frame-title"\] span\[dir\]/);
assert.match(shipped, /\[data-testid="cell-frame-label"\] span\[dir\]/);
assert.match(shipped, /\[data-testid="cell-frame-title"\]:dir\(rtl\) span\[dir\]/);
assert.match(shipped, /\[data-testid="cell-frame-label"\]:dir\(rtl\) span\[dir\]/);
/* And the widening stops there. `cell-frame-secondary` is the line UNDER the
   name, and it is a message preview far more often than an About: 68 of the 71
   on the live page carry no title and not one of them is a name. So the PREFIX
   rule keeps its `[title]`, and dropping it would sweep every Arabic preview in
   the chat list into the column. */
assert.doesNotMatch(shipped, /\[data-testid\^="cell-frame-"\] span\[dir\][^\w]/);
assert.doesNotMatch(shipped, /\[data-testid="cell-frame-secondary"\] span\[dir\]/);

/* The bio in the info drawer -- the same request one panel over. A contact's
   About is drawn there with no row around it, so the row rule never reached it:
   measured at 213px off the left in a 465px box, under a name flush at 0.

   The drawer draws a real MESSAGE too (Message info, starred messages), and
   that must keep BODY's treatment or an Arabic one goes flush left in the one
   place it is quoted back at the user. `.copyable-area` does not separate them
   -- all 4 of the drawer's furniture spans sit in one -- but `msg-container`
   does: 14 of 14 message bodies in the conversation are inside one and none of
   the drawer's name/About spans is. Rows are excluded with it, so a search
   MATCH stays governed by the row rule above. */
assert.match(shipped, /\[data-testid="drawer-right"\] span\.selectable-text\.copyable-text:not\(/);
assert.match(shipped, /\[data-testid="drawer-right"\]:dir\(rtl\) span\.selectable-text\.copyable-text:not\(/);
const drawerRule = shipped.slice(shipped.indexOf('[data-testid="drawer-right"] span.selectable-text'));
assert.match(drawerRule.slice(0, drawerRule.indexOf('{')), /\[data-testid="msg-container"\] \*/);
assert.match(drawerRule.slice(0, drawerRule.indexOf('{')), /\[data-testid\^="cell-frame-"\] \*/);
/* Both directions, or the bio is pinned to one margin in the other interface --
   the same trap as the pane pair and the row pair above. */
assert.strictEqual(
  (shipped.match(/\[data-testid="drawer-right"\] span\.selectable-text/g) || []).length,
  (shipped.match(/\[data-testid="drawer-right"\]:dir\(rtl\) span\.selectable-text/g) || []).length);
/* Every one of these is an ALIGNMENT and says nothing about direction: which
   way a name or a bio reads is WhatsApp's answer to give, not this sheet's. */
const wide = shipped.slice(shipped.indexOf('[data-testid="cell-frame-title"] span[dir]'));
assert.doesNotMatch(wide.slice(0, wide.indexOf('}')), /direction:|unicode-bidi:/);

/* There is no size knob for the conversation's own text any more. It was
   `view.chat-font-size`, it was a percentage that belonged to neither script
   beside the two per-script sizes in the Fonts window, and it came out of the
   client on 2026-09-03. What must not come back is a sheet that quietly
   re-sizes messages. */
assert.doesNotMatch(shipped, /0\.888rem/);
assert.doesNotMatch(shipped, /font-size: calc/);
/* An option the sheet no longer knows is not an option: an old config file
   still carrying the key changes nothing. */
assert.strictEqual(style.build({ fontSize: 16, chatScale: 130 }), shipped);
assert.strictEqual(style.build({ fontSize: 16 }, { fontSize: 16, chatScale: 110 }), shipped);

/* Nothing reverts the Arabic rules any more, because nothing turns them off.
   A sheet that is in the page is in it for good -- see style.js -- so a `revert`
   left over from the switch would be the newest rule and would undo them. */
assert.doesNotMatch(shipped, /revert/);

/* The placeholder avatar in the group-invite dialog, which WhatsApp draws at
   212px inside a 104px box. `max-` and not `width` is the whole point: the rule
   has to shrink the one icon that does not fit and leave every icon that does
   exactly where it was, so a plain `width: 100%` here would be the bug. */
assert.match(shipped, /span\[data-icon\] > svg \{[^}]*max-width: 100%/);
assert.match(shipped, /span\[data-icon\] > svg \{[^}]*max-height: 100%/);
assert.doesNotMatch(shipped, /span\[data-icon\] > svg \{[^}]*[^-]width: 100%/);

/*
 * Profile, in Settings, which is the one panel there WhatsApp never animated.
 *
 * Its siblings are slid in by Velocity from translateX(100%) -- sampled on the
 * live page, 336px at 1ms down to under a pixel by 248 -- and Profile mounts
 * into [data-testid="drawer-left"] with animation-name: none and no transform
 * at any point. So the missing half is written here, to those numbers.
 */
const settings = shipped.slice(shipped.indexOf('[data-testid="drawer-left"]'));
assert.match(shipped, /\[data-testid="drawer-left"\] > div > span > div \{/);
/* The CHILD chain, not a descendant one. `[data-testid="drawer-left"] span >
   div` matches four elements on the live page and three of them are furniture
   inside the panel, which would each animate separately; the chain matches the
   panel and nothing else. */
assert.doesNotMatch(shipped, /\[data-testid="drawer-left"\] span > div \{/);
assert.match(settings, /animation: whatsapp-desktop-settings 200ms/);
assert.match(settings, /@keyframes whatsapp-desktop-settings \{\n  from \{ transform: translateX\(100%\); \}/);

/*
 * And NOT opacity, in either direction, which is the fix for the lag reported
 * on the left rail.
 *
 * This rule reaches more than Profile -- Status and Channels mount at the same
 * child chain -- and WhatsApp fades those in itself with Velocity, an inline
 * opacity 0.5 -> 1 that is done in 36ms. An animation declaration at user
 * origin outranks an inline style, so keyframes that carry opacity take that
 * fade over and stretch it to the whole duration: measured from the mount, the
 * panel was drawn at 0 for the first 17ms and at 0.98 still at 143ms, where
 * WhatsApp had it solid at 36. Leaving opacity out hands the fade back.
 */
const settingsBlock = settings.slice(0, settings.indexOf('[role="tooltip"]'));
assert.doesNotMatch(settingsBlock, /opacity/);
/* A real animation and not the 1ms no-op the drawer and the reply bar use: this
   panel is replaced on every open, so a CSS animation runs every time and there
   is nothing for JavaScript to do. The other two are never unmounted. */
assert.doesNotMatch(settings.slice(0, settings.indexOf('}')), /1ms/);
/* And the side is the interface's. transform knows nothing about direction, so
   in Arabic -- where this drawer is on the other edge of the window -- the
   panel would otherwise slide in from the wrong side. */
assert.match(shipped, /html\[dir="rtl"\] \[data-testid="drawer-left"\] > div > span > div/);
assert.match(shipped, /@keyframes whatsapp-desktop-settings-rtl \{\n  from \{ transform: translateX\(-100%\); \}/);

/* The label beside the nav rail -- "You", "Chats" -- which WhatsApp mounts
   already opaque under a `transition: opacity` that therefore never runs. It is
   built on hover and taken out again on leave, so this too is plain CSS.

   `[role="tooltip"]` and not the class it is drawn with: that class is
   generated (.xpip370 today) and the role is in the HTML specification. */
assert.match(shipped, /\[role="tooltip"\] \{\n  animation: whatsapp-desktop-tooltip 120ms/);
assert.match(shipped, /@keyframes whatsapp-desktop-tooltip \{\n  from \{ opacity: 0; transform: scale\(0\.94\)/);
assert.doesNotMatch(shipped, /\.xpip370/);
/* Scale, never a slide: the box is positioned by a popper that writes its own
   transform on the WRAPPER, and a slide here would have to know which side of
   the rail the label came out on. */
assert.doesNotMatch(shipped.slice(shipped.indexOf('whatsapp-desktop-tooltip')), /translateX/);

/*
 * The chat list as cards, and the fact that it is a switch rather than a rule.
 *
 * WhatsApp already draws a 12px-rounded 484x72 box behind every row and already
 * leaves the 4px gap -- measured on the live list -- and paints that box from
 * --WDS-surface-default, which is the very token #pane-side behind it is
 * painted from. So the card is drawn every time and invisible every time, and
 * all this does is raise it by one surface.
 */
const cards = style.build({ fontSize: 16, chatCards: true });
assert.match(cards, /:root\[data-wa-cards\] #pane-side \[role="gridcell"\] > div > div \{/);
/*
 * And it is hung off a mark as well as left out of the sheet, which is belt as
 * well as braces and is not redundant. Leaving it out keeps it off a page that
 * LOADED with the switch off; the mark is what takes it off a page where the
 * switch has just been MOVED -- a sheet inserted at user origin cannot be taken
 * out again (measured; see the foot of src/style.js), so without the mark the
 * cards stayed on until the next restart. That was reported, and it is the same
 * fault that left a palette on after Default.
 */
assert.ok(style.CARDS_MARK, 'the mark is exported, because the client has to write it');
assert.ok(cards.includes('[' + style.CARDS_MARK + ']'));
assert.match(cards, /background-color: var\(--WDS-surface-elevated-default\) !important/);
/* A token and not a colour, so the one switch is right on every palette and on
   WhatsApp's own two without anything being kept in step. */
assert.doesNotMatch(cards.slice(cards.indexOf('#pane-side [role="gridcell"]')), /#[0-9a-f]{6}/i);
/* Nothing is moved: the rounding, the width and the gap are WhatsApp's. */
const cardRule = cards.slice(cards.indexOf('#pane-side [role="gridcell"]'));
assert.doesNotMatch(cardRule.slice(0, cardRule.indexOf('}')), /margin|border-radius|height|padding/);

/* And off is OUT of the sheet, not overridden in it. The rightmost compound is
   a bare `div`, so Chromium starts this at every div on the page and rules it
   out on the next step -- cheap, but paid on the one list in this client that
   redraws constantly, and not worth paying for a feature that is switched off.
   The privacy sheet is the same lesson learnt the expensive way. */
assert.doesNotMatch(shipped, /#pane-side \[role="gridcell"\]/);
assert.doesNotMatch(shipped, /data-wa-cards/);
assert.strictEqual(style.build({ fontSize: 16, chatCards: false }), shipped);
assert.strictEqual(cards.length > shipped.length, true);

console.log('style checks pass');
