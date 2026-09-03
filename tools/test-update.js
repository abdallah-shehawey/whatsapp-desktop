/*
 * Which of two versions is the newer one.
 *
 * The whole of the update check that can be tested without the internet, and
 * the half that has anything to get wrong: a tag comes off a GitHub release as
 * text, in whatever shape a release was tagged in, and the answer decides
 * whether a user is told there is something to install. Being wrong in one
 * direction nags somebody who is already up to date; in the other it keeps
 * quiet about a release that is out.
 */
'use strict';

const { compare, isNewer, parse } = require('../src/update.js');

let failures = 0;
const check = (label, got, want) => {
  if (got === want) { console.log('  ok   ' + label); return; }
  failures++;
  console.log('  FAIL ' + label +
              '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

/* --------------------------------------------------------------- the tags */

check('a tag is read with its v', parse('v1.6.6').parts.join('.'), '1.6.6');
check('and without one', parse('1.6.6').parts.join('.'), '1.6.6');
check('a missing part counts as nothing', parse('1.7').parts.join('.'), '1.7.0');
check('and so does a tag that is not one at all', parse('').parts.join('.'), '0.0.0');

/* ------------------------------------------------------------ the answers */

check('the release after this one is newer', isNewer('v1.6.7', '1.6.6'), true);
check('the one running is not', isNewer('v1.6.6', '1.6.6'), false);
/* The case that matters most: a client ahead of the latest release -- a build
   from the checkout -- must never be told to go back. */
check('and a version ahead of it is not either', isNewer('v1.6.6', '1.7.0'), false);

/* The middle number moves rarely, and when it does it is a whole number bigger
   than the patch it left behind. String order would read 1.10.0 as older. */
check('ten is after nine, not before it', isNewer('v1.10.0', '1.9.9'), true);
check('and a major release is after every one of them', isNewer('v2.0.0', '1.99.99'), true);

/* A release candidate is not the release. Nobody is told to install one. */
check('a pre-release is older than the version it waits for',
      compare('1.6.7-rc1', '1.6.7'), -1);
check('and it is still newer than the one before it',
      isNewer('1.6.7-rc1', '1.6.6'), true);

/* Packages carry a revision this client never sees, but a tag written that way
   would be read here, and it is not a newer version of anything. */
check('a package revision is not a newer version', isNewer('1.6.6-1', '1.6.6'), false);

console.log(failures ? `\n${failures} failed` : '\nupdate checks pass');
process.exit(failures ? 1 : 0);
