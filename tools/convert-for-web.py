#!/usr/bin/env python3
r"""
convert-for-web.py — Đưa video về định dạng mà browser mọi nền tảng phát được:
  MP4 (H.264 + AAC) + file phụ đề .srt riêng — chơi tốt trên Chrome/Edge/Firefox
  (Windows, Linux, Android) và Safari/iOS.

Nguyên tắc giữ chất lượng:
  - Video đã là H.264 8-bit (yuv420p)  -> STREAM COPY, không re-encode (nguyên vẹn 100%)
  - Video khác (HEVC/VP9/AV1/10-bit…)  -> encode H.264 CRF 18-20 (gần như không sao chất lượng)
  - Audio đã là AAC                    -> stream copy; codec khác -> encode AAC
  - Phụ đề text (SRT/ASS)              -> extract ra .srt cạnh file (mỗi ngôn ngữ một file)
  - Phụ đề bitmap (PGS/DVB)            -> bỏ qua (web không dùng được, sẽ báo khi chạy)

Chạy được trên Windows / Linux / macOS / Android (Termux). Yêu cầu ffmpeg trong PATH:
  Windows : winget install ffmpeg        (hoặc choco install ffmpeg)
  macOS   : brew install ffmpeg
  Linux   : sudo apt install ffmpeg
  Android : pkg install ffmpeg       (Termux)

Ví dụ:
  python convert-for-web.py "D:\\Phim"                 # convert cả thư mục (đệ quy), xuất cạnh file gốc
  python convert-for-web.py film.mkv --out ./web       # xuất sang thư mục khác (giữ cây thư mục)
  python convert-for-web.py Phim --dry-run             # chỉ xem kế hoạch, chưa convert
  python convert-for-web.py Phim --crf 18 --preset slow
"""

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

VIDEO_EXTS = {
    ".mkv", ".avi", ".flv", ".wmv", ".ts", ".m2ts", ".mts", ".mov", ".webm",
    ".mp4", ".m4v", ".ogv", ".3gp", ".mpg", ".mpeg", ".vob", ".divx", ".f4v",
    ".hevc", ".h265", ".asf", ".rmvb", ".dat", ".tp",
}

# Codec mà browser phát trực tiếp được
OK_VIDEO_CODEC = "h264"
OK_VIDEO_PIXFMT = "yuv420p"   # 10-bit / 4:2:2 đều phải encode lại
OK_AUDIO_CODEC = "aac"


def eprint(*a):
    print(*a, file=sys.stderr)


def find_tools():
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        eprint("LỖI: không tìm thấy ffmpeg trong PATH.")
        eprint("  Windows : winget install ffmpeg   |   macOS : brew install ffmpeg")
        eprint("  Linux   : sudo apt install ffmpeg |   Android (Termux) : pkg install ffmpeg")
        sys.exit(2)
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        cand = Path(ffmpeg).with_name("ffprobe")
        ffprobe = str(cand) if cand.exists() else None
    if not ffprobe:
        eprint("LỖI: không tìm thấy ffprobe (đi kèm ffmpeg).")
        sys.exit(2)
    return ffmpeg, ffprobe


