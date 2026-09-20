#!/usr/bin/env python3
"""去掉叠在图片上的水印 / 角标（半透明底 + 描边 + 文字 + 投影那一类）。

为什么不能模糊或涂白：
    这类水印不是一块纯色贴纸，而是「半透明底 + 白描边 + 白字 + 一圈投影」，
    模糊或盖色只会把灰印糊开，原来的轮廓仍然看得见。

做法：
    1. 把整块区域（含投影）判为「未知」；
    2. 用调和函数填充：在区域内解 Laplace 方程，区域边界像素全部原样取自原图，
       因此拼接处天然无接缝；背景若是平滑渐变，结果与真实背景几乎一致；
    3. 补回与周边同强度的微弱噪点，免得留下一块「过分干净」的补丁。

    背景越平滑效果越好。水印压在人脸 / 头发 / 纹理上时，本脚本只能糊出一团，
    那种情况先用 --preview 确认位置，再改用 cv2.inpaint 或生成式修补。

用法：
    python3 remove_watermark.py a.png                  # 自动找角标并去掉
    python3 remove_watermark.py a.png --preview p.png  # 只画框不改图（先确认位置）
    python3 remove_watermark.py a.png --box 16,16,326,178
    python3 remove_watermark.py a.png --check          # 打印修复前后的残差指标
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

MARGIN = 16  # 提供给 Laplace 求解的固定边界宽度
SUFFIX = "_无水印"


# --------------------------------------------------------------------------
# 调和填充
# --------------------------------------------------------------------------
def _down_mean(a: np.ndarray) -> np.ndarray:
    """2x2 块均值下采样（保持末维不变）。"""
    h, w = a.shape[:2]
    h2, w2 = h // 2, w // 2
    return a[: h2 * 2, : w2 * 2].reshape(h2, 2, w2, 2, -1).mean(axis=(1, 3))


def _down_any(m: np.ndarray) -> np.ndarray:
    """掩膜下采样：任一子像素未知则整体未知。"""
    h, w = m.shape
    h2, w2 = h // 2, w // 2
    return m[: h2 * 2, : w2 * 2].reshape(h2, 2, w2, 2).any(axis=(1, 3))


def _jacobi(u: np.ndarray, mask: np.ndarray, iters: int) -> np.ndarray:
    """迭代求调和函数：未知区域不断取四邻域平均，已知边界保持不动。"""
    for _ in range(iters):
        avg = 0.25 * (
            np.roll(u, 1, 0) + np.roll(u, -1, 0) + np.roll(u, 1, 1) + np.roll(u, -1, 1)
        )
        u[mask] = avg[mask]
    return u


def _harmonic_fill(
    window: np.ndarray, mask: np.ndarray, rounds=(400, 300, 300, 400, 900)
) -> np.ndarray:
    """多尺度（金字塔由粗到细）求解，等价于在掩膜内解 Laplace 方程。"""
    pyr = [(window.copy(), mask.copy())]
    for _ in range(len(rounds) - 1):
        w, m = pyr[-1]
        if min(w.shape[:2]) < 12:
            break
        pyr.append((_down_mean(w), _down_any(m)))

    coarse, cmask = pyr[-1]
    _jacobi(coarse, cmask, 4000)

    for lvl in range(len(pyr) - 2, -1, -1):
        w, m = pyr[lvl]
        up = np.repeat(np.repeat(coarse, 2, axis=0), 2, axis=1)
        # 奇数尺寸下采样会丢一行 / 一列，上采样回来要补齐，否则尺寸对不上
        pad = ((0, max(0, w.shape[0] - up.shape[0])),
               (0, max(0, w.shape[1] - up.shape[1])), (0, 0))
        if pad[0][1] or pad[1][1]:
            up = np.pad(up, pad, mode="edge")
        up = up[: w.shape[0], : w.shape[1]]
        w[m] = up[m]
        _jacobi(w, m, rounds[lvl])
        coarse = w
    return pyr[0][0]


def _noise_sigma(rgb: Image.Image, box) -> float:
    """量一下水印下方那块干净背景的高频噪声强度。"""
    x0, y0, x1, y1 = box
    w, h = rgb.size
    patch = rgb.crop((x0, min(h, y1 + 24), x1, min(h, y1 + 144))).convert("L")
    if patch.height < 20:
        return 0.0
    grey = np.asarray(patch).astype(np.float32)
    blur = np.asarray(patch.filter(ImageFilter.GaussianBlur(1.5))).astype(np.float32)
    return float(np.clip((grey - blur).std(), 0.0, 1.5))


def remove_watermark(img: Image.Image, box, margin: int = MARGIN) -> Image.Image:
    """把 box 区域的像素整块重算，返回新图。"""
    rgb = img.convert("RGB")
    a = np.asarray(rgb).astype(np.float32)

    x0, y0, x1, y1 = box
    wx0, wy0 = max(0, x0 - margin), max(0, y0 - margin)
    wx1, wy1 = min(a.shape[1], x1 + margin), min(a.shape[0], y1 + margin)
    window = a[wy0:wy1, wx0:wx1].copy()

    mask = np.zeros(window.shape[:2], dtype=bool)
    mask[y0 - wy0 : y1 - wy0, x0 - wx0 : x1 - wx0] = True

    filled = _harmonic_fill(window, mask)

    sigma = _noise_sigma(rgb, box)
    if sigma > 0.05:
        rng = np.random.default_rng(20260914)
        filled[mask] += rng.normal(0.0, sigma, size=(int(mask.sum()), 3)).astype(np.float32)

    a[wy0:wy1, wx0:wx1] = np.clip(filled, 0, 255)
    return Image.fromarray(a.round().astype(np.uint8), "RGB")


# --------------------------------------------------------------------------
# 自动找水印：在角部稳健拟合一个二次曲面当背景，把偏离它的连通块当水印
# --------------------------------------------------------------------------
def _quad_design(xx: np.ndarray, yy: np.ndarray, w: int, h: int) -> np.ndarray:
    xn = (xx - (w - 1) / 2) / w
    yn = (yy - (h - 1) / 2) / h
    return np.stack([np.ones_like(xn), xn, yn, xn * xn, xn * yn, yn * yn], axis=-1)


def _robust_quadratic(lum: np.ndarray, iterations: int = 5):
    """稳健拟合 lum ≈ 二次曲面（反复剔除离群点），返回残差图和残差尺度。"""
    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w]
    A = _quad_design(xx.astype(np.float64), yy.astype(np.float64), w, h).reshape(-1, 6)
    y = lum.reshape(-1).astype(np.float64)
    sel = np.ones(y.size, dtype=bool)
    resid = np.zeros_like(y)
    for _ in range(iterations):
        if sel.sum() < max(50, 0.3 * y.size):
            break
        coef, *_ = np.linalg.lstsq(A[sel], y[sel], rcond=None)
        resid = y - A @ coef
        sigma = float(np.median(np.abs(resid[sel])) * 1.4826)
        sel = np.abs(resid) < max(1.5, 3.0 * sigma)
    sigma = float(np.median(np.abs(resid[sel])) * 1.4826) if sel.any() else 0.0
    return resid.reshape(h, w), sigma


def _components(mask: np.ndarray, seed: np.ndarray | None = None):
    """四邻域连通块，返回 [{area, seed_px, bbox}]，bbox 为 (x0, y0, x1, y1) 右开区间。"""
    h, w = mask.shape
    seen = np.zeros_like(mask)
    out = []
    for sy, sx in zip(*np.nonzero(mask)):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        area = 0
        seed_px = 0
        y0 = y1 = sy
        x0 = x1 = sx
        while stack:
            cy, cx = stack.pop()
            area += 1
            if seed is not None and seed[cy, cx]:
                seed_px += 1
            y0, y1 = min(y0, cy), max(y1, cy)
            x0, x1 = min(x0, cx), max(x1, cx)
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        out.append({"area": area, "seed_px": seed_px, "bbox": (x0, y0, x1 + 1, y1 + 1)})
    return out


def detect_box(img: Image.Image, corner: str = "tl", scope: float = 0.22,
               grow: int = 10, min_area: int = 200, max_contrast: float = 80.0,
               min_seed: int = 20):
    """返回 (box, info)；没找到像水印的东西时 box 为 None。

    用二次曲面当背景模型，双阈值（hysteresis）圈选：
    高阈值拿到描边 / 文字这类铁定是水印的「种子」，
    再沿低阈值把半透明底和投影一起长出来——这样才框得住整块。
    """
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    H, W = a.shape[:2]
    s = max(64, int(min(H, W) * scope))
    x0, x1 = (0, min(s, W)) if corner in ("tl", "bl") else (max(0, W - s), W)
    y0, y1 = (0, min(s, H)) if corner in ("tl", "tr") else (max(0, H - s), H)

    lum = a[y0:y1, x0:x1].mean(2)
    resid, sigma = _robust_quadratic(lum)
    resid = np.abs(resid)
    thr_hi = max(4.0, 6.0 * max(sigma, 0.2))
    thr_lo = max(1.5, 1.5 * max(sigma, 0.2))
    seed = resid > thr_hi
    info = {"sigma": round(sigma, 2), "seed_px": int(seed.sum()),
            "thr_lo": round(thr_lo, 2), "thr_hi": round(thr_hi, 2)}
    if seed.sum() < min_seed:
        return None, info

    mask = resid > thr_lo
    comps = [c for c in _components(mask, seed)
             if c["area"] >= min_area and c["seed_px"] >= min_seed]
    # 水印是低对比度的半透明叠加，偏离背景有限；头发 / 五官会差出很远
    comps = [c for c in comps
             if float(resid[c["bbox"][1]:c["bbox"][3], c["bbox"][0]:c["bbox"][2]].max())
             <= max_contrast]
    if not comps:
        return None, info

    # 优先选没顶到搜索区边缘的那块：水印一般浮在画面中间，头发之类会顶到边上
    hh, ww = mask.shape
    inset = [c for c in comps
             if c["bbox"][0] > 1 and c["bbox"][1] > 1
             and c["bbox"][2] < ww - 1 and c["bbox"][3] < hh - 1]
    if inset:
        best = max(inset, key=lambda c: c["area"])
    else:
        best = max(comps, key=lambda c: c["area"])
        info["warning"] = "候选块顶到边缘，可能是画面内容而非水印，务必先看 preview"
    info["area"] = best["area"]

    bx0, by0, bx1, by1 = best["bbox"]
    box = (max(0, x0 + bx0 - grow), max(0, y0 + by0 - grow),
           min(W, x0 + bx1 + grow), min(H, y0 + by1 + grow))
    return box, info


# --------------------------------------------------------------------------
# 校验：修好之后框内不该再有任何高频结构（水印的边 / 字会留下很高的残差）
# --------------------------------------------------------------------------
def hp_max(img: Image.Image, box, blur: float = 3.0, pad: int = 4) -> float:
    g = img.convert("L")
    a = np.asarray(g).astype(np.float32)
    b = np.asarray(g.filter(ImageFilter.GaussianBlur(blur))).astype(np.float32)
    hp = np.abs(a - b)
    x0, y0, x1, y1 = box
    return float(hp[y0 + pad : max(y0 + pad + 1, y1 - pad),
                    x0 + pad : max(x0 + pad + 1, x1 - pad)].max())


def make_preview(img: Image.Image, box, path: Path, max_side: int = 900) -> Path:
    scale = min(1.0, max_side / max(img.size))
    vis = img.convert("RGB").resize(
        (max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS
    )
    d = ImageDraw.Draw(vis)
    x0, y0, x1, y1 = [v * scale for v in box]
    d.rectangle([x0, y0, x1, y1], outline=(255, 60, 60), width=max(2, int(4 * scale)))
    vis.save(path)
    return path


def _parse_box(text: str):
    parts = [int(float(p)) for p in text.replace(" ", "").split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("--box 要 L,T,R,B 四个数，例如 16,16,326,178")
    l, t, r, b = parts
    if not (r > l and b > t):
        raise argparse.ArgumentTypeError("--box 的 right/bottom 必须大于 left/top")
    return (l, t, r, b)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="去掉图片角上的水印 / 角标")
    ap.add_argument("inputs", nargs="+", help="要处理的图片")
    ap.add_argument("--box", type=_parse_box, help="手动指定水印外接框 L,T,R,B（像素，含投影）")
    ap.add_argument("--corner", default="tl", choices=["tl", "tr", "bl", "br"],
                    help="自动检测只看哪个角，默认 tl")
    ap.add_argument("--scope", type=float, default=0.22, help="角部搜索范围占短边的比例，默认 0.22")
    ap.add_argument("--grow", type=int, default=10, help="检测框向外扩张的像素，默认 10")
    ap.add_argument("--margin", type=int, default=MARGIN, help="填充用的固定边界宽度，默认 16")
    ap.add_argument("--suffix", default=SUFFIX, help=f"输出文件名后缀，默认 {SUFFIX}")
    ap.add_argument("--preview", metavar="PATH", help="只把检测到的框画出来存成 PATH，不改图")
    ap.add_argument("--check", action="store_true", help="打印修复前后的残差指标")
    ap.add_argument("-o", "--outdir", help="输出目录，默认与输入同目录")
    args = ap.parse_args(argv[1:])

    if args.outdir:
        Path(args.outdir).expanduser().mkdir(parents=True, exist_ok=True)

    status = 0
    for raw in args.inputs:
        src = Path(raw).expanduser()
        img = Image.open(src)
        box, info = (args.box, {"manual": True}) if args.box else detect_box(
            img, args.corner, args.scope, args.grow
        )
        note = " ".join(f"{k}={v}" for k, v in info.items())
        if box is None:
            print(f"[跳过] {src.name}：没在 {args.corner} 角找到像水印的东西（{note}）")
            status = 1
            continue

        print(f"[框选] {src.name}：box={box} {note}")
        if args.preview:
            print(f"[预览] 只画框未改图 -> {make_preview(img, box, Path(args.preview).expanduser())}")
            continue
        if "warning" in info:
            print("       ↑ 选框不确定，先看 --preview 或直接给 --box，这次不改图")
            status = 1
            continue

        out = (Path(args.outdir).expanduser() / (src.stem + args.suffix + src.suffix)
               if args.outdir else src.with_name(src.stem + args.suffix + src.suffix))
        fixed = remove_watermark(img, box, args.margin)
        fixed.save(out)
        if args.check:
            print(f"[校验] 框内高频残差 max|hp|：修复前 {hp_max(img, box):.2f} -> "
                  f"修复后 {hp_max(fixed, box):.2f}（修复后 < 2 基本等于看不见）")
        print(f"[输出] {out}")
    return status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
