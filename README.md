# Omni Player 🎬

Trình phát video **tĩnh 1 file** để xem phim + luyện tiếng Anh với phụ đề — transcript kiểu YouTube bên phải, tự dừng cuối câu, lặp đoạn A–B để shadowing.

**100% local-first:** video và file phụ đề chỉ được **đọc trực tiếp trong trình duyệt** từ máy bạn (qua File API + `blob:` URL). Không có server, không upload đi đâu cả.

### Nhớ toàn bộ trạng thái — reload thoải mái

- **"Tiếp tục xem"** trên màn hình chào: danh sách mọi file đã mở kèm vị trí + % + thời gian; bấm ▶ để xem tiếp.
- Trên **Chrome/Edge/Android Chrome**: app lưu `FileSystemHandle` vào IndexedDB — bấm ▶ là video **tự gắn lại khỏi chọn lại file** (duyệt 1 lần quyền đọc), phụ đề đi kèm cũng tự nạp. Reload/F5 không còn là mất trắng, và app bỏ cảnh báo thoát vì biết bạn quay lại được.
- **Safari/Firefox/iOS**: bấm ▶ mở picker, chọn đúng file là app **tự nhảy tới chỗ đang xem dở** (khớp theo tên + dung lượng + ngày sửa) và nhắc ghép phụ đề đã nhớ.
- Tốc độ, âm lượng, auto-pause, bước tua, ẩn/hiện phụ đề — tất cả tự lưu và tự khôi phục.

## Chạy ngay

Mở thẳng file `index.html` (double-click) — không cần cài gì cả. Hoặc chạy server local:

```bash
python3 -m http.server 8080
# rồi mở http://localhost:8080
```

## Cách dùng

1. Bấm **Video** (hoặc kéo–thả file video vào trang)
2. Bấm **Phụ đề** (hoặc kéo–thả file `.srt` / `.vtt`)
3. Học:
   - **Transcript** bên phải: click câu để nhảy, câu đang phát tự highlight + tự cuộn
   - **Tìm kiếm** trong phụ đề: highlight vàng + đếm kết quả, `Enter` nhảy tới match kế, `Shift+Enter` lùi lại, `Esc` xoá; nút **Aa** trong ô tìm kiếm bật phân biệt hoa/thường (mặc định không phân biệt)
   - **⟳** trên 1 dòng = lặp câu đó; **⟳ trên 2 dòng** = lặp đoạn A→B (xem vùng lặp trên progress bar)
   - Nút **Tự dừng mỗi câu** (phím `P`): player tự pause khi hết câu — bấm Space để nghe lại / sang câu mới
   - **Phụ đề 2** (trong transcript): thêm bản dịch song song — 2 dòng trong transcript + 2 lớp trên video, ghép tự động theo thời gian; nút ẩn/hiện hoặc gỡ bỏ
   - **⚙ Cài đặt**: đổi bước tua (mặc định 5s), nhảy tới thời điểm, đổi bảng mã phụ đề khi tiếng Việt lỗi font, và **giao diện phụ đề** — cỡ chữ, vị trí dọc, nền (không/mờ/đậm), màu chữ (trắng/vàng/xanh), kiểu font — xem trước live, tự lưu
   - **Cuộn chuột trên vùng video** để chỉnh âm lượng (HUD % hiện ngay); lăn chuột trên **progress bar** để tua

## 🤖 AI phân tích câu thoại (khung 6 mục)

Hover một câu trong transcript → bấm **✨** → video tự pause và AI phân tích câu đó theo **khung cố định 6 mục**, render ngay dưới dòng phụ đề (không rời mắt):

1. **Phiên âm IPA** (General American) — chỉ từ A2+, kèm nhãn CEFR
2. **Native Connected Speech** — nhược âm, nối âm, glottal stop [ʔ], nuốt /t/… kèm chuỗi `→ /IPA/`
3. **Phân tích ngữ pháp** — cấu trúc, thì, từng cụm
4. **Dịch nghĩa & từ vựng** + 2 bản dịch tiếng Việt tự nhiên
5. **Meaning in English (A2)**
6. **Bối cảnh** — AI đọc toàn bộ phụ đề để giải thích cảnh phim

**Cấu hình:** ⚙ Cài đặt → 🤖 AI: Provider (Gemini/OpenAI/OpenRouter/Custom OpenAI-compatible) + API key + model. Key chỉ lưu trong máy bạn, gọi thẳng tới provider — app không có server.

**Tiết kiệm chi phí:**
- Kết quả phân tích **cache 2 lớp** (RAM + localStorage theo từng file) — hỏi lại câu cũ = 0ms 0₫, sống qua reload
- **Gemini explicit context caching**: ngữ cảnh toàn phim "bơm" 1 lần/h giờ, các câu hỏi sau chỉ gửi ~1KB; hết hạn tự tạo lại
- OpenAI/OpenRouter: context cố định đầu request → tự hưởng automatic prompt caching
- Không muốn gửi cả phim? Đổi ngữ cảnh sang "±5 câu" trong ⚙

