# Omni Player Cloud Backend — Design

Ngày: 2026-09-13 · Trạng thái: chờ duyệt
Yêu cầu gốc: "ứng dụng cloudflare r2 và cloudflare worker, zerotrust authorization authentication, ratelimit, firewall cho video player này"

## 1. Mục tiêu & phạm vi

**Mục tiêu:** omni-player xem được video từ cloud (R2) ở bất kỳ thiết bị nào, AI proxy qua Worker (giấu API key, hết CORS NVIDIA NIM), cache AI + vị trí xem dở đồng bộ qua KV — tất cả sau Cloudflare Access (email OTP + Google), thêm rate limit + WAF làm lớp vỏ.

**Nguyên tắc bất di bất dịch:**
- Local-first là chế độ mặc định: mở `index.html` từ máy → chạy y hệt hôm nay, không gọi mạng.
- Cloud là opt-in: chỉ bật khi app được phục vụ từ Worker.
- 1 người dùng (chủ app). Đơn giản hoá mọi thứ theo đó.

**Ngoài phạm vi (chủ đích):** upload UI trên web; phụ đề lên R2 (vẫn chọn `.srt` từ máy lúc xem); multi-user; billing/usage dashboard; chuyển mã AI sang Worker (fallback chain vẫn ở browser).

## 2. Kiến trúc (Approach A — đã duyệt)

```
Browser ── Access (Email OTP + Google, allowlist 1 email) ──► Worker player.<domain>
            └─ trước Worker: WAF custom rules + Rate Limiting (edge)
             ├─ GET /                → static assets (index.html)
             ├─ GET /api/me          → email từ Access JWT
             ├─ GET /api/videos      → liệt kê R2
             ├─ GET|HEAD /v/<file>   → stream R2 (Range/206)
             ├─ POST /api/ai         → proxy AI (key ở secrets, SSE passthrough)
             ├─ GET|PUT /api/cache/<key> → KV (cache AI)
             └─ GET|PUT /api/progress    → KV (vị trí xem + lịch sử)
```

- App deploy **cùng Worker** (Workers Static Assets) → same-origin: cookie Access tự kèm mọi request (`<video src>` lẫn `fetch`), không CORS, không token trên client.
- `workers_dev = false` — chỉ có 1 lối vào là custom domain đã qua Access.

**Cấu trúc thư mục mới:**

```
cloud/
  wrangler.jsonc          # R2 bucket, KV namespace, assets, ratelimit binding
  src/worker.ts           # router chính + error handling
  src/auth.ts             # verify Access JWT (WebCrypto ES256, JWKS cache 5')
  src/video.ts            # Range parse → R2 get → 206
  src/ai.ts               # provider map (url + secret) → forward + stream
  src/data.ts             # KV read/write + throttle helpers
  test/worker.test.ts     # vitest-pool-workers
  public/index.html       # copy từ repo root lúc deploy (không sửa tay)
  upload.py               # upload video lên R2 bằng S3 API + SigV4 (Python stdlib, multipart)
  README.md               # setup guide: dashboard Access/WAF/rate limit, secrets, domain
```

## 3. Worker & Zero Trust auth (đã duyệt — tóm tắt + chi tiết mới)

- Access application che toàn bộ hostname. Policy: `include` 1 email; login methods: **Email OTP + Google OAuth**.
- Session duration: 30 ngày (login hiếm, đủ tiện).
- Worker **verify Access JWT** (`Cf-Access-Jwt-Assertion`) — defense-in-depth: fetch JWKS từ `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cache KV 5 phút), verify ES256 bằng WebCrypto, khớp `aud` = AUD tag của Access app (biến `ACCESS_TEAM`, `ACCESS_AUD`). Sai/hết → 401. Lý do verify chứ không tin edge mù quáng: nếu sau này Access bị gỡ/misconfig, Worker vẫn tự chặn.
- Dev mode (`wrangler dev`): biến `SKIP_AUTH=1` (chỉ trong `.dev.vars`, không bao giờ deploy) → bỏ verify.

## 4. App thay đổi trong `index.html` (đã duyệt — chi tiết hoá)

**Phát hiện cloud mode:** lúc boot `fetch('/api/me', {signal: timeout 3s})` → OK + JSON = `state.cloud = {email}`. `file://`/localhost/Vercel → fetch fail → local mode, mọi tính năng cloud tắt im lặng.

