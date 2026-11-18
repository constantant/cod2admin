Map screenshots shown on the Maps page: <mapname>.webp, 320x240 (4:3), e.g. mp_toujane.webp.
Only multiplayer maps (mp_*) are kept. A map without a file gets a generated tile. They are the loading
screens extracted from the maps' own .iwd files (decoded from .iwi, resized, WebP).

To add new maps: python3 scripts/extract-map-images.py <folder with .iwd files> (needs Pillow). It reads
images/loadscreen_<map>.iwi from each pack and skips maps that already have a picture (--force to redo).
