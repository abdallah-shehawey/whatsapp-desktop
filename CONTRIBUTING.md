# Contributing

Thank you for helping improve WhatsApp Desktop.

## Development setup

The project targets Linux and requires Node.js 22 or newer, npm, and the system libraries required by Electron. Install dependencies and run the focused test suite from the repository root:

```sh
npm ci
make test
npm start
```

The application loads WhatsApp Web in Electron. Testing notification behavior with a real account is optional; `make test` uses a local replay harness and does not access an account.

## Changes

Keep changes focused and explain the user-visible effect in the commit message. If you change the packaging layout, keyboard shortcuts, notification behavior, or configuration keys, update `README.md` as part of the same change.

Before opening a pull request, run:

```sh
make test
for file in dist/*.js dist/page/*.js tools/test-inject.js; do node --check "$file"; done
```

Pull requests should describe the problem, the approach, how the change was tested, and any Linux distribution-specific considerations. Do not include account data, session files, screenshots containing private conversations, or generated dependency directories.

## License

By contributing, you agree that your contribution is provided under the project’s GPL-3.0-only license.
