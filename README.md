# Cầu Lông Cup 2026 — Scoreboard (Cloudflare Worker)

Bảng điểm trực tiếp cho giải cầu lông 8 đội loại trực tiếp, tự host trên Cloudflare
Workers + Durable Objects. Không cần server riêng, không cần cơ sở dữ liệu ngoài —
toàn bộ trạng thái (tên đội, điểm số, ai thắng ai) được lưu trong một Durable Object
dùng SQLite nhúng, và đồng bộ real-time tới mọi người xem qua WebSocket.

## Vì sao cần bản này thay vì bản Claude Artifact

Bản trước chạy trong Claude chỉ hoạt động khi mở trong claude.ai (dùng tính năng lưu
dữ liệu riêng của Claude). Bản này là mã nguồn độc lập, host ở domain riêng của bạn,
ai có link cũng dùng được mà không cần tài khoản Claude.

## Cấu trúc project

```
wrangler.jsonc      cấu hình Worker, Durable Object, static assets
package.json
src/worker.js        Worker + Durable Object "Tournament" (API /ws, logic tính điểm)
public/index.html    giao diện bảng điểm (tự chứa, không phụ thuộc thư viện ngoài)
```

## Cài đặt & triển khai

Yêu cầu: Node.js 18+, một tài khoản Cloudflare miễn phí (https://dash.cloudflare.com/sign-up).

```bash
npm install
npx wrangler login       # mở trình duyệt để đăng nhập tài khoản Cloudflare
npm run dev               # chạy thử ở http://localhost:8787
npm run deploy             # triển khai thật, trả về URL dạng
                            # https://cau-long-cup-2026.<tên-bạn>.workers.dev
```

Muốn gắn domain riêng (ví dụ `diem.congty.vn`): vào Cloudflare Dashboard → Workers &
Pages → chọn worker `cau-long-cup-2026` → tab Settings → Triggers → Add Custom Domain.
Domain đó phải đã trỏ DNS qua Cloudflare.

## Cách dùng

- Mở URL worker để vào bảng điều khiển: bấm trực tiếp vào tên đội để sửa (có icon
  bút chì), dùng nút +/− để cộng trừ điểm.
- Luật tự động: mỗi trận tối đa 3 set, thắng 2 set là thắng trận. Mỗi set tới 15
  điểm và cách biệt tối thiểu 2; chạm 21 điểm (điểm trần) là thắng set. Đổi luật bằng
  3 hằng số `SET_POINTS`, `SET_CAP`, `SETS_TO_WIN` ở đầu `src/worker.js` và ở đầu
  script trong `public/index.html` (phải sửa cả hai nơi cho khớp). Đội thắng tự động
  được điền vào đúng vị trí ở vòng kế tiếp.
- Mỗi thẻ trận hiển thị số set đã thắng, tỷ số từng set và set đang đấu. Nút +/−
  cộng/trừ điểm trong set hiện tại.
- Thêm `?view=1` vào cuối URL (ví dụ `.../?view=1`) để có bản **chỉ xem**, không có
  nút bấm — dùng cho màn hình chiếu công khai ở khu vực thi đấu.
- Nhiều người có thể mở cùng lúc trên nhiều thiết bị (mỗi sân một điện thoại); điểm
  cập nhật real-time cho tất cả qua WebSocket, xử lý tuần tự trong Durable Object nên
  không bị ghi đè lẫn nhau khi hai sân bấm cùng lúc.
- "↶ Hoàn tác" gỡ điểm vừa ghi gần nhất (kể cả điểm quyết định trận — kết quả đã
  chuyển sang vòng sau sẽ được gỡ theo). "Đấu lại" xoá toàn bộ điểm của trận (bấm 2
  lần để xác nhận). Nếu trận kế tiếp đã bắt đầu thì không cho sửa trận trước nó.
- Khung giờ dự kiến (13:30–15:30, mỗi lượt 30 phút, 2 sân song song): Tứ kết
  13:30–14:30, Bán kết 14:30–15:00, Chung kết 15:00–15:30. Chỉ là nhãn hiển thị, sửa
  trong `SEED_MATCHES` rồi deploy (tự đồng bộ vào dữ liệu đang chạy).

## Nâng cấp từ bản luật cũ (1 set 21 điểm)

Lần deploy đầu với bản này, dữ liệu điểm cũ bị xoá về 0 (tên đội đã nhập được giữ
nguyên, các ô tên ở bán kết/chung kết do kết quả cũ tự điền sẽ bị xoá).

## Chi phí

Toàn bộ nằm trong gói Cloudflare Workers Free: 100.000 request/ngày, Durable Object
(SQLite) 100.000 request/ngày và 13.000 GB-s/ngày — dư sức cho một giải đấu nội bộ vài
tiếng. Không cần nhập thẻ thanh toán để deploy ở mức này.

## Tuỳ biến

- Đổi tên giải, luật tính điểm, màu sắc: sửa trực tiếp trong `public/index.html`
  (phần `<style>` ở đầu file và đoạn text trong `<header>`).
- Đổi số đội / vòng đấu: sửa mảng `SEED_MATCHES` và sơ đồ `nextMatch`/`nextSlot`
  trong `src/worker.js`, sau đó deploy lại — lưu ý dữ liệu cũ trong Durable Object
  sẽ không tự xoá, nếu muốn làm lại từ đầu cho giải mới, đổi tên trong dòng
  `env.TOURNAMENT.idFromName("main")` sang một chuỗi khác (ví dụ "giai-2027") để
  tạo một Durable Object mới, trắng dữ liệu.
