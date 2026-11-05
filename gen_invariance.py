#!/usr/bin/env python3
"""Scale/color invariance fixtures.

Builds photo+cutout pairs with the SAME injected debris recipe at several
resolutions and color transforms. Every coordinate is a FRACTION of W/H so
the debris geometry is identical across scales - exactly the invariance the
sweep must show. Two opaque backdrop strips pin debris to the right and
bottom canvas frames (the real-world catamax failure mode).

Base: upload/srm.jpeg (photo) + test-sweep-nosweep/srm.png (raw AI cutout,
pre-sweep).
"""
import os
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

ROOT = '/home/z/my-project'
ORIG = f'{ROOT}/upload/srm.jpeg'
CUT_IN = f'{ROOT}/scripts/bg-remover/test-sweep-nosweep/srm.png'
OUT = f'{ROOT}/scripts/bg-remover/test-inv'

# ---- fractions of the original 1536x2752 geometry ------------------------
F = {
    'stripe_x0': 1080 / 1536, 'stripe_dx': 28 / 1536, 'stripe_w': 10 / 1536,
    'stripe_top': 1250 / 2752, 'stripe_bot': 1750 / 2752,
    'fuzz_cx': 1190 / 1536, 'fuzz_cy': 1500 / 2752,
    'fuzz_rx': 130 / 1536, 'fuzz_ry': 320 / 2752, 'fuzz_blur': 25 / 1536,
    'lblob_cx': 470 / 1536, 'lblob_cy': 1450 / 2752,
    'lblob_rx': 170 / 1536, 'lblob_ry': 260 / 2752, 'lblob_blur': 30 / 1536,
    'trail_y0': 1350 / 2752, 'trail_y1': 1560 / 2752, 'trail_x1': 500 / 1536,
    'trail_blur': 18 / 1536,
    'top_cx': 790 / 1536, 'top_cy': 600 / 2752,
    'top_rx': 200 / 1536, 'top_ry': 55 / 2752, 'top_blur': 22 / 1536,
    'tband_y1': 600 / 2752, 'tband_x0': 690 / 1536, 'tband_x1': 900 / 1536,
    'pocket_y0': 2130 / 2752, 'pocket_y1': 2220 / 2752,
    'pocket_x0': 540 / 1536, 'pocket_x1': 740 / 1536,
    'wisp_cx': 790 / 1536, 'wisp_cy': 2160 / 2752,
    'wisp_rx': 300 / 1536, 'wisp_ry': 45 / 2752, 'wisp_blur': 18 / 1536,
    'bband_y0': 2400 / 2752, 'bband_x0': 380 / 1536, 'bband_x1': 1150 / 1536,
    'bband_blur': 25 / 1536,
    'rstrip_x0': 0.988, 'rstrip_y0': 0.30, 'rstrip_y1': 0.55,
    'bstrip_y0': 0.988, 'bstrip_x0': 0.30, 'bstrip_x1': 0.55,
    # photo sample windows
    'table': (2250 / 2752, 2450 / 2752, 150 / 1536, 450 / 1536),
    'table_dk': (2450 / 2752, 2600 / 2752, 900 / 1536, 1200 / 1536),
    'topband': (30 / 2752, 160 / 2752, 550 / 1536, 950 / 1536),
    'tex': (2250 / 2752, 2550 / 2752, 100 / 1536, 600 / 1536),
}


def hue_rotate(arr, deg):
    img = Image.fromarray(np.uint8(arr.clip(0, 255)))
    hsv = np.array(img.convert('HSV'))
    hsv[:, :, 0] = (hsv[:, :, 0].astype(np.int32) + int(deg / 360 * 255)) % 256
    return np.array(Image.fromarray(hsv, 'HSV').convert('RGB')).astype(np.float32)


def grayscale(arr):
    img = Image.fromarray(np.uint8(arr.clip(0, 255))).convert('L')
    return np.stack([np.array(img)] * 3, axis=-1).astype(np.float32)


def ellipse_mask(w, h, cx, cy, rx, ry, blur):
    m = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(m)
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=255)
    return np.array(m.filter(ImageFilter.GaussianBlur(max(0.5, blur))))


def add_soft(img, mask, color, alpha):
    a = (mask.astype(np.float32) / 255.0) * (alpha / 255.0)
    for c in range(3):
        img[:, :, c] = img[:, :, c] * (1 - a) + color[c] * a


