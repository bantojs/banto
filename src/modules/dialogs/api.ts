/**
 * お店の画面のダイアログを、ヘッドレスのサイトと貼れるタグ（embed）で出すための公開の入口（段階 3、docs/dialogs.md「ヘッドレスと貼れるタグ」）。
 *   GET /api/shops/<ショップ>/dialogs?kind=product&product_id=…&category_id=…&tags=a,b
 * どのページかは呼ぶ側が kind と商品・記事の手がかりで渡す（Banto の画面ではないので、パスから決められない）。だれにはサーバーが決める:
 * 会員トークン（Authorization: Bearer）があれば会員（会員の条件はトークンの独自項目で判定）、無ければゲスト。壊れたトークンは 401。
 * 返すのは中身だけ（だれに・どのページは決め済み）。きっかけと回数は呼ぶ側（貼れるタグは Banto のスクリプト）が守る。DB には問い合わせない（ショップ行と一緒のキャッシュ）
 */
import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { publicShop, type Ctx } from "../../routes/common";
import { moduleEnabled } from "../registry";
import { memberFromRequest } from "../../routes/api/members";
import { shopAudiences } from "../../routes/audience-render";
import { audienceShow } from "../../content/audience-blocks";
import { GUEST } from "../../members/audience";
import { DIALOGS_MODULE, DIALOG_PAGE_KINDS, dialogsFor, forBrowser, type DialogPage } from "./dialogs";

export const dialogsApi = new Hono<AppEnv>();

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

dialogsApi.get("/shops/:shop/dialogs", async (c: Ctx) => {
  const p = await publicShop(c);
  if (p instanceof Response) return p;
  const { shop } = p;
  if (!moduleEnabled(shop.settings, DIALOGS_MODULE)) return c.json({ error: "not_found" }, 404);
  const kind = c.req.query("kind") ?? "";
  if (!(DIALOG_PAGE_KINDS as readonly string[]).includes(kind) || kind === "all") return c.json({ error: "invalid_request", field: "kind" }, 400);
  const productId = c.req.query("product_id");
  const categoryId = c.req.query("category_id");
  const tags = (c.req.query("tags") ?? "").split(",").map((x) => x.trim()).filter((x) => x && x.length <= 40).slice(0, 20);
  const page: DialogPage = { kind: kind as DialogPage["kind"] };
  if (kind === "product") page.product = { id: productId && ID.test(productId) ? productId : "", category_id: categoryId && ID.test(categoryId) ? categoryId : null, tags };
  if (kind === "article") page.article = { tags };
  const who = await memberFromRequest(c, shop);
  if (!who.ok) return c.json({ error: "invalid_member_token" }, 401);
  const list = shop.dialogs ?? [];
  const needsAudience = list.some((d) => d.audience === "audience");
  const ok = needsAudience ? audienceShow(await shopAudiences(c, shop), who.member ? { member: true, attrs: who.member.attrs ?? {} } : GUEST) : () => false;
  const items = dialogsFor(list, page, { member: Boolean(who.member), audienceOk: ok }).map(forBrowser);
  return c.json({ items }, 200, { "Cache-Control": who.member ? "private, no-store" : "public, max-age=30", Vary: "Authorization" });
});