**Nguồn video cloud:**
- Nút **☁** cạnh nút Video (chỉ hiện khi `state.cloud`) → panel liệt kê `GET /api/videos` (tên + dung lượng, sort tên) → click phát.
- `video.src = '/v/' + encodeURIComponent(name)`. Range request do browser tự gửi; Worker trả 206 → tua hoạt động chuẩn.
- **Audit bắt buộc:** mọi chỗ dùng `state.videoFile` (File API thật: `.stream()`, `.text()`, `name`, `size`, `lastModified`) phải đổi sang `state.source = {kind:'local'|'cloud', file?, name, size}`. Các chỗ đọc nội dung file (subtitle merge…) chỉ hợp lệ với `kind:'local'`; cloud video luôn ghép phụ đề từ file máy chọn tay như cũ.
- `resumeKey` = `name + ':' + size` (giống cơ chế khớp local hiện tại) → cache AI/vị trí ăn cho cả local & cloud bản cùng file.

**AI — provider Cloud Proxy đầu chain:**
- Refactor: tách body-builder khỏi 2 hàm gọi — `buildOpenAIReq(p, cue, idx)` và `buildGeminiReq(p, cue, idx)` trả `{url|path, body}`. `aiCallOpenAIP`/`aiCallGeminiP` giữ nguyên hành vi local (fetch thẳng), gọi builder mới.
- `aiCallCloudP(p, cue, idx, signal, onDelta)`: `POST /api/ai` body `{provider: p.type, model: p.model, body}` → Worker tra bảng provider (openai/openrouter/deepseek/nim/gemini + custom) → gắn key từ secrets → gọi upstream → **pipe SSE về nguyên trạng**. Parse SSE phía browser tái dùng code `onDelta` hiện có.
- Chèn Cloud Proxy vào **đầu** `state.ai.chain` khi cloud mode (tôn trọng thứ tự người dùng cấu hình: Cloud luôn trước; nếu người dùng tắt provider nào trong ⚙ thì vẫn tắt).
- Upstream lỗi → Worker trả đúng status + body lỗi → app coi như provider fail → fallback kế tiếp như hiện tại. Không đổi format prompt → **cache AI cũ còn dùng được**.

**Sync KV (chỉ khi cloud mode):**
- Cache AI: ghi song song — local localStorage (fast-path, giữ nguyên `op:ai2:cache:`) + debounce 5s `PUT /api/cache/<resumeKey>`. Đọc: local miss → `GET /api/cache/<resumeKey>` → ghi ngược local. Nút 🔄 bỏ cache vẫn chỉ clear local + gọi AI lại (server cache ghi đè bởi kết quả mới).
- Vị trí xem: `sessionSave()` (đang ghi localStorage mỗi lần) thêm `PUT /api/progress` **throttle ≥30s** + ngay lúc pause/seek/`visibilitychange`/`pagehide`. KV free 1k ghi/ngày — throttle này giữ dưới ~150/session dài. Payload: `{name, size, t, d, at}` keyed `name:size`.
- "Tiếp tục xem": merge danh sách local (`op:history:v1`) + `GET /api/progress` theo `at` mới nhất, dedupe theo `name:size`. File local-only vẫn hiện như cũ.
- Offline giữa chừng: mọi PUT bọc try/catch im lặng + flag `cloudDegraded` (dừng retry tới lần boot sau) — app local không bao giờ lỗi vì cloud.

