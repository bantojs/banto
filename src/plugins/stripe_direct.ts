/**
 * Stripe 決済（API キー方式）: 運営者自身の Stripe アカウントのシークレットキーを Workers Secret に置き、
 * そのアカウントで直接 Checkout を作る。Connect（OAuth）より設定が簡単で、1 デプロイ = 1 運営者のセルフホストでは
 * こちらを既定にする。鍵は DB に置かない（CLAUDE.md §1-5）。カード情報は Stripe Checkout で完結（§1-6）。
 * 複数ショップで入金先を分けたい場合だけ Connect（ショップ設定）を使う。
 */
import type { BundledPlugin } from "./types";

export const stripeDirect: BundledPlugin = {
  id: "stripe",
  manifest: {
    name: "Stripe 決済（カード）",
    version: "1.0.0",
    description: "クレジットカード決済を Stripe のホスト型決済ページで受け付けます。Stripe のシークレットキーと Webhook の署名シークレットを Secret に設定して有効にしてください。",
    events: [],
    settings: [],
  },
  requiredSecrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  webhook: {
    path: "/webhooks/stripe",
    events: ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.expired", "checkout.session.async_payment_failed"],
    where: "Stripe → 開発者 → Webhook → エンドポイントを追加。作成後に表示される署名シークレット（whsec_…）を STRIPE_WEBHOOK_SECRET に",
  },
  secretFormats: {
    STRIPE_SECRET_KEY: { pattern: /^(sk|rk)_(test|live)_/, hint: "sk_test_ または sk_live_ で始まるシークレットキー（Stripe → 開発者 → API キー）。whsec_ は Webhook の署名シークレットなので別の項目です" },
    STRIPE_WEBHOOK_SECRET: { pattern: /^whsec_/, hint: "whsec_ で始まる Webhook の署名シークレット（Stripe → 開発者 → Webhook → エンドポイント）" },
  },
};
