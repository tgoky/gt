# bg-remover — batch background remover CLI

A Node.js command-line tool that removes image backgrounds and writes **transparent PNGs** to an output folder.
Built for product-photo batches (e.g. groups of near-identical shots that differ only in label text) and sized for your Next.js repo — but it runs fully standalone.

Two engines under the hood:

| Engine | How | Best for | Speed |
| --- | --- | --- | --- |
| `ai` (default) | IS-Net salient-object segmentation running locally on ONNX runtime — no API, no upload, works offline | Real photos, blurred/complex backgrounds, glass & transparent packaging | ~6–12 s first image, then ~1–2 s/image (model loads once per run) |
| `chroma` | Color-distance flood fill from the borders (auto-detects the backdrop color) | Solid studio backdrops, opaque products | ~0.2–0.5 s/image |

`--engine auto` (default) tries AI first and silently falls back to chroma-key if AI fails for a file.

A second bottom-recovery pass runs by default: salient-object models work on a 320×320 internal grid, so translucent parts that fill a tiny fraction of a tall photo (the glass base of a vial, clear lids) can be classified as background and cut off in a hard horizontal line. The tool detects that and runs one extra inference on the bottom ~35% crop — where the region fills far more of the model's grid — and unions the masks so the silhouette extends to the true product bottom (on the reference vial photo: bottom recovered from 73.4% to 77.3% of image height). Disable with `--no-bottom-boost` for non-product shots.

### All-sides background guarantee

After segmentation, an **all-sides sweep** runs on every image (AI, reused-mask and chroma alike). It estimates the backdrop from the photo's border frame (multi-color model, handles textured/gradient backdrops), then flood-cleans from **all four borders — top, left, bottom, right** — every pixel that both looks like the backdrop *and* is reachable from the outside:

