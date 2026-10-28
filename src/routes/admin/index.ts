import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { csrfGuard } from "./context";
import { design } from "./design";
import { designSettings } from "./design-settings";
import { setup } from "./setup";
import { login } from "./login";
import { mfa } from "./mfa";
import { dashboard } from "./dashboard";
import { shops } from "./shops";
import { products } from "./products";
import { stripe } from "./stripe";
import { orders } from "./orders";
import { hooks } from "./hooks";
import { plugins } from "./plugins";
import { lineMessaging } from "./line-messaging";
import { update } from "./update";
import { site } from "./site";
import { tokens } from "./tokens";
import { customers } from "./customers";
import { exportRoute } from "./export";
import { categories } from "./categories";
import { modules } from "./modules";
import { org } from "./org";
import { audit } from "./audit";
import { storesAdmin } from "../../modules/store-tryon/stores-admin";

/**
 * 管理画面（Hono SSR）。
 *   /admin           ダッシュボード（要ログイン）
 *   /admin/login     ログイン / ログアウト、/admin/mfa 運営者の二段階認証（0054）
 *   /admin/setup     セットアップウィザード（owner 未登録のあいだ）
 *   /admin/shops/:id ショップ設定、/admin/shops/:id/products 商品管理、/admin/shops/:id/orders 注文
 *   /admin/org      組織（メンバー・招待）、/admin/org/audit 監査ログ、/admin/invite 招待の受け入れ、/admin/stores 実店舗（組織の正本・スタッフの画面）
 *   /admin/shops/:id/stripe/* Stripe Connect の接続/解除、/admin/stripe/callback
 */
export const admin = new Hono<AppEnv>();

admin.use("*", csrfGuard);
admin.route("/setup", setup);
admin.route("/", login);
admin.route("/", mfa);
admin.route("/", dashboard);
admin.route("/", update);
admin.route("/", site);
admin.route("/", org);
admin.route("/", audit);
admin.route("/stores", storesAdmin);
admin.route("/shops", shops);
admin.route("/shops", products);
admin.route("/shops", categories);
admin.route("/shops", modules);
admin.route("/shops", orders);
admin.route("/shops", hooks);
admin.route("/shops", plugins);
admin.route("/shops", lineMessaging);
admin.route("/shops", tokens);
admin.route("/shops", design);
admin.route("/shops", designSettings);
admin.route("/shops", customers);
admin.route("/shops", exportRoute);
admin.route("/", stripe);
