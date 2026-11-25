/**
 * お知らせの受け取り方（0176、メンテナの決定 2026-11-25、docs/line.md §2）。
 * LINE と結びついた会員が「メールと LINE」（all、既定）か「LINE だけ」（line）を選ぶ。選ぶのは本人だけ（会員ページ・ヘッドレス）。
 * 効くか（LINE と結びつき、ショップが「LINE で購入者に知らせる」を使いその出来事を受け取る）は hooks を積むときに DB が 1 回だけ決め、
 * payload に notice_line_only を書く。同梱の「メール通知」は印のある知らせでお客様あてを送らない
 */
export const NOTICE_CHANNEL_MIGRATION = "0176_notice_channel";
