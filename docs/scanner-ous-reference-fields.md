# Literal OUS reference fields

This change addresses the OUS labels reviewed in November 2026. It does not
apply inventory, infer a brand from a numeric prefix, lower OCR confidence,
or combine fields from different recognition passes.

The archived-label parser can preserve the complete printed `350xxx` model
plus its one-to-three-digit colour when the field has a literal `Ref.`/`Ref.:`
prefix or a dash separator. Every accepted member retains the existing
confidence floor of 75. Adjacency, height, scale ownership, intervening words
and continuation fragments are checked before the field is accepted. A
malformed field blocks the generic reference fallback as well as the
complete-field marker. Bare numeric fragments do not gain the marker.

The `350xxx` grammar bounds this parser extension to the documented OUS
family; it is not evidence of product, brand or size. The existing exact
barcode, canonical product, complete model/colour, literal BR and incoming
invoice checks still decide whether a reading can be applied.

Complete OUS identities participate in same-pass and cross-pass conflict
checks. A conflicting complete token cannot hide behind spaces or a slash.
Only colour padding is equivalent (`5`, `05`, `005`); all six model digits
remain intact. Eight-digit manufacturing tokens do not become universal
identities. The processor continues to use accumulated evidence only to
reject contradictions, not to fuse a reference and BR from separate passes.

An explicitly parsed complete nine-digit OUS field no longer requests an
alphabetic colour suffix. Bare nine-digit references and all existing
non-OUS recovery paths retain that heuristic.

The parser also excludes numeric foreign-scale tokens such as `8/25.5CM`
when OCR separates the preceding `US` into another word. These scale fields
cannot finish recognition as an apparent manufacturer reference.

The OUS fiscal matcher now handles the documented `TENIS COURO`, `TENIS
TEXTIL` and `TENIS SINT` descriptions. It compares the complete six-digit
model and numeric colour suffix, preserves the original reference string,
and rejects mismatched BR, another model/colour, conflicting invoice
identities and model-only references. Other manufacturer branches are
unchanged.

## Validation

- `npm run test:scanner` includes `test-scanner-ous-label.cjs`: synthetic
  grammar/negative checks and unmodified words from three real OCR caches.
- `test-scanner-ous-fiscal-reference.cjs` has 116 cases and is included in
  `npm run test:stock-replacement`. The fiscal fixtures are explicitly unit
  inputs; they are not represented as photo OCR.
- The real-cache fixture preserves 1,715 words from ten passes, original
  confidence, bounding boxes and text, plus the photo and cache hashes.
  It contains Coral Pink BR37, HEVEA BR41 and IMIGRANTE BR38.
- All three real cached photos remain pending: they do not contain the
  required strong, complete, contextual reference and BR in one pass.
  In particular, the strong model/colour in one IMIGRANTE pass is not joined
  to a strong BR from another pass.
- Two full-image local replays after the change used the unchanged originals,
  unique decoded EANs and the 24-second/384-MiB limits. HEVEA ended with
  timeout at 24.009 seconds (observed peak RSS 181.4 MiB); IMIGRANTE ended
  with timeout at 24.021 seconds (226.2 MiB). The latter no longer returns
  the false reference `8255CM` and continues trying until the deadline.
  These Windows measurements are not Linux production performance evidence.

This work does not establish an automatic OUS label-region detector. The
barcode decoder still loses positional ownership, so accepting weaker
references based on a matching invoice or combining passes requires a
separate, validated association with the same physical label.