**Không đổi:** phát file local, phụ đề, AI prompt/format, phím tắt, UI, gestures, settings schema.

## 5. Upload (đã duyệt hướng: script từ máy, không UI)

- `cloud/upload.py` — Python thuần (stdlib, không bắt buộc dependency):
  - Gọi thẳng S3 REST API của R2 (`https://<accountid>.r2.cloudflarestorage.com/omni-videos/...`) tự ký **SigV4** bằng stdlib (`hmac`/`hashlib`).
  - **Multipart upload cho file lớn** (>64MB mặc định, part 5MB–5GB, tối đa 10k parts): Create → PUT từng part (retry 3 lần) → Complete; lỗi/Ctrl-C → Abort để không rác part. File nhỏ → PUT đơn.
  - Credentials qua env `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (tạo trong R2 → Manage API Tokens). Không lưu credential trong repo.
  - Skip file đã có cùng size (HEAD trước), `--force` ghi đè; đệ quy thư mục; `--dry-run` in kế hoạch; progress per-part.
  - Content-type map: mp4/m4v → `video/mp4`, webm → `video/webm`, mkv → `video/x-matroska`, else `application/octet-stream`.
  - Bucket **không public** (`allowPublicAccess` bỏ trống/false) — chỉ Worker binding đọc được.
- R2 free tier đủ dùng: 10GB storage, egress 0₫, Class B ops 10M/tháng (mỗi range request = 1 op Class B).
- Quy ước đặt file: giữ nguyên tên có dấu — Worker encode/decode UTF-8 qua `encodeURIComponent`.

## 5b. HLS streaming (chủ đích: HLS object-per-segment, hls_time 10s)

Video trên cloud phát bằng **HLS**: upload script tự transcode + chia segment bằng ffmpeg **trước khi** lên R2.

**Lý do HLS thay vì range-request file gốc:** segment `.ts` nhỏ là object bất biến → CDN edge cache `immutable` vĩnh viễn, tua lại = hit cache không đụng R2; Worker delivery gần như 0 CPU; chuẩn HLS phát được mọi browser Safari native + hls.js elsewhere. Range-request trên file gốc vẫn giữ cho file **không convert được** (fallback).

**Pipeline transcode (upload.py gọi ffmpeg):**
- Input mp4/webm/mkv → ffmpeg `-c:v libx264 -preset veryfast -crf 21 -c:a aac -b:a 160k -hls_time 10 -hls_playlist_type vod -hls_segment_filename 'seg%d.ts' index.m3u8` (tham số `-hls_time 10` = **segment 10 giây theo yêu cầu**; ffmpeg tự chèn split tại keyframe gần nhất ≥10s).
- **Keep-original branch:** video đã H.264 8-bit + AAC → `-c copy` (không re-encode, chỉ cắt segment) — giống nguyên tắc tools/convert-for-web.py hiện có.
- Output thư mục `<basename>/`: `index.m3u8` + `seg0.ts…segN.ts` (+ `master.m3u8` 1 rendition, giữ chỗ multi-bitrate tương lai).
- Upload R2: m3u8 → `application/vnd.apple.mpegurl`, .ts → `video/mp2t`. Key R2: `<prefix><basename>/index.m3u8`, `<prefix><basename>/seg7.ts`.
- File quá nhỏ (<30s / ffmpeg lỗi) → giữ nguyên đường range-request cũ (upload raw, không segment).

**Worker route mới:** `GET /hls/*` → như `/v/*` (R2 get, nhưng m3u8/.ts). m3u8 trả kèm `Cache-Control: public,max-age=60`; .ts trả `Cache-Control: public,max-age=31536000,immutable`. App `<video>` thay bằng **hls.js** (self-host 1 file JS trong cloud/public/, ~500KB) khi `file.cloud && Hls.isSupported()`; Safari native dùng src=m3u8 trực tiếp.

**Local mode KHÔNG đổi:** file local phát bằng blob như cũ, không HLS.

## 6. Rate limit + Firewall/WAF (mới — trình duyệt lần 1)

Tầng edge (dashboard, setup guide ghi từng bước):

1. **Rate Limiting (free 1 rule):** `http.request.uri.path contains "/"` trên hostname player — **60 request / 10s / IP → Block 60s**. Ngưỡng cao hơn mọi hành vi người thật (seek video burst ~10 req/s); chặn được flood trang login Access + Worker. 
2. **WAF custom rule (free 5 slot):** `(http.request.uri.path contains ".php") or (http.request.uri.path eq "/wp-admin") or (http.request.uri.path contains ".env")` → **Managed Challenge**. Lọc noise scanner phổ thông trước khi tới Access.
3. **Bot Fight Mode:** ON (free) — chặn bot cơ bản.
4. **Zone settings:** SSL/TLS = Full, Always Use HTTPS = ON.

Tầng Worker (code, defense-in-depth):

5. **Workers Rate Limiting binding** (beta, free) cho `POST /api/ai`: **30 req/phút/IP** — chốt chi phí AI ngay cả khi Access bị cấu hình sai. Trả 429 + `Retry-After`.
6. Giới hạn body `/api/ai` **≤ 64KB** (prompt ±5 câu ~ vài KB; chặn ai ném context khổng lồ), body `/api/progress` ≤ 64KB, `/api/cache/` ≤ 256KB.
7. Không set header CORS nào → cross-origin đọc bị browser chặn sẵn (same-origin design).

Thứ tự request thật: DDoS (CF tự động) → WAF custom → Rate limiting → Access login → Worker (JWT verify → ratelimit binding → handler).

## 7. Testing & verification

- **Unit (vitest + @cloudflare/vitest-pool-workers):** Range parse (đầu/giữa/đuôi/open-end/sai format → 416); router 401 khi JWT sai/thiếu (mock JWKS); `/api/ai` forward đúng url+key từng provider (mock fetch upstream) + 429 khi vượt ratelimit; KV cache/progress round-trip (miniflare KV); body-size guard.
- **Smoke thật (browser qua `browser.open`):** `wrangler dev` (SKIP_AUTH) → mở app → phát video từ R2, tua tới/lui (Range hoạt động), AI Cloud Proxy stream chữ hiện dần, KV cache: hỏi lại câu cũ = hit, progress: reload → "Tiếp tục xem" khớp vị trí.
- **E2E có Access:** sau khi cấu hình dashboard thật, login OTP → vào app → toàn bộ trên chạy lại qua domain thật. Cookie Access đúng hạn không bị hỏi lại.
- **Regression local:** mở `index.html` từ máy (`file://`) + `python3 -m http.server` → kiểm chứng mọi tính năng cũ không đổi (phát, phụ đề, AI local chain, cache, resume).

## 8. Chi phí & hạn chế

- Toàn bộ nằm free tier: Worker 100k req/ngày; R2 10GB + egress free; KV 100k đọc / 1k ghi /ngày; Access 50 users; WAF/RL theo mục 6. Một buổi xem phim (~500-1000 range req) phù hợp dễ dàng.
- Hạn chế chấp nhận: phụ đề cloud video phải chọn từ máy mỗi lần đổi thiết bị; KV chỉ là backup (local là nguồn thật); nếu vượt 1k ghi KV/ngày, progress sync tắt tự động trong ngày (local vẫn ghi).

## 9. Migration & rollback

- Deploy = `cloud/deploy.sh` (`cp index.html cloud/public/ && wrangler deploy`). Vercel giữ nguyên làm fallback local-first tới khi cloud ổn; không đụng gì bên đó.
- Rollback: `wrangler rollback` (Worker) — R2/KV dữ liệu không mất. Domain trỏ lại Vercel cũng được nếu cần khẩn.
