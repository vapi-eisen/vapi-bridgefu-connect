# Vendored Bridgefu browser SDK

- Package: `@bridgefu/webrtc-browser` 0.1.0 (MIT)
- Source repository: https://github.com/eisenzopf/bridgefu, directory `sdk/typescript`
- Source commit: `e00db3289480f93c2783c57440a324e4438e29de` (the exact Bridgefu commit
  compiled into the release 0.1.34 AMI, per `bridgefu.lock.json` in bridgefu-vapi-awsconnect)
- Source `Cargo.lock` SHA-256 at that commit: `8bd0c889cc121076cd6d31bfa9058c763744f0c96022f5bb88b8f1d707a16ba9`
- Source `sdk/typescript/package.json` SHA-256: `d69ffe3820836da906433e50b13db81fc7ee108878ebae8d34cb0f45bc3bf475`
- Source `sdk/typescript/package-lock.json` SHA-256: `7eb7bf824706cf1acf4b5612a60ff0cbe14812577ec2a9fbbc2ebb45d3fb2530`
- Build: `git archive <commit> sdk/typescript`, then `npm ci --ignore-scripts` and
  `npm run build` (TypeScript 7.0.2) on 2026-09-10 with Node v26.3.0
- Ordered `dist/**` digest (SHA-256 of `shasum -a 256` over all files sorted by
  relative path): `dbc5c1769bb3344bfe47e2dc87ce04c6dc521a7cd6084d9954190e167f802d04`

The vendored `package.json` drops the build scripts, development dependencies, and
publish configuration; runtime metadata and `dist/**` are unchanged. The lab page
imports `dist/index.js` directly as browser ES modules, so no bundler is needed.
Do not edit `dist/**` in place: rebuild from the pinned commit and update the
digests above.
