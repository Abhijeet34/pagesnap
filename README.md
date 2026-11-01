# PageSnap

A screenshot extension for Chromium browsers (Brave, Chrome, Edge).
No dependencies, no build step, no network access.

| Mode | Shortcut | How it works |
| --- | --- | --- |
| Full page | `Alt+Shift+F` | One render of the whole document through the DevTools protocol, like DevTools' "Capture full size screenshot". |
| Scrolling capture | `Alt+Shift+S` | Scrolls the page (or the main inner scroll pane on app-style pages) and stitches the frames; fixed and sticky bars appear once. |
| Visible area | `Alt+Shift+V` | The current viewport. |
| Select area | `Alt+Shift+A` | Drag a rectangle over the viewport; `Esc` cancels. |
| Window or screen | none | Pick any window or screen from the system picker. |

Each capture opens in a viewer tab with Copy, JPEG and Download PNG.
Shots stay in the browser's local storage, never leave the machine, and are deleted after 24 hours or once there are more than 20.

## Security

- No network access: no host permissions, no remote code, and the default Manifest V3 content security policy.
- Web pages cannot message the extension (no `externally_connectable`, no web-accessible resources).
- A capture can only be started from the extension's own popup or a keyboard shortcut, and only on the tab you are on (`activeTab`).
  An area selection only counts if you started it, and synthetic mouse events from the page are ignored.
- Page measurements are taken in the extension's isolated script world, so a page cannot feed it false values.
- `debugger` is attached only during a Full page capture of the current tab and always detached afterwards.
- If a capture is interrupted, the page restores its own scroll position and styling within 10 seconds (60 for Full page).

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
node test/e2e.mjs /path/to/chrome
PAGESNAP_SHOTS=/tmp/shots npm test   # also saves the popup and viewer as PNGs
```

The test loads the extension into a throwaway profile, opens the real popup, and checks the captured pixels.
The headed run answers the window picker with a flag that selects the test's own window by title, so nothing else on screen is captured; on macOS it needs Screen Recording allowed for Brave.