def build(name, scale, transform=None):
    photo = np.array(Image.open(ORIG).convert('RGB')).astype(np.float32)
    cut = np.array(Image.open(CUT_IN).convert('RGBA')).astype(np.float32)

    if transform == 'hue120':
        photo, cut[:, :, :3] = hue_rotate(photo, 120), hue_rotate(cut[:, :, :3], 120)
    elif transform == 'hue240':
        photo, cut[:, :, :3] = hue_rotate(photo, 240), hue_rotate(cut[:, :, :3], 240)
    elif transform == 'gray':
        photo, cut[:, :, :3] = grayscale(photo), grayscale(cut[:, :, :3])

    W = int(round(photo.shape[1] * scale))
    H = int(round(photo.shape[0] * scale))
    photo = np.array(Image.fromarray(np.uint8(photo.clip(0, 255))).resize((W, H), Image.LANCZOS)).astype(np.float32)
    cut = np.array(Image.fromarray(np.uint8(cut.clip(0, 255))).resize((W, H), Image.LANCZOS)).astype(np.float32)
    s = W / 1536.0  # blur-radius scale

    px = lambda f: int(round(f * W))
    py = lambda f: int(round(f * H))

    def win(key):
        y0, y1, x0, x1 = F[key]
        return photo[py(y0):py(y1), px(x0):px(x1)].reshape(-1, 3).mean(axis=0)

    table, table_dk, topband = win('table'), win('table_dk'), win('topband')
    ty0, ty1, tx0, tx1 = F['tex']
    tex = photo[py(ty0):py(ty1), px(tx0):px(tx1)].copy()

    def paste_texture(img, y0, y1, x0, x1):
        th, tw = tex.shape[:2]
        ys = np.arange(y0, y1) % th
        xs = np.arange(x0, x1) % tw
        img[y0:y1, x0:x1, :3] = tex[np.ix_(ys, xs)]

    out = cut.copy()
    photo_out = photo.copy()

    # RIGHT: product stripes + opaque pockets + fuzz
    sx0, sdx, sw = px(F['stripe_x0']), px(F['stripe_dx']), px(F['stripe_w'])
    st, sb = py(F['stripe_top']), py(F['stripe_bot'])
    fz = ellipse_mask(W, H, px(F['fuzz_cx']), py(F['fuzz_cy']),
                      px(F['fuzz_rx']), py(F['fuzz_ry']), F['fuzz_blur'] * W)
    add_soft(out, fz, table_dk, 140)
    for k in range(6):
        x1 = min(sx0 + k * sdx + sw, W)
        out[st:sb, sx0 + k * sdx:x1, :3] = 25
        out[st:sb, sx0 + k * sdx:x1, 3] = 255
    for k in range(5):
        gx0, gx1 = sx0 + k * sdx + sw, sx0 + (k + 1) * sdx
        paste_texture(out, st, sb, gx0, gx1)
        out[st:sb, gx0:gx1, 3] = 255
        paste_texture(photo_out, st, sb, gx0, gx1)

    # RIGHT/BOTTOM frame strips: opaque backdrop touching the canvas edge
    paste_texture(out, py(F['rstrip_y0']), py(F['rstrip_y1']), px(F['rstrip_x0']), W)
    out[py(F['rstrip_y0']):py(F['rstrip_y1']), px(F['rstrip_x0']):W, 3] = 255
    paste_texture(photo_out, py(F['rstrip_y0']), py(F['rstrip_y1']), px(F['rstrip_x0']), W)
    paste_texture(out, py(F['bstrip_y0']), H, px(F['bstrip_x0']), px(F['bstrip_x1']))
    out[py(F['bstrip_y0']):H, px(F['bstrip_x0']):px(F['bstrip_x1']), 3] = 255
    paste_texture(photo_out, py(F['bstrip_y0']), H, px(F['bstrip_x0']), px(F['bstrip_x1']))

    # LEFT: haze blob + trail to frame
    hz = ellipse_mask(W, H, px(F['lblob_cx']), py(F['lblob_cy']),
                      px(F['lblob_rx']), py(F['lblob_ry']), F['lblob_blur'] * W)
    add_soft(out, hz, table, 120)
    tr = np.zeros((H, W), np.uint8)
    tr[py(F['trail_y0']):py(F['trail_y1']), 0:px(F['trail_x1'])] = 255
    tr = np.array(Image.fromarray(tr).filter(ImageFilter.GaussianBlur(F['trail_blur'] * W)))
    add_soft(out, tr, table, 95)

    # TOP: fuzz halo + haze band to frame
    hl = ellipse_mask(W, H, px(F['top_cx']), py(F['top_cy']),
                      px(F['top_rx']), py(F['top_ry']), F['top_blur'] * W)
    add_soft(out, hl, topband, 130)
    tb = np.zeros((H, W), np.uint8)
    tb[0:py(F['tband_y1']), px(F['tband_x0']):px(F['tband_x1'])] = 255
    tb = np.array(Image.fromarray(tb).filter(ImageFilter.GaussianBlur(F['top_blur'] * W)))
    add_soft(out, tb, topband, 80)

    # BOTTOM: opaque pocket + wisps + haze band to frame
    paste_texture(out, py(F['pocket_y0']), py(F['pocket_y1']), px(F['pocket_x0']), px(F['pocket_x1']))
    out[py(F['pocket_y0']):py(F['pocket_y1']), px(F['pocket_x0']):px(F['pocket_x1']), 3] = 255
    paste_texture(photo_out, py(F['pocket_y0']), py(F['pocket_y1']), px(F['pocket_x0']), px(F['pocket_x1']))
    wz = ellipse_mask(W, H, px(F['wisp_cx']), py(F['wisp_cy']),
                      px(F['wisp_rx']), py(F['wisp_ry']), F['wisp_blur'] * W)
    add_soft(out, wz, table_dk, 120)
    bb = np.zeros((H, W), np.uint8)
    bb[py(F['bband_y0']):H, px(F['bband_x0']):px(F['bband_x1'])] = 255
    bb = np.array(Image.fromarray(bb).filter(ImageFilter.GaussianBlur(F['bband_blur'] * W)))
    add_soft(out, bb, table, 85)

    d = f'{OUT}/{name}'
    os.makedirs(d, exist_ok=True)
    Image.fromarray(np.uint8(photo_out.clip(0, 255))).save(f'{d}/photo.png')
    Image.fromarray(np.uint8(out.clip(0, 255))).save(f'{d}/cutout-in.png')
    print(f'{name}: {W}x{H}')


os.makedirs(OUT, exist_ok=True)
build('s025', 0.25)
build('s050', 0.5)
build('s100', 1.0)
build('s200', 2.0)
build('hue120', 1.0, 'hue120')
build('hue240', 1.0, 'hue240')
build('gray', 1.0, 'gray')
print('done')
