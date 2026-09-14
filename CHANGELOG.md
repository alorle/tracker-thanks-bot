# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [1.2.0](https://github.com/alorle/tracker-thanks-bot/compare/v1.1.0...v1.2.0) (2026-09-14)

### Features

- **scanner:** pace a scan so a Site is not taken in one burst ([f5ee45b](https://github.com/alorle/tracker-thanks-bot/commit/f5ee45b9abb6aab798958269ec009c71fdc40dd5))

### Bug Fixes

- **config:** reject an unusable SCAN_HOUR instead of looping the scan ([0af17d4](https://github.com/alorle/tracker-thanks-bot/commit/0af17d4844f801a0dd434aceb3526d42031e9c38))
- **qbittorrent:** bound the retry after a rejected session ([3e4c836](https://github.com/alorle/tracker-thanks-bot/commit/3e4c836e50b56f6263975745c59734f7d766a597))
- **serve:** validate the scan config before opening the port ([767b895](https://github.com/alorle/tracker-thanks-bot/commit/767b895740a004f90aaf20fda0fe93e0aa2fc6dd))
- **thanks:** take the first matching button instead of failing on several ([f110836](https://github.com/alorle/tracker-thanks-bot/commit/f110836ee4a6e1a778ae2e8035f15a9e98664273))
- **webhook:** cap the request body instead of buffering it whole ([a3c1930](https://github.com/alorle/tracker-thanks-bot/commit/a3c1930f75fa25711dc4fec6066beffa50e77999))

### Dependencies

- update dependencies within their supported ranges ([e9b5a2f](https://github.com/alorle/tracker-thanks-bot/commit/e9b5a2f59d21a00d679f0ce92c23c6914ada7be4))

### Build System

- move the runtime to Node 26.8.1 ([caa5aa9](https://github.com/alorle/tracker-thanks-bot/commit/caa5aa9bddc09006adee9506681ae95efab6c2ca))

## [1.1.0](https://github.com/alorle/tracker-thanks-bot/compare/v1.0.1...v1.1.0) (2026-08-22)

### Features

- **thanks:** thank over HTTP without driving a browser ([650b586](https://github.com/alorle/tracker-thanks-bot/commit/650b586b8857fa9296e3d6e33e253ce7f4e1e353))

### Bug Fixes

- **browser:** a crashed page poisoned every torrent after it ([02c1803](https://github.com/alorle/tracker-thanks-bot/commit/02c180306132055fdb5565c89d51c8526467782d))

## [1.0.1](https://github.com/alorle/tracker-thanks-bot/compare/v1.0.0...v1.0.1) (2026-07-27)

### Dependencies

- update dependencies to latest ([ee71138](https://github.com/alorle/tracker-thanks-bot/commit/ee71138fbd599ea8092e60819ba64ff5651c1850))

### Documentation

- sync README with the Node 24.18.0 requirement ([4a35e14](https://github.com/alorle/tracker-thanks-bot/commit/4a35e144344565c7e6c75b7cf8e8fb9e00e3ac06))

### Build System

- bump Node runtime to 24.18.0 ([5cd198f](https://github.com/alorle/tracker-thanks-bot/commit/5cd198f742a2c09986025f550abfcbbb2a25d216))
- migrate base image to Debian 13 (trixie) ([28f2736](https://github.com/alorle/tracker-thanks-bot/commit/28f2736ac0a438f6b9b2b8fe2713a36ef004b5e8))
- show Build System section in the changelog ([0842e23](https://github.com/alorle/tracker-thanks-bot/commit/0842e23f00b4af65b2adb1b0d3a5bd237c07e25a))

## 1.0.0 (2026-05-26)
