/*
 * Whether the version running is still the latest one.
 *
 * This client is installed from a package repository, so nothing here downloads
 * or replaces anything: dnf, apt and pacman own the upgrade, and taking that
 * over would leave a second copy beside the packaged one -- exactly the mess a
 * hand-installed build makes. What is missing is only the telling. A user whose
 * machine has not refreshed its metadata has no way to know a version went out,
 * and the answer is one HTTP request to the same endpoint the website already
 * asks: the repository's latest release.
 *
 * So: read the tag, compare it with what is running, and say. Where to get it
 * is a link to the site, which spells the upgrade out per distribution.
 *
 * No dependency, because the package ships as package.json, src and data -- the
 * same reason src/dbus.js is written out by hand. Node's https is enough for one
 * GET of a few kilobytes.
 */
'use strict';

const https = require('https');

const REPO = 'abdallah-shehawey/whatsapp-desktop';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const SITE = 'https://abdallah-shehawey.github.io/whatsapp-desktop/';

/* Long enough for a slow phone tether, short enough that a menu item which
   opened a window does not sit on "Checking…" for ever. GitHub answers this
   endpoint in well under a second. */
const TIMEOUT_MS = 12000;

/* GitHub's API refuses a request with no User-Agent outright (403), so this one
   names the client and the version asking. */
const agent = current => `whatsapp-desktop/${current || '0'} (+https://github.com/${REPO})`;

/*
 * A version as three numbers and whether anything was hung off the end of them.
 * "1.6.7", "v1.6.7" and "1.6.7-1" all read the same three; the suffix is kept
 * only to break a tie, because a pre-release is older than the release it is
 * waiting for and a package revision is not newer than the version it packages.
 */
const parse = version => {
  const text = String(version == null ? '' : version).trim().replace(/^v/i, '');
  const [numbers, ...rest] = text.split('-');
  const [major, minor, patch] = numbers.split('.');
  const number = part => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  };
  return { parts: [number(major), number(minor), number(patch)], pre: rest.join('-') };
};

/* -1, 0 or 1, the way a comparator is expected to answer. */
const compare = (a, b) => {
  const left = parse(a);
  const right = parse(b);
  for (let at = 0; at < 3; at++) {
    if (left.parts[at] !== right.parts[at]) return left.parts[at] < right.parts[at] ? -1 : 1;
  }
  if (!!left.pre === !!right.pre) return 0;
  return left.pre ? -1 : 1;
};

/* Is `latest` a version worth telling somebody on `current` about? */
const isNewer = (latest, current) => compare(latest, current) > 0;

/*
 * The latest release, as the API describes it. Calls back with an Error whose
 * message is meant to be read by the person who pressed the button -- "no
 * internet" is a perfectly good answer to "is there an update", and a stack
 * trace is not.
 */
const fetchLatest = (current, cb) => {
  let answered = false;
  const done = (err, value) => {
    if (answered) return;
    answered = true;
    cb(err, value);
  };

  let request;
  try {
    request = https.get(LATEST, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': agent(current),
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: TIMEOUT_MS,
    }, response => {
      const { statusCode } = response;
      /* The body is read out even when it is being thrown away: an unread
         response holds the socket open until the timeout. */
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length < 1 << 20) body += chunk; });
      response.on('end', () => {
        if (statusCode !== 200) {
          /* 403 here is the hourly rate limit, which is 60 for a machine that
             has not signed in -- reachable only by pressing the button over and
             over, and worth saying plainly when it happens. */
          done(new Error(statusCode === 403 || statusCode === 429
            ? 'GitHub is rate-limiting this address; try again in a while'
            : `GitHub answered ${statusCode}`));
          return;
        }
        let release;
        try { release = JSON.parse(body); } catch (e) {
          done(new Error('GitHub sent something this could not read'));
          return;
        }
        const tag = release && release.tag_name;
        if (!tag) { done(new Error('the latest release has no version on it')); return; }
        done(null, {
          tag,
          version: String(tag).replace(/^v/i, ''),
          url: (release && release.html_url) || SITE,
          published: (release && release.published_at) || '',
        });
      });
    });
  } catch (e) {
    done(new Error(e.message));
    return;
  }

  /* A timeout does not abort the request by itself -- it only says the socket
     went quiet -- so the abort is here, and the error it raises is the one
     already answered above. */
  request.on('timeout', () => {
    done(new Error('GitHub did not answer in time'));
    request.destroy();
  });

  request.on('error', err => {
    done(new Error(/ENOTFOUND|EAI_AGAIN|ENETUNREACH/.test(err.code || '')
      ? 'no connection to the internet'
      : err.message));
  });
};

/*
 * The whole question, answered in one call: what is running, what is out, and
 * whether the second is worth acting on. The site is handed back with it because
 * every caller that shows this also offers the way to get it.
 */
const check = (current, cb) => {
  fetchLatest(current, (err, release) => {
    if (err) { cb(err); return; }
    cb(null, {
      current,
      latest: release.version,
      tag: release.tag,
      newer: isNewer(release.version, current),
      url: release.url,
      site: SITE,
      published: release.published,
    });
  });
};

module.exports = { check, compare, isNewer, parse, SITE, REPO, LATEST };
