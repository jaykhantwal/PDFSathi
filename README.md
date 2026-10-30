# PDFSathi — free PDF editor that runs 100% in the browser

Merge, split, rotate, reorder, add text (Hindi works), draw/type/upload signatures, create custom stamps.
No server, no sign-up, no watermark: files never leave the user's device.

## Put it on GitHub Pages
1. Create a new repository on GitHub and upload **everything in this folder** (keep the folder structure).
2. Repo → **Settings → Pages** → *Build and deployment* → Source: **Deploy from a branch** → Branch: `main` / `(root)` → Save.
3. After a minute your site is live at `https://<username>.github.io/<repo>/`.

## Run locally
Browsers block PDF workers on `file://`, so use a tiny local server:

    python3 -m http.server 8000     # then open http://localhost:8000

## Customise
- Name / logo: edit `index.html` (`.brand-name`, `<title>`).
- Colours: CSS variables at the top of `css/style.css`.
- Stamp presets: `js/stamp.js` → `PS.STAMP_PRESETS`.
- Signature fonts: `SIG_FONTS` in `js/app.js` (fonts live in `assets/fonts/`).

## Notes
- Added text, signatures and stamps are placed on the page as high-resolution images, so any font or language works.
  The original page text stays as-is: use the **Cover** tool to hide old text and add new Text on top.
- Password-protected PDFs are not supported yet.

## Credits (all bundled, no CDN)
pdf.js (Apache-2.0), pdf-lib (MIT), JSZip (MIT), SortableJS (MIT), fonts via Fontsource (SIL OFL).