### Phím tắt

| Phím | Chức năng |
|---|---|
| `Space` / `K` | Phát / dừng |
| `←` `→` / `J` `L` | Tua ∓ bước tua (đổi được trong ⚙) |
| `↑` `↓` | Âm lượng |
| `,` `.` | Câu phụ đề trước / sau |
| `<` `>` | Tốc độ chậm / nhanh |
| `M` `F` `I` `C` | Mute · Fullscreen · PiP · ẩn phụ đề |
| `P` | Bật/tắt tự dừng cuối câu |
| `0–9` | Nhảy tới 0–90% |
| `?` | Bảng phím tắt |

Mobile: tap video = hiện/ẩn control · **double-tap trái/phải = tua ∓ bước tua** (giống YouTube app).

## Chạy trên điện thoại / tablet

Giao diện tự nhận diện: điện thoại dọc (video trên, transcript dưới), điện thoại ngang (video full màn, transcript trượt vào qua nút), tablet/desktop (song song kiểu YouTube). Trên iPhone nhớ bật chế độ xoay dọc không khoá để dùng landscape.

## Deploy

### GitHub Pages

1. Tạo repo mới trên GitHub
2. Upload `index.html` (hoặc `git push`)
3. **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**
4. Site chạy tại `https://<username>.github.io/<repo>/`

### Vercel

1. Vào [vercel.com/new](https://vercel.com/new) → import repo (hoặc chạy `npx vercel` trong thư mục này)
2. Không cần cấu hình gì — Framework Preset: **Other**, bấm Deploy

### Lưu ý codec

Trình duyệt chỉ phát được codec mà nó hỗ trợ:
- **MP4 (H.264/AAC), WebM**: chạy mọi nơi, kể cả iPhone.
- **MKV/HEVC**: Chrome/Edge desktop thường chạy được (tuỳ máy); **iOS Safari không hỗ trợ** → nếu video đen/báo lỗi, convert sang MP4: `ffmpeg -i in.mkv -c:v libx264 -c:a aac out.mp4`

### MKV: audio & phụ đề nhúng

File MKV tải torrent thường có **audio E-AC-3 (DDP5.1) / DTS** — Chrome (nhất là trên Linux) **không decode** được các codec này → hình chạy nhưng **im lặng**. Ngoài ra, **phụ đề nhúng trong MKV web không đọc được** (browser không expose subtitle track của Matroska).

Cách xử lý 1 lần bằng ffmpeg (video giữ nguyên, không re-encode — chỉ vài phút):

```bash
# 1. Extract phụ đề nhúng ra .srt (xem số track: ffprobe -i file.mkv)
ffmpeg -i "video.mkv" -map 0:2 "video.srt"

# 2. Remux audio sang AAC (video copy nguyên bản)
ffmpeg -i "video.mkv" -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 320k -movflags +faststart "video.mp4"
```

Sau đó kéo–thả cặp `.mp4` + `.srt` vào app là có đủ tiếng + phụ đề. App cũng sẽ **tự cảnh báo** khi phát file mà browser decode không ra audio.

### Script convert tự động cả thư viện

[`tools/convert-for-web.py`](tools/convert-for-web.py) làm hết các bước trên cho cả thư viện video (đệ quy), chạy trên Windows / Linux / macOS / Android (Termux) — chỉ cần có ffmpeg trong PATH:

```bash
python tools/convert-for-web.py "D:\\Phim"            # convert cả thư mục, xuất .mp4 cạnh file gốc
python tools/convert-for-web.py "Phim" --out ./web    # xuất sang thư mục khác (giữ cây thư mục)
python tools/convert-for-web.py Phim --dry-run        # xem kế hoạch trước khi convert
```

Nguyên tắc giữ chất lượng: video đã là H.264 8-bit → **stream copy nguyên vẹn 100%** (chỉ đổi container); HEVC/VP9/AV1/10-bit → re-encode H.264 CRF 19; audio → AAC; phụ đề text nhúng → extract thành `.srt` cạnh file (đặt tên theo ngôn ngữ). File đã hợp lệ sẽ tự bỏ qua — chạy lại nhiều lần an toàn.

## Vì sao file không bị "upload"?

Site tĩnh không có backend. Khi bạn chọn file, trình duyệt tạo một `blob:` URL — một tham chiếu đọc-only tới file trên ổ đĩa của bạn, chỉ tồn tại trong tab hiện tại. Không một byte nào của video/phụ đề rời khỏi máy. Vị trí xem dở được lưu trong `localStorage` của chính trình duyệt bạn.
