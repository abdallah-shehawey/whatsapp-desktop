/* whatsapp-desktop landing page.
 *
 * Everything version-shaped on this page is a placeholder until this script
 * replaces it with the newest GitHub release: the tag in the header, the
 * filenames in the install commands, and the four download cards. Without
 * JavaScript the cards still point at /releases/latest, which serves the same
 * set of files -- one click further along.
 */
(function () {
  "use strict";

  var REPO = "abdallah-shehawey/whatsapp-desktop";
  var API = "https://api.github.com/repos/" + REPO + "/releases/latest";
  var RELEASES = "https://github.com/" + REPO + "/releases";
  var CACHE_KEY = "wad:latest";
  var CACHE_MS = 30 * 60 * 1000;

  /* --------------------------------------------------------- utilities -- */

  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function humanSize(bytes) {
    if (!bytes) return "";
    var mb = bytes / 1048576;
    return mb >= 1 ? mb.toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
  }

  function humanDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  }

  /* ------------------------------------------------- the latest release -- */

  function cached() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var box = JSON.parse(raw);
      return Date.now() - box.at < CACHE_MS ? box.data : null;
    } catch (e) { return null; }
  }

  function remember(data) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data: data }));
    } catch (e) { /* private mode, or a full quota -- the page works without it */ }
  }

  function apply(release) {
    var tag = release.tag_name || "";
    var version = tag.replace(/^v/, "");
    var assets = release.assets || [];

    $$("[data-tag]").forEach(function (el) { el.textContent = tag; });
    $$("[data-version]").forEach(function (el) { el.textContent = version; });
    $$("[data-release-link]").forEach(function (el) { el.href = RELEASES + "/tag/" + tag; });

    var when = humanDate(release.published_at);
    $$("[data-release-date]").forEach(function (el) {
      el.textContent = when ? ", published " + when : "";
    });
    $$("[data-release-meta]").forEach(function (el) {
      el.textContent = [tag, when && "released " + when, "x86_64",
                        "rpm, deb and a native Arch package"]
        .filter(Boolean).join(" · ");
    });

    /* One card per format. `data-match` is a filename suffix and `data-skip` a
       substring to reject, which is how the Arch card takes the client and not
       the debug package that shares its suffix. */
    $$("[data-assets] .dl").forEach(function (card) {
      var suffix = card.getAttribute("data-match");
      var skip = card.getAttribute("data-skip");
      var hit = null;

      for (var i = 0; i < assets.length; i++) {
        var name = assets[i].name;
        if (name.slice(-suffix.length) !== suffix) continue;
        if (skip && name.indexOf(skip) !== -1) continue;
        hit = assets[i];
        break;
      }
      if (!hit) return;

      card.href = hit.browser_download_url;
      var nameEl = card.querySelector("[data-name]");
      var sizeEl = card.querySelector("[data-size]");
      var sumEl = card.querySelector("[data-digest]");
      if (nameEl) nameEl.textContent = hit.name;
      if (sizeEl) sizeEl.textContent = humanSize(hit.size);
      if (sumEl && hit.digest) {
        sumEl.textContent = "sha256 " + hit.digest.replace(/^sha256:/, "").slice(0, 20) + "…";
        sumEl.title = hit.digest;
      }
    });

    var sums = assets.filter(function (a) { return a.name === "SHA256SUMS"; })[0];
    if (sums) {
      $$("[data-sums-link]").forEach(function (el) { el.href = sums.browser_download_url; });
      $$("[data-sums-url]").forEach(function (el) { el.textContent = sums.browser_download_url; });
    }
  }

  function loadRelease() {
    var hot = cached();
    if (hot) { apply(hot); return; }

    fetch(API, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) { remember(data); apply(data); })
      .catch(function () {
        /* Rate-limited, offline, or blocked. The static markup already points
           at /releases/latest, so leave it exactly as it is. */
        $$("[data-tag]").forEach(function (el) {
          if (el.textContent === "latest") el.textContent = "releases";
        });
      });
  }

  /* ------------------------------------------------------------- tabs --- */

  function initTabs() {
    $$('[role="tablist"]').forEach(function (list) {
      var tabs = $$('[role="tab"]', list);

      function select(tab) {
        tabs.forEach(function (t) {
          var on = t === tab;
          t.setAttribute("aria-selected", on ? "true" : "false");
          t.tabIndex = on ? 0 : -1;
          var panel = document.getElementById(t.getAttribute("aria-controls"));
          if (panel) panel.hidden = !on;
        });
      }

      tabs.forEach(function (tab, i) {
        tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
        tab.addEventListener("click", function () { select(tab); });
        tab.addEventListener("keydown", function (e) {
          var step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          var next = tabs[(i + step + tabs.length) % tabs.length];
          select(next);
          next.focus();
        });
      });
    });
  }

  /* ------------------------------------------------------ copy buttons -- */

  var COPY_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="9" y="9" width="12" height="12" rx="2"/>' +
    '<path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  var OK_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>';

  function initCopy() {
    /* The hero terminal is a picture of a session, prompts and output and all;
       copying it would hand over junk. Skip it. */
    $$("pre:not(.term-body)").forEach(function (pre) {
      var wrap = document.createElement("div");
      wrap.className = "codewrap";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy";
      btn.innerHTML = COPY_ICON + "<span>Copy</span>";
      btn.setAttribute("aria-label", "Copy to clipboard");
      wrap.appendChild(btn);

      btn.addEventListener("click", function () {
        var text = (pre.textContent || "").replace(/\s+$/, "");
        var done = function (ok) {
          btn.className = "copy " + (ok ? "ok" : "err");
          btn.innerHTML = (ok ? OK_ICON : COPY_ICON) +
            "<span>" + (ok ? "Copied" : "Press Ctrl+C") + "</span>";
          setTimeout(function () {
            btn.className = "copy";
            btn.innerHTML = COPY_ICON + "<span>Copy</span>";
          }, 1600);
        };

        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(function () { done(true); },
                                                   function () { done(false); });
        } else {
          /* http:// and file:// have no clipboard API -- select the block so
             Ctrl+C still works. */
          var range = document.createRange();
          range.selectNodeContents(pre);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          done(false);
        }
      });
    });
  }

  /* -------------------------------------------------------- nav marker -- */

  function initNavMarker() {
    var links = $$(".topnav a");
    if (!links.length || !("IntersectionObserver" in window)) return;

    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });

    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var link = byId[entry.target.id];
        if (!link) return;
        link.style.color = entry.isIntersecting ? "var(--accent)" : "";
      });
    }, { rootMargin: "-45% 0px -50% 0px" });

    Object.keys(byId).forEach(function (id) {
      var section = document.getElementById(id);
      if (section) seen.observe(section);
    });
  }

  /* --------------------------------------------------------------- go --- */

  $$("[data-year]").forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });
  initTabs();
  initCopy();
  initNavMarker();
  loadRelease();
})();
