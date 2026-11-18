# Security policy

## Supported versions

Security fixes go into the latest release only.

## Reporting a vulnerability

Please don't report it in a public issue. Report it privately on GitHub: open
the repository's **Security** tab and choose **Report a vulnerability**. If you
don't see that option, open an issue asking for a private contact, and leave out
any details.

Include:

- the version (from *About*), your distribution, and how you installed the client
- steps to reproduce the problem, and what an attacker could do with it

Never attach session files, tokens, phone numbers or message content.

## Scope

The client loads WhatsApp Web and keeps a persistent browser session in
`~/.local/share/whatsapp-desktop`. Treat that folder, debug output and logs as
sensitive.

Problems in WhatsApp's own service belong to the
[Meta Bug Bounty](https://bugbounty.meta.com/) program, not to this project.
