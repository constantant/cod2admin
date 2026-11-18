#!/usr/bin/env python3
"""Extract map loading screens from CoD2 .iwd packs into the Mini App's map pictures.

For every <name>.iwd (or every .iwd under a folder, recursively) it looks for
`images/loadscreen_<map>.iwi` inside the zip, decodes the IWI (DXT1/3/5, ARGB32, RGB24) and writes
`<map>.webp` (320x240, 4:3) into the output folder. Only multiplayer maps (`mp_*`) are kept, and an
existing picture is never overwritten unless --force is given.

    python3 scripts/extract-map-images.py <folder-or-iwd>... [-o apps/miniapp-web/public/maps]

Needs Pillow (`pip install pillow`).
"""
import argparse
import io
import struct
import sys
import zipfile
from pathlib import Path

from PIL import Image

SIZE = (320, 240)
LOADSCREEN = "images/loadscreen_"

# IWI v5 header: "IWi", version, format, usage, u16 width, u16 height, u16 depth, then mip offsets.
# The largest mip (the one we want) is stored last, so it is the final w*h-derived bytes of the file.
DXT_BLOCK = {0x0B: (b"DXT1", 8), 0x0C: (b"DXT3", 16), 0x0D: (b"DXT5", 16)}


def decode_iwi(data: bytes) -> Image.Image:
    if data[:3] != b"IWi":
        raise ValueError("not an IWI file")
    version, fmt = data[3], data[4]
    if version != 5:
        raise ValueError(f"IWI version {version} (CoD2 uses 5)")
    width, height = struct.unpack_from("<HH", data, 6)
    if fmt in DXT_BLOCK:
        fourcc, block = DXT_BLOCK[fmt]
        size = ((width + 3) // 4) * ((height + 3) // 4) * block
        pixels = data[len(data) - size:]
        # Wrap the raw blocks in a minimal DDS header so Pillow's DXT decoder can read them.
        header = b"DDS " + struct.pack(
            "<7I11I2I4s5I5I",
            124, 0x1007 | 0x80000, height, width, size, 0, 1,  # size, flags, h, w, linear size, depth, mips
            *([0] * 11),
            32, 0x4, fourcc, 0, 0, 0, 0, 0,  # pixel format: size, flags=FOURCC, fourcc, bitcount, masks
            0x1000, 0, 0, 0, 0,  # caps
        )
        return Image.open(io.BytesIO(header + pixels)).convert("RGB")
    if fmt == 0x01:  # ARGB32, stored as BGRA
        size = width * height * 4
        return Image.frombuffer("RGBA", (width, height), data[len(data) - size:], "raw", "BGRA", 0, 1).convert("RGB")
    if fmt == 0x02:  # RGB24, stored as BGR
        size = width * height * 3
        return Image.frombuffer("RGB", (width, height), data[len(data) - size:], "raw", "BGR", 0, 1)
    raise ValueError(f"unsupported IWI format 0x{fmt:02x}")


def iwd_files(paths):
    for p in paths:
        p = Path(p)
        yield from sorted(p.rglob("*.iwd")) if p.is_dir() else [p]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sources", nargs="+", help="folders (searched recursively) and/or .iwd files")
    ap.add_argument("-o", "--out", default="apps/miniapp-web/public/maps", help="output folder")
    ap.add_argument("--force", action="store_true", help="overwrite pictures that already exist")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    written = skipped = failed = 0
    seen = set()
    for iwd in iwd_files(args.sources):
        try:
            zf = zipfile.ZipFile(iwd)
        except zipfile.BadZipFile:
            print(f"skip {iwd}: not a zip", file=sys.stderr)
            continue
        with zf:
            for info in zf.infolist():
                name = info.filename.lower()
                if not (name.startswith(LOADSCREEN) and name.endswith(".iwi")):
                    continue
                map_name = name[len(LOADSCREEN):-4]
                if not map_name.startswith("mp_") or map_name in seen:
                    continue
                seen.add(map_name)
                target = out / f"{map_name}.webp"
                if target.exists() and not args.force:
                    skipped += 1
                    continue
                try:
                    img = decode_iwi(zf.read(info)).resize(SIZE, Image.LANCZOS)
                    img.save(target, "WEBP", quality=80, method=6)
                    written += 1
                    print(f"wrote {target}  (from {iwd.name})")
                except Exception as e:  # one bad pack must not stop the rest
                    failed += 1
                    print(f"FAILED {map_name} in {iwd.name}: {e}", file=sys.stderr)
    print(f"done: {written} written, {skipped} already there, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
