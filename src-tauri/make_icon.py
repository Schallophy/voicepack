# -*- coding: utf-8 -*-
"""Redraw the VoicePack app icon: coral rounded tile + five white rounded bars.
Pure stdlib (zlib + struct), analytic SDF edges for clean antialiasing."""

import struct
import zlib

SIZE = 1024
TILE_INSET = 56.0          # transparent margin around the tile
TILE_RADIUS = 190.0
TILE_RGB = (0xD9, 0x77, 0x57)

BAR_W = 92.0
BAR_GAP = 64.0
BAR_HEIGHTS = [330.0, 500.0, 670.0, 500.0, 330.0]  # relative pattern, centred vertically
BAR_RGB = (0xFF, 0xFF, 0xFF)


def sd_round_rect(px, py, cx, cy, half_w, half_h, r):
    """Signed distance to a rounded rectangle."""
    qx = abs(px - cx) - (half_w - r)
    qy = abs(py - cy) - (half_h - r)
    ox = max(qx, 0.0)
    oy = max(qy, 0.0)
    outside = (ox * ox + oy * oy) ** 0.5
    inside = min(max(qx, qy), 0.0)
    return outside + inside - r


def coverage(d):
    """1 inside, 0 outside, smooth across one pixel."""
    return max(0.0, min(1.0, 0.5 - d))


def main():
    tile_cx = tile_cy = SIZE / 2.0
    tile_half = SIZE / 2.0 - TILE_INSET

    bars = []
    group_w = len(BAR_HEIGHTS) * BAR_W + (len(BAR_HEIGHTS) - 1) * BAR_GAP
    x = tile_cx - group_w / 2.0 + BAR_W / 2.0
    for h in BAR_HEIGHTS:
        bars.append((x, tile_cy, BAR_W / 2.0, h / 2.0))
        x += BAR_W + BAR_GAP

    rows = bytearray()
    for y in range(SIZE):
        rows.append(0)  # filter: none
        for x in range(SIZE):
            px, py = x + 0.5, y + 0.5
            a_tile = coverage(sd_round_rect(px, py, tile_cx, tile_cy, tile_half, tile_half, TILE_RADIUS))
            a_bars = 0.0
            for (bx, by, hw, hh) in bars:
                a_bars = max(a_bars, coverage(sd_round_rect(px, py, bx, by, hw, hh, hw)))
            tr, tg, tb = TILE_RGB
            r = tr + (BAR_RGB[0] - tr) * a_bars
            g = tg + (BAR_RGB[1] - tg) * a_bars
            b = tb + (BAR_RGB[2] - tb) * a_bars
            rows.extend((int(r + 0.5), int(g + 0.5), int(b + 0.5), int(a_tile * 255 + 0.5)))

    def chunk(tag, data):
        raw = tag + data
        return struct.pack('>I', len(data)) + raw + struct.pack('>I', zlib.crc32(raw) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(bytes(rows), 9))
           + chunk(b'IEND', b''))
    with open('icons/icon-src.png', 'wb') as f:
        f.write(png)
    print('written', len(png), 'bytes')


if __name__ == '__main__':
    main()