def probe(ffprobe, path):
    r = subprocess.run(
        [ffprobe, "-v", "error", "-print_format", "json", "-show_streams", str(path)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe thất bại: {(r.stderr or '').strip()[:200]}")
    return json.loads(r.stdout or "{}").get("streams", [])


def pick_audio(streams):
    """Ưu tiên track audio có cờ default; không có thì lấy track đầu."""
    auds = [s for s in streams if s.get("codec_type") == "audio"]
    for s in auds:
        if (s.get("disposition") or {}).get("default"):
            return s
    return auds[0] if auds else None


def plan(streams):
    """Chọn video/audio cần xử lý và quyết định copy hay encode."""
    vids = [s for s in streams if s.get("codec_type") == "video"]
    if not vids:
        return None, None, None
    v, a = vids[0], pick_audio(streams)
    v_copy = v.get("codec_name") == OK_VIDEO_CODEC and v.get("pix_fmt") == OK_VIDEO_PIXFMT
    a_copy = bool(a) and a.get("codec_name") == OK_AUDIO_CODEC
    return v, a, {"video": "copy" if v_copy else "encode",
                  "audio": "copy" if a_copy else "encode"}


def sidecar_name(mp4: Path, lang, n, used):
    tag = (lang or "sub").strip() or "sub"
    base = f"{mp4.stem}.{tag}" if n == 1 else f"{mp4.stem}.{tag}.{n}"
    i = 2
    while base in used:
        base = f"{mp4.stem}.{tag}.{i}" if n == 1 else f"{base}.{i}"
        i += 1
    used.add(base)
    return mp4.with_name(base + ".srt")


def run(cmd, quiet=False):
    return subprocess.run(cmd, stderr=subprocess.DEVNULL if quiet else None).returncode == 0


def convert_file(ffmpeg, ffprobe, src: Path, dst: Path, args, dry=False):
    streams = probe(ffprobe, src)
    v, a, act = plan(streams)
    if v is None:
        print("  ! BỎ QUA — không có stream video")
        return "skip"

    dst.parent.mkdir(parents=True, exist_ok=True)
    vdesc = "H.264 copy" if act["video"] == "copy" else f"encode H.264 (crf {args.crf}, {args.preset})"
    adesc = ("AAC copy" if act["audio"] == "copy" else "encode AAC") if a else "không có audio"
    if act["video"] == "copy" and act["audio"] == "copy" and src.suffix.lower() == ".mp4":
        print(f"  = đã hợp lệ (MP4/H.264/AAC) — bỏ qua")
        return "skip"

    print(f"  video: {v.get('codec_name')}/{v.get('pix_fmt')} -> {vdesc}")
    print(f"  audio: {(a or {}).get('codec_name', '-')} -> {adesc}")
    if dry:
        return "plan"

    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-stats",
           "-i", str(src), "-map", f"0:{v['index']}"]
    if a:
        cmd += ["-map", f"0:{a['index']}"]

    if act["video"] == "copy":
        cmd += ["-c:v", "copy"]
    else:
        cmd += ["-c:v", "libx264", "-preset", args.preset, "-crf", str(args.crf), "-pix_fmt", "yuv420p"]

    if a:
        if act["audio"] == "copy":
            cmd += ["-c:a", "copy"]
        else:
            ch = a.get("channels") or 2
            cmd += ["-c:a", "aac", "-b:a", "128k" if ch <= 2 else "256k"]

    cmd += ["-movflags", "+faststart", "-map_metadata", "0", "-map_chapters", "0", str(dst)]

    t0 = time.time()
    if not run(cmd):
        eprint("  LỖI: ffmpeg thất bại")
        dst.unlink(missing_ok=True)
        return "fail"
    print(f"  xong sau {time.time() - t0:.0f}s")

    # ---- extract phụ đề text ra .srt cạnh file xuất ----
    used, n_map, done, skipped_bitmap = set(), {}, 0, 0
    for s in streams:
        if s.get("codec_type") != "subtitle":
            continue
        codec = s.get("codec_name", "")
        if codec not in ("subrip", "ass", "ssa", "webvtt", "mov_text"):
            skipped_bitmap += 1
            continue
        lang = (s.get("tags") or {}).get("language")
        n = n_map.get(lang, 0) + 1
        n_map[lang] = n
        out = sidecar_name(dst, lang, n, used)
        title = (s.get("tags") or {}).get("title", "")
        label = f"{lang or '?'}{' — ' + title if title else ''}"
        if run([ffmpeg, "-y", "-v", "error", "-i", str(src),
                "-map", f"0:{s['index']}", "-c:s", "srt", str(out)], quiet=True):
            done += 1
            print(f"    .srt: {out.name} ({label})")
        else:
            eprint(f"    ! không extract được track {label} -> {out.name}")
    if skipped_bitmap:
        print(f"    ({skipped_bitmap} track phụ đề bitmap bị bỏ qua — web không dùng được)")
    if done:
        print(f"  đã extract {done} file phụ đề .srt")
    return "ok"


def iter_videos(root: Path):
    if root.is_file():
        if root.suffix.lower() in VIDEO_EXTS:
            yield root
        else:
            eprint(f"Không phải file video: {root}")
        return
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS:
            yield p


def out_path(src: Path, root: Path, outdir):
    if outdir is None:
        return src.with_suffix(".mp4")
    if root.is_dir():
        rel = src.parent.relative_to(root)
        return outdir / rel / (src.stem + ".mp4")
    return outdir / (src.stem + ".mp4")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(
        description="Convert video sang MP4 (H.264/AAC) cho web + extract phụ đề .srt",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Ví dụ:\n  python convert-for-web.py Phim --out ./web\n  python convert-for-web.py film.mkv --dry-run",
    )
    ap.add_argument("input", help="file video hoặc thư mục cần quét (đệ quy)")
    ap.add_argument("--out", metavar="DIR", help="thư mục xuất (mặc định: cạnh file gốc)")
    ap.add_argument("--crf", type=int, default=19,
                    help="x264 CRF khi phải re-encode (mặc định 19 — càng nhỏ càng nét)")
    ap.add_argument("--preset", default="medium",
                    help="x264 preset: ultrafast..veryslow (mặc định medium)")
    ap.add_argument("--force", action="store_true", help="convert lại kể cả khi file .mp4 đã tồn tại")
    ap.add_argument("--dry-run", action="store_true", help="chỉ in kế hoạch, không convert")
    args = ap.parse_args()

    ffmpeg, ffprobe = find_tools()

    root = Path(args.input).expanduser().resolve()
    if not root.exists():
        eprint(f"LỖI: không tồn tại: {root}")
        sys.exit(2)
    outdir = Path(args.out).expanduser().resolve() if args.out else None

    files = list(iter_videos(root))
    if not files:
        print("Không tìm thấy video nào.")
        return
    print(f"Tìm thấy {len(files)} video.\n")

    stat = {"ok": 0, "skip": 0, "fail": 0, "plan": 0}
    for i, src in enumerate(files, 1):
        dst = out_path(src, root, outdir)
        print(f"[{i}/{len(files)}] {src.name}")
        if dst.exists() and not args.force and not args.dry_run:
            print(f"  = đã có {dst.name} — bỏ qua (dùng --force để convert lại)")
            stat["skip"] += 1
            continue
        try:
            stat[convert_file(ffmpeg, ffprobe, src, dst, args, args.dry_run)] += 1
        except Exception as ex:
            eprint(f"  LỖI: {ex}")
            stat["fail"] += 1

    print(f"\nHoàn tất: {stat['ok']} convert, {stat['skip']} bỏ qua, {stat['fail']} lỗi"
          + (f", {stat['plan']} trong kế hoạch (dry-run)" if args.dry_run else ""))


if __name__ == "__main__":
    main()
