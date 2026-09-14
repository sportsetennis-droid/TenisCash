# Scanner OCR assets

Self-hosted browser OCR, installed from the official npm packages on 2026-09-14:

- tesseract.js 7.0.0 (Apache-2.0): tesseract.min.js, worker.min.js.
- tesseract.js-core 6.1.2 (Apache-2.0): three LSTM-only WASM bundles, including SIMD and relaxed SIMD fallback selection.
- @tesseract.js-data/eng 1.0.0: 4.0.0_best_int/eng.traineddata.gz from https://github.com/naptha/tessdata. Tesseract language data is Apache-2.0; the npm packaging declares MIT.

Engine licenses are included alongside these files. OEM=1 selects the LSTM bundles only.
The browser fetches these assets from TenisCash, caches the language model locally,
and processes the photo on the user's device. No photo is sent to a third-party OCR
service and no API credentials are involved. The existing TenisCash photo upload
and catalogue lookup still require connectivity.

Reference: https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md
