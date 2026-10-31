# Security

Ride Atlas is a static web page that reads a Strava export inside the browser tab. There is no server side,
so most of its security comes down to what the page does with your files and what it lets out of the tab.

## What it protects, and how

| Risk | What the app does |
| --- | --- |
| Your activity data leaving the device | Files are read locally, in a Web Worker. No upload code exists, and the Content-Security-Policy sets `connect-src 'none'`, which blocks `fetch`, XHR, WebSockets and beacons even if the code were changed or buggy. The browser check (`npm run screenshots`) fails on any request except map tiles. |
| Map tiles revealing where you ride | Tiles come from OpenStreetMap or OpenTopoMap, as images only. Those servers see your IP address and which map squares you view. The page sends only its origin as the referrer (`strict-origin-when-cross-origin`), never the full URL. Map background **Off** stops every request. |
| Your home on a shared poster | Route posters cut the first and last 200 m of every route by default (**Hide route ends**: off, 200 m, 500 m or 1 km). Other posters contain no coordinates. CSV/JSON exports contain no GPS tracks. |
| Unrelated personal data in the export | Only `activities.csv` (or a renamed `activities….csv`) and GPX/TCX/FIT files are used; everything else is skipped by name and never opened. A ZIP is read through its central directory with byte-range reads, so photos, videos, messages, profile and contacts are neither loaded into memory nor unpacked. A test checks that no byte of a photo entry is read. |
| Data in the address bar or history | The address only ever shows `#stats`, `#posters` or `#activity`; activity names, ids and places stay out of URLs, the browser's history list and the tab title. |
| Data lingering on the device | Activities live in memory only and are gone when the tab closes. Local storage holds two settings, theme and map background, plus your thresholds and goal (a few numbers, never activity data) only when you tick “Remember on this device”; unticking deletes them. |
| A hostile or malformed file (from anyone) | File contents are treated as data only. Text from files is inserted with `textContent` / escaped in SVG, never as HTML, so an activity name cannot inject markup. Formats are detected by content, not by extension. Each unpacked file is capped at 256 MB (ZIP entries by their declared size, `.gz` files by the gzip size field, which the decompressor never exceeds), so a small archive cannot expand into gigabytes. A file that fails to parse is listed in the import report and skipped. |
| Spreadsheet formula injection in exports | Text cells (names, sports) that start with `=`, `+`, `-`, `@`, a tab or a carriage return are prefixed with an apostrophe, so a spreadsheet shows them instead of running them. |
| Script injection into the page | CSP: `default-src 'none'`, scripts, styles and workers from the app's own origin only, no inline script, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`. There is no `innerHTML`, `eval` or `new Function` in the app code, and the built bundle contains no `fetch`, XHR, WebSocket or beacon call. Posters are shown as `<img>` elements, where SVG can neither run script nor load anything, so even a mistake in escaping could not reach the page. |
| Other sites framing or opening the app | `frame-ancestors 'none'` and `X-Frame-Options: DENY` stop clickjacking; `Cross-Origin-Opener-Policy: same-origin` cuts the link to any page that opened the app; `Cross-Origin-Resource-Policy: same-origin` stops other sites loading its files. |
| External links | The only one (GPX to FIT) opens in a new tab with `rel="noopener noreferrer"`. |
| Supply chain | Two runtime dependencies (`fflate` for ZIP/gzip, `fit-file-parser` for FIT files), bundled at build time with versions pinned in `package-lock.json`. Nothing is loaded from a CDN. |

## Hosting it yourself

The CSP is added to the built `index.html` as a meta tag, so it applies on any host. Some protections can
only be set as HTTP headers. The build writes them to `dist/_headers`, which Cloudflare Pages (where the app
is published) and Netlify apply automatically. On another host, set them yourself:

```
Content-Security-Policy: <the policy from vite.config.ts>; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
X-Frame-Options: DENY
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

Do not add analytics or other script injection on the host (for example Cloudflare Web Analytics or Rocket
Loader): the policy blocks it, and it would be the first outside code on the page.

Keep `Referrer-Policy` at `strict-origin-when-cross-origin` (or `origin`): OpenStreetMap refuses tile
requests that carry no referrer. `no-referrer` makes the OpenStreetMap background fail, and the app then
offers OpenTopoMap instead.

Serve the app over HTTPS. Opened from a `file://` URL it still works, but OpenStreetMap tiles do not
(no referrer), so it falls back to OpenTopoMap.

## What it cannot protect against

No web page can defend against a compromised device or browser, a malicious browser extension with access
to all sites, or someone who can change the code on the host (keep the repository and the Cloudflare account
secured, with two-factor authentication). And once you share a poster or an export, what it shows is out of
the app's hands, which is why route ends are hidden by default.

## Reporting a problem

Please report security issues privately through GitHub's **Security → Report a vulnerability** on this
repository rather than in a public issue. Include what you did, what happened and, if you can, a small
file that shows it. Do not attach your real export: a few lines of GPX or CSV are enough.
