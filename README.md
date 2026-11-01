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
Shots are kept locally for 24 hours, then pruned.

## Install

1. Open `brave://extensions` (or `chrome://extensions`) and turn on Developer mode.
2. Click "Load unpacked" and choose this folder.
3. Pin PageSnap to the toolbar. Change shortcuts at `brave://extensions/shortcuts`.

## Limits

- Full page shows the browser's "started debugging this browser" bar for a moment, because it uses the DevTools protocol. If DevTools is already attached to the tab, it falls back to scrolling capture.
- Pages that size everything to `100vh` with an inner scroller come out viewport-sized in Full page; use Scrolling capture for those.
- Images taller or wider than 32767 px, or above 268M pixels, are scaled down to fit Chromium's canvas limit.
- Browser pages (`brave://`, `chrome://`, the extension store) cannot be captured.
- Window or screen on macOS needs the browser allowed under System Settings > Privacy & Security > Screen Recording.

## Test

```sh
npm test                      # uses Brave at its default macOS path
node test/e2e.mjs /path/to/chrome
PAGESNAP_SHOTS=/tmp/shots npm test   # also saves the popup and viewer as PNGs
```

The test loads the extension into a throwaway headless profile, opens the real popup, and checks the captured pixels for every mode except Window or screen, which needs the system picker.
