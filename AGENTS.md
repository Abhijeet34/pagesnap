# pagesnap

PageSnap is a Manifest V3 extension for Chromium browsers: `manifest.json` declares it, `src/` holds all of its code as plain JavaScript, HTML and CSS, and nothing is compiled or bundled.
`share/` is the receiver page a share link opens; `.github/workflows/pages.yml` publishes only that folder to GitHub Pages, and `RECEIVER_URL` in `src/config.js` points at it.
The README owns what each capture mode does, the share link's guarantees ("Sharing") and the known limits ("Limits"); read those before changing capture or sharing.

## Build

There is no build step: load the folder unpacked as the README's "Install" says.
The toolbar icons are the one generated asset: after editing `icons/icon.svg` or `icons/icon-small.svg`, run `node scripts/icons.mjs` to render the PNG sizes `manifest.json` lists, through headless Brave.

## Test

```sh
npm test
```

It runs `test/e2e.mjs` twice in a throwaway headless Brave profile, at pixel ratios 2 and 1.5, and took 2 minutes 48 seconds on 2026-11-02.
It needs Brave at its default macOS path, or another Chromium passed as `node test/e2e.mjs /path/to/browser` or in `BROWSER`.
A sandbox that stops the browser from starting fails it with `timed out waiting for browser start`, which is not a test failure.
The headed, live-tracker and published-receiver runs are listed under the README's "Test".

## Rules a change is held to

- No dependencies and no build step: `package.json` carries scripts only, and the README promises both.
- `share/` stays a static page with no third-party code, a strict content security policy and no referrer, because recipients run whatever that page serves.
- Workflow actions stay pinned to full commits, as `pages.yml` does, so a moved tag cannot change what is published.
- `LICENSE` is MIT with the holder line `Copyright (c) 2026 Abhijeet`; never edit it.
- The Lucide icons keep their ISC licence in `icons/LUCIDE-LICENSE`.