- gray fuzz / haze hugging the silhouette (e.g. around a barcode on the bottle's right edge) → removed on every side;
- background pockets caught between product parts → removed;
- translucent product (a glass base showing the table through itself) → **kept** — the sweep is structure-aware: small/soft patches are debris, one huge solid body is product;
- edge colors are decontaminated (defringed) so semi-transparent pixels show product color, not old backdrop.

Every finished image is then **audited per side** and the result is printed in the run log:

```
✔ srm.jpeg  auto · 13.2s · 3.3 MB · swept 28263px · defringed 12092px  edges T✓ L✓ B✓ R✓ · haze 0px
```

`T✓ L✓ B✓ R✓` = no background-like material touches that side of the canvas; `haze 0px` = no backdrop-colored fringe left anywhere along the silhouette. If a busy backdrop ever triggers a false sweep, lower `--sweep-tol` (default 46) or skip the pass with `--no-sweep`. You can re-audit any cutout later: `node qa.mjs output/srm.png --photo shots/srm.jpeg`.

### Works on any product, any size, any color — nothing is tuned to one bottle

Every cleanup parameter is **derived per image**, never hardcoded:

- The backdrop model is learned from *each photo's* border frame (up to 12 colors) — a stone countertop, a gradient wall and a colored sweep all just work, and the product's own colors are irrelevant to the sweep (they act as walls to the flood).
- The debris-size threshold is a fraction of the **detected product's own solid area** (5%, clamped to 0.4–2% of the canvas) — so it self-adapts from a 400 px thumbnail to a 4K export and from a vial to a full-frame shot. A fixed pixel threshold would eat a small photo's glass base and miss a large photo's debris; this one can't do either.
- Erosion/feather/audit radii scale with image resolution (e.g. the edge band is 5 px at 1536 px wide, proportionally less on smaller images).
- The bottom-recovery pass triggers on mask geometry (fractions of image height), not on any assumed product shape.

This is enforced by an invariance test suite (`gen_invariance.py` + `node invariance_harness.mjs`): the same photo with identical debris is regenerated at **0.25×, 0.5×, 1× and 2× resolution** and in **three color transforms** (hue +120°, +240°, grayscale), and every variant must come out with all four sides at 0 residue, ≤6 ppm haze and <1.5% product-core loss. Current status: **all variants pass** (product preserved 100.00% at every scale; swept-residue share of canvas constant at ~3% across scales).

---

## Quick start

```bash
cd bg-remover
npm install          # one time; downloads native binaries + the local AI model assets
```

Then run the tool **on the folder where your raw photos are** — that can be anywhere on your machine (Desktop, Downloads, your repo's `public/` folder…). `/path/to/photos/` in the examples below is just a placeholder: **replace it with your real folder**.

Simplest setup — make a `shots/` folder next to the tool and drop your raw images in it:

```text
bg-remover/
├─ remove-bg.mjs
├─ shots/            ← put your RAW photos here (rough.png, vial-blue.png, …)
└─ output/           ← cutouts appear here automatically (rough.png, … transparent)
```

```bash
node remove-bg.mjs shots/             # or an absolute path: node remove-bg.mjs C:\Users\you\Desktop\shots\
```

That's it — everything (the 88 MB model, WASM codecs) ships inside the npm package and loads from local disk. **No internet is needed at run time.**

## The workflow for groups of similar pictures: `--reuse-mask`

You said your batches are groups of near-identical shots where only the text/wording differs. The segmentation silhouette of such shots is identical — so this flag runs the AI **once on the first image and reuses its alpha mask for the rest**:

```bash
node remove-bg.mjs shots/ --reuse-mask
```

Measured on a 4-image group (1536×2752): **~13 s total** — ~12 s for the AI reference pass (including the bottom-recovery pass), then ~350 ms per reused mask. For your typical 7–8 image group: roughly **one AI run + ~0.3 s each**.

Notes:
- Order matters: the first (alphabetical) image is the reference. If one shot is odd, put it in its own run.
- Use it when shots share framing/position. Slightly different text inside the label is safe — the mask only shapes the silhouette.
- With `--reuse-mask` the batch is processed sequentially, and if a shot has different dimensions the mask is resized to fit automatically.

## Commands

```bash
# Single file
node remove-bg.mjs product.jpeg

# A folder (all jpg/png/webp/tiff/avif/gif inside)
node remove-bg.mjs shots/ -o cutouts/

# Several paths + glob
node remove-bg.mjs a.png b.jpeg "shots/*.jpg"

# Fast path for solid studio backdrops (fully offline chroma-key)
node remove-bg.mjs studio/ -e chroma -k "#ffffff" -t 20

# Maximum AI quality is the default `medium` model; use `small` for speed
node remove-bg.mjs shots/ -m small

# Preview what would be processed
node remove-bg.mjs shots/ --dry-run
```

## All options

| Option | Default | Description |
| --- | --- | --- |
| `-o, --out <dir>` | `output` | Output folder (created if missing) |
| `-e, --engine <name>` | `auto` | `ai` \| `chroma` \| `auto` |
| `-m, --model <name>` | `medium` | AI model: `small` \| `medium` (the bundled IS-Net variants) |
| `--no-bottom-boost` | off (boost on) | Skip the second bottom-crop AI pass that recovers cut-off translucent bottoms |
| `--reuse-mask` | off | AI on the first image only; reuse its mask for the rest |
| `--no-sweep` | off (sweep on) | Skip the all-sides background sweep + per-side audit |
| `--sweep-tol <10-80>` | `46` | Backdrop-match strictness for the sweep — raise for busy/textured backdrops |
| `-k, --key <hex>` | auto | Chroma key color, e.g. `#ffffff` |
| `-t, --tolerance <1-100>` | `25` | Chroma color tolerance |
| `--feather <px>` | `1.5` | Chroma edge softness |
| `-c, --concurrency <n>` | `2` | Files processed in parallel |
| `--recursive` | off | Recurse into subfolders |
| `--skip-existing` | off | Don't overwrite outputs that already exist |
| `--save-mask` | off | Also write `<name>_mask.png` (grayscale alpha matte) |
| `--dry-run` | off | List matched images and exit |

Outputs keep the original filename with a `.png` extension (`srm.jpeg` → `output/srm.png`), full original resolution, alpha-transparent. Collisions are auto-suffixed (`a.jpg` + `a.png` → `a.png`, `a-1.png`). Exit code is non-zero if any file fails, so it's script-friendly.

## Using it inside your Next.js project

Drop this folder anywhere in the repo (e.g. `tools/bg-remover/`) — it is self-contained and its `package.json` does not touch your app's dependencies:

```bash
cd tools/bg-remover && npm install
node remove-bg.mjs ../../public/products/ -o ../../public/products-cutouts/
```

Or add a script to your **root** `package.json`:

```json
{
  "scripts": {
    "bg": "node tools/bg-remover/remove-bg.mjs"
  }
}
```

…then `npm run bg -- public/products/ --reuse-mask`. Modules resolve from either the local `node_modules` or the project root's, so both layouts work. Suggest adding `**/output/` to `.gitignore`.

## Performance notes (self-hosted)

- First AI run per invocation loads the model once (~1 s) and reuses it for the whole batch — prefer one big run over many single-file runs.
- `-c` raises throughput for chroma batches. For AI, 2–3 is a sensible ceiling; every parallel file holds a full-resolution RGBA buffer in memory (~30–80 MB each at 4 MP).
- ONNX runs on CPU by default and uses all cores for a single inference; don't set `-c` above your core count.

## Troubleshooting

- **`npm install` blocks native build scripts** (npm ≥ 11): approve them once —
  `npm install-scripts approve sharp onnxruntime-node && npm rebuild sharp onnxruntime-node`.
- **Chroma ate parts of my product** — the product shares tones with the backdrop (e.g. teal product on a green screen), or the product is glass/transparent (the backdrop shows through, so the fill leaks inside). Lower `-t`, set `-k` explicitly, or just use the AI engine.
- **Product bottom still looks cut** (rare) — the auto bottom-recovery covers glass bases; for extreme cases compare with `--save-mask` and consider shooting on a contrasting backdrop.
- **Chroma left background patches** — the backdrop isn't uniform (shadows, gradients, blur). That's expected; use AI (the default).
- **A side still shows residue** (the log printed `R✗(n)` or `haze Npx`) — raise the sweep strictness for that shot: `node remove-bg.mjs shots/ --sweep-tol 60`. A pocket fully *enclosed* by product parts whose own colors don't match the backdrop can stay (it reads as shading behind the product) — that's the documented limit of any color-based check.
- **Sweep ate a thin translucent part** (rare) — lower `--sweep-tol` (e.g. 32) or run with `--no-sweep` and compare.
- **Windows/macOS**: native binaries for sharp and onnxruntime-node are prebuilt for all three platforms; Node ≥ 18.17 required.

## License notes

- This wrapper code: MIT — do whatever you want with it.
- [`@imgly/background-removal-node`](https://www.npmjs.com/package/@imgly/background-removal-node) (the AI engine) is **AGPL-3.0**. Fine for internal tooling like this batch CLI. If you ever redistribute the tool or expose it as a hosted service to third parties, review AGPL obligations (or talk to img.ly about commercial licensing).
- `sharp` is Apache-2.0. Processed images remain entirely yours.
