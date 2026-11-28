# Thông báo bên thứ ba

[简体中文](NOTICE.zh-CN.md) · [English](NOTICE.md) · **Tiếng Việt** · [Tài liệu](docs/README.md)

Mã nguồn của chính dự án dùng giấy phép MIT ở thư mục gốc. Mã, phông chữ, tài sản của bên thứ ba và mọi skill được nhập riêng giữ nguyên điều khoản gốc của chúng. Xem `third-party/manifest.json`, `client/THIRD_PARTY_NOTICES.md`, và bất kỳ LICENSE, UPSTREAM.md hoặc ADAPTATIONS.md riêng của từng thành phần.

Nguồn gốc của biểu tượng connector được ghi trong `client/assets/connector-brands/sources.json`. Giấy phép của một tài sản không đồng nghĩa với việc bên thứ ba chứng thực thương hiệu.

Các fixture prompt-settlement và tool-preview trong `client/tests/dsh-acp-settlement.test.cjs` giữ lại các trích đoạn từ `@openma/deepseek-harness-acp` 0.4.40/0.4.41. Copyright 2026 The @openma/deepseek-harness-acp authors. Các trích đoạn vẫn theo Apache-2.0; xem `third-party/licenses/deepseek-harness-acp-LICENSE.txt`. Bộ nạp tương thích của SoduWork và các kiểm thử xung quanh là mã của chính dự án.

Các neo tương thích trong `hub-backend/app/services/qwen_acp_outcome.mjs` giữ lại các trích đoạn Qwen Code 0.27.4 theo Apache-2.0 (Copyright 2025 Google LLC và Copyright 2025 Qwen); xem `third-party/licenses/qwen-code-LICENSE.txt`. Các neo Kimi Code 2.6.2 trong `hub-backend/app/services/kimi_acp_outcome.mjs` giữ lại các trích đoạn theo giấy phép MIT (Copyright (c) 2026 Moonshot AI); xem `third-party/licenses/kimi-code-LICENSE.txt`. Logic tương thích và các kiểm thử xung quanh của SoduWork là mã của chính dự án.

Các bản phát hành nhị phân cần các thông báo và mã nguồn tương ứng áp dụng được cho các thành phần thực tế được đóng gói. Các tài liệu còn thiếu được theo dõi trong `third-party/public-release.json`; một lần kiểm tra mã nguồn đạt không chứng nhận việc phân phối nhị phân.

Từ thư mục gốc:

```sh
node tools/check-third-party.cjs
```

Hoặc chạy `npm run check:licenses` từ `client/`. Các kiểm tra xác minh bằng chứng theo phiên bản cố định, hàm băm và tích hợp bản dựng. Đóng gói thu thập các giấy phép gốc cho các phụ thuộc runtime đã sao chép. Runner giữ lại metadata và giấy phép của Python đã cài; Hub bao gồm tài liệu của dự án và của bên thứ ba.

Xem [tài liệu phân phối](third-party/README.md) để biết phạm vi bao phủ và công việc còn lại.
