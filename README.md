# PageSnap

A screenshot extension for Chromium browsers (Brave, Chrome, Edge).
No dependencies, no build step, no network access.

| Option | Shortcut | What you get |
| --- | --- | --- |
| Full page | `Alt+Shift+F` | The whole page. It scrolls through once so lazy images load, then renders the document in one pass (the DevTools "Capture full size screenshot" path). App layouts that scroll an inner pane are stitched from that pane instead. |
| Visible area | `Alt+Shift+V` | What is on screen. |
| Select area | `Alt+Shift+A` | Drag a rectangle; `Esc` cancels. |
| Window or screen | none | Any window or screen, from the system picker. |

A stitched full-page capture that never shows the browser's debugging bar is available as a shortcut you can assign at `brave://extensions/shortcuts`.

The popup and the toolbar badge show progress while a capture runs.
Each capture opens in a viewer: Fit or 100% (one image pixel per screen pixel), Copy (`⌘C`), Download as PNG (`⌘S`) or JPG, both at full resolution, and Share.
Shots stay in the browser's local storage and are deleted after 24 hours or once there are more than 20.

## Sharing

Share makes a one-time link, like `https://<receiver page>/#<22 characters>`.
The image goes straight from your open viewer tab to the person who opens it, over an encrypted WebRTC connection; nothing is uploaded or stored anywhere.

- The 128-bit key sits after `#`, which browsers never send to a server. The receiver page removes it from the address bar as it loads; the browser's history still records the visit, which is harmless once the link has been used, stopped or expired.
- Public WebTorrent trackers introduce the two browsers. What passes through them is encrypted and authenticated with the key, so a tracker can neither read it nor put itself in the middle.
- The image is encrypted with the key as well, on top of WebRTC's DTLS.
- Both screens show a 4-digit code, mixed from both connection fingerprints and a nonce from each side, with the recipient's committed before the sender's is revealed. Someone else holding the link who sits between you therefore matches both codes only by a 1-in-10,000 guess per try, and each try shows you a request.
- Nothing is sent until you check the code with the recipient and press Send. A forwarded link gets you a request you can decline; several recipients queue and are shown one at a time.
- The link is the credential: someone else holding it could also pose as the sender. The recipient's page keeps the code on screen with the image, so they can check you saw it.
- The link works once, for at most 10 minutes, and only while the share dialog is open.

What it cannot hide: the trackers and STUN servers see both IP addresses, the time, and roughly how big the transfer is. A small share of networks block direct connections; without a relay server those transfers fail, and the receiver page says so.

The receiver page is `share/` in this repository, a static page with no third-party code, a strict content security policy and no referrer.
It is published at `https://abhijeet34.github.io/pagesnap-share/` from the `Abhijeet34/pagesnap-share` repository; after changing and committing `share/`, run `npm run publish:share`, which pushes it there and waits until the live page serves the same bytes.
Whoever controls that repository controls the page recipients run, so the account needs two-factor authentication.

## Install

1. Open `brave://extensions` (or `chrome://extensions`) and turn on Developer mode.
2. Click "Load unpacked" and choose this folder.
3. Pin PageSnap to the toolbar. Change shortcuts at `brave://extensions/shortcuts`.

## Limits

- Full page shows the browser's "started debugging this browser" bar for a moment, because it uses the DevTools protocol. If DevTools is already attached to the tab, it falls back to scrolling capture.
- Pages whose real content scrolls inside an inner pane make Full page fall back to Scrolling capture of that pane.
- Scrolling capture hides fixed elements after the first frame and returns sticky ones to their place in the page, so headers appear once. This includes elements inside open shadow roots.
- Switching tabs during a capture stops it with an error rather than mixing two tabs into one image.
- Pages taller than 32767 px, or above 268M pixels, are scaled down to fit Chromium's canvas limit. A page that keeps growing while it is captured (infinite feeds) is cut off at that limit, and the viewer says so.
- Content that lives entirely inside an `<iframe>` is captured only as far as the visible part of the frame.
- Browser pages (`brave://`, `chrome://`, the extension store) cannot be captured.
- Window or screen on macOS needs the browser allowed under System Settings > Privacy & Security > Screen Recording.

## Test

```sh
npm test                      # headless Brave, at 2x and 1.5x pixel ratios
npm run test:headed           # a visible window; also covers Window or screen
PAGESNAP_LIVE=1 node test/e2e.mjs   # Share through the real public trackers
npm run test:published        # Share to the published receiver with shipped settings
node test/e2e.mjs /path/to/chrome
PAGESNAP_SHOTS=/tmp/shots npm test   # also saves the popup and viewer as PNGs
```

The test loads the extension into a throwaway profile, opens the real popup, and checks the captured pixels, progress, downloads, and a full share between two tabs through a local tracker.
The headed run answers the window picker with a flag that selects the test's own window by title, so nothing else on screen is captured; on macOS it needs Screen Recording allowed for Brave.

## Credits

Interface icons are from [Lucide](https://lucide.dev) 0.460.0, ISC licence (`icons/LUCIDE-LICENSE`).

## License

MIT (`LICENSE`).
