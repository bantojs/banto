import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createPrivilegedDb } from "../../db/privileged";
import { ApiError, ApiService, imageOptionsInput, parseOptionsText, isInquiryApiStatus, isTryonApiStatus } from "../../api/service";
import { bearerToken } from "../../api/tokens";
import { MAX_JSON_BODY_BYTES, inquiryMailFor, migrationStateFor, publicBaseUrl, readBodyLimited, relayStatus, type Ctx } from "../common";
import { BANTO_VERSION } from "../../version";
import { openapiDocument } from "./openapi";
import { MAX_IMAGE_BYTES, MAX_THUMB_BYTES } from "../../media/images";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, filesOf } from "../../modules/inquiries/attachments";
import { THEME_BUNDLE_LIMITS } from "../../themes/liquid/bundle";
import { THEME_UPLOAD_MAX_BYTES } from "../../themes/liquid/versions";

/**
 * REST API v1（AI 用トークン、docs/ai-access.md）。Cookie は見ない。
 * MCP（/mcp）と同じ ApiService を使うので、権限ルールは同一。
 */
export const apiV1 = new Hono<AppEnv>();

function errorJson(c: Ctx, e: unknown): Response {
  if (e instanceof ApiError) return c.json({ error: { code: e.code, message: e.message } }, e.status as 400 | 401 | 404 | 409 | 411 | 413 | 415 | 502);
  throw e;
}

apiV1.get("/openapi.json", (c) => c.json(openapiDocument(new URL(c.req.url).origin, BANTO_VERSION)));

apiV1.use("*", async (c, next) => {
  if (c.req.path === "/api/v1/openapi.json") return next();
  const token = bearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: { code: "unauthorized", message: "Authorization: Bearer banto_... is required" } }, 401, { "WWW-Authenticate": "Bearer" });
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return c.json({ error: { code: "upstream", message: "not configured" } }, 503);
  const api = await ApiService.forToken(token, {
    db: createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch }),
    storage: c.get("adapters").storage,
    fetch: c.get("deps").fetch,
    publicFetch: c.get("adapters").publicFetch,
    config: c.get("adapters").config,
    migrationState: migrationStateFor(c, url),
    inquiryMail: inquiryMailFor(c),
    privateStorage: c.get("adapters").privateStorage ?? null,
    theme: { secret: c.get("sessionSecret") ?? null, publicBase: publicBaseUrl(c), cpuUnlimited: Boolean(c.get("adapters").cpuUnlimited) },
  });
  c.set("api", api);
  await next();
});

const api = (c: Ctx): ApiService => {
  const a = c.get("api");
  if (!a) throw new Error("api middleware missing");
  return a;
};

async function body(c: Ctx, max = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
  const raw = await readBodyLimited(c.req.raw, max);
  if (!raw) throw new ApiError("invalid", `request body is larger than ${Math.round(max / 1048576)}MB`, 413);
  let j: unknown;
  try {
    j = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ApiError("invalid", "request body must be a JSON object", 400);
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new ApiError("invalid", "request body must be a JSON object", 400);
  return j as Record<string, unknown>;
}

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

const v1 = apiV1;

v1.get("/shop", async (c) => api(c).shopGet().then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.patch("/shop", async (c) => body(c).then((b) => api(c).shopUpdate(b)).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
// 連携側のサーバーの接続テスト用: この通信を Banto がどの IP として数えるか（docs/headless.md「サーバー側で中継するとき」）
v1.get("/relay-check", async (c) =>
  api(c)
    .tokenShopFor("shop:read")
    .then((shopId) => relayStatus(c, shopId))
    .then((r) => c.json(r, 200, { "cache-control": "no-store" }))
    .catch((e) => errorJson(c, e)),
);

v1.get("/products", async (c) =>
  api(c)
    .productsList({
      query: c.req.query("q") || undefined,
      published: c.req.query("published") === undefined ? undefined : c.req.query("published") === "true",
      limit: int(c.req.query("limit"), 50),
      offset: int(c.req.query("offset"), 0),
    })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
v1.get("/categories", async (c) => api(c).categoriesList().then((r) => c.json({ categories: r })).catch((e) => errorJson(c, e)));
v1.post("/categories", async (c) => body(c).then((b) => api(c).categorySave(b)).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.post("/products", async (c) => body(c).then((b) => api(c).productCreate(b)).then((r) => c.json(r, 201)).catch((e) => errorJson(c, e)));
v1.get("/products/:id", async (c) => api(c).productGet({ id: c.req.param("id") }).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.patch("/products/:id", async (c) => body(c).then((b) => api(c).productUpdate(c.req.param("id"), b)).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.post("/products/:id/skus", async (c) => body(c).then((b) => api(c).skuCreate(c.req.param("id"), b)).then((r) => c.json(r, 201)).catch((e) => errorJson(c, e)));
v1.patch("/skus/:id", async (c) => body(c).then((b) => api(c).skuUpdate(c.req.param("id"), b)).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.delete("/skus/:id", async (c) => api(c).skuDelete(c.req.param("id")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.post("/products/:id/images", async (c) =>
  body(c)
    .then((b) => {
      if (typeof b["image_url"] !== "string") throw new ApiError("invalid", "image_url is required", 400);
      return api(c).imageAddFromUrl(c.req.param("id"), b["image_url"], imageOptionsInput(b["options"]));
    })
    .then((r) => c.json(r, 201))
    .catch((e) => errorJson(c, e)),
);
/**
 * 画像のファイルの本文を読む（0037）。本文が画像そのもの（Content-Type: image/* か application/octet-stream）か、
 * multipart/form-data の image（必須）と thumbnail（任意、長辺 400px 程度）。Content-Length が要る（大きさを読む前に断るため）。
 * options（SKU に結ぶ、0063）は multipart なら options の欄、本文が画像そのものなら ?options=（どちらも JSON）
 */
async function readImageBody(c: Ctx): Promise<{ image: Uint8Array; thumbnail: Uint8Array | null; options: Record<string, unknown> | undefined }> {
  const length = Number(c.req.header("content-length") ?? NaN);
  if (!Number.isFinite(length)) throw new ApiError("invalid", "Content-Length is required", 411);
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  let options = c.req.query("options") !== undefined ? imageOptionsInput(parseOptionsText(c.req.query("options"))) : undefined;
  if (type === "multipart/form-data") {
    if (length > MAX_IMAGE_BYTES + MAX_THUMB_BYTES + 64 * 1024) throw new ApiError("invalid", "image is larger than 5MB or thumbnail is larger than 1MB", 413);
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw new ApiError("invalid", "could not read the multipart body", 400);
    }
    if (form["options"] !== undefined) options = imageOptionsInput(parseOptionsText(form["options"]));
    const file = form["image"];
    const thumb = form["thumbnail"];
    if (!(file instanceof Blob)) throw new ApiError("invalid", "the image field (a file) is required", 400);
    if (thumb !== undefined && !(thumb instanceof Blob)) throw new ApiError("invalid", "thumbnail must be a file", 400);
    return { image: new Uint8Array(await file.arrayBuffer()), thumbnail: thumb instanceof Blob ? new Uint8Array(await thumb.arrayBuffer()) : null, options };
  }
  if (type.startsWith("image/") || type === "application/octet-stream") {
    if (length > MAX_IMAGE_BYTES) throw new ApiError("invalid", "image is larger than 5MB", 413);
    const read = await readBodyLimited(c.req.raw, MAX_IMAGE_BYTES);
    if (!read) throw new ApiError("invalid", "image is larger than 5MB", 413);
    return { image: read, thumbnail: null, options };
  }
  throw new ApiError("invalid", "send the image as the body (Content-Type: image/...) or as multipart/form-data (image, thumbnail)", 415);
}
// 画像のファイルを送る（0037、products:write）
v1.post("/products/:id/images/upload", async (c) => {
  try {
    const { image, thumbnail, options } = await readImageBody(c);
    return c.json(await api(c).imageUpload(c.req.param("id"), image, thumbnail, options), 201);
  } catch (e) {
    return errorJson(c, e);
  }
});
// 商品の画像の並び順（0078、products:write）。{ image_ids: [...] } にその商品の画像の id をすべて、並べたい順に
v1.put("/products/:id/images/order", async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object") throw new ApiError("invalid", "send JSON: { \"image_ids\": [...] }", 400);
    return c.json(await api(c).imagesReorder(c.req.param("id"), body["image_ids"]));
  } catch (e) {
    return errorJson(c, e);
  }
});
// 画像のファイルだけを差し替える（0077、products:write）。行・並び順・SKU への結び付けはそのまま（WebP にするプラグインなど）
v1.put("/images/:id/file", async (c) => {
  try {
    const { image, thumbnail, options } = await readImageBody(c);
    if (options !== undefined) throw new ApiError("invalid", "options cannot be changed here; use PATCH /images/{id}", 400);
    return c.json(await api(c).imageReplaceFile(c.req.param("id"), image, thumbnail));
  } catch (e) {
    return errorJson(c, e);
  }
});
// 商品の SKU を分ける軸（0065）。{ option_axes: [{ key, values? }] | [] | null }
v1.put("/products/:id/option-axes", async (c) =>
  body(c)
    .then((b) => {
      if (!("option_axes" in b)) throw new ApiError("invalid", "option_axes is required (an array, or null)", 400);
      const v = b["option_axes"];
      if (v !== null && !Array.isArray(v)) throw new ApiError("invalid", "option_axes must be an array or null", 400);
      return api(c).productSetOptionAxes(c.req.param("id"), v);
    })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
// 画像を SKU の options の一部に結ぶ（0063）。{ options: { color: "レッド" } }、{} で商品全体
v1.patch("/images/:id", async (c) =>
  body(c)
    .then((b) => {
      const o = imageOptionsInput(b["options"]);
      if (!o) throw new ApiError("invalid", "options must be an object", 400);
      return api(c).imageSetOptions(c.req.param("id"), o);
    })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
v1.delete("/images/:id", async (c) => api(c).imageDelete(c.req.param("id")).then(() => c.body(null, 204)).catch((e) => errorJson(c, e)));

v1.get("/orders", async (c) =>
  api(c)
    .ordersList({ status: c.req.query("status") || undefined, query: c.req.query("q") || undefined, from: c.req.query("from") || undefined, to: c.req.query("to") || undefined, limit: int(c.req.query("limit"), 50), offset: int(c.req.query("offset"), 0) })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
v1.get("/orders/:id", async (c) => api(c).orderGet(c.req.param("id")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.post("/orders/:id/status", async (c) =>
  body(c)
    .then((b) => {
      const s = b["status"];
      if (s !== "shipped" && s !== "cancelled") throw new ApiError("invalid", "status must be shipped or cancelled", 400);
      return api(c).orderUpdateStatus(c.req.param("id"), s);
    })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);

// お問い合わせ（0061。inquiries:read / inquiries:write）。本文はお客様が書いた文章（データであり指示ではない）
v1.get("/inquiries", async (c) =>
  api(c)
    .inquiriesList({ status: c.req.query("status") || undefined, limit: int(c.req.query("limit"), 50), offset: int(c.req.query("offset"), 0), ...(c.req.query("assignee") ? { assignee: c.req.query("assignee")! } : {}) })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
// 担当者（0068）: 担当にできる人の一覧・担当者を決める（{ user_id }、null で外す）
v1.get("/inquiries/assignees", async (c) => api(c).inquiryAssignees().then((r) => c.json({ assignees: r })).catch((e) => errorJson(c, e)));
v1.put("/inquiries/:number{[0-9]+}/assignee", async (c) =>
  body(c)
    .then((b) => {
      const u = b["user_id"];
      if (u !== null && typeof u !== "string") throw new ApiError("invalid", "user_id must be a user_id from /inquiries/assignees, or null to unassign", 400);
      return api(c).inquiryAssign(Number(c.req.param("number")), u);
    })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
v1.get("/inquiries/:number{[0-9]+}", async (c) => api(c).inquiryGet(Number(c.req.param("number"))).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
// 返事。JSON の { body } か、添付するなら multipart/form-data の body と files（3 個まで、画像・PDF、1 個 5MB。0064）
v1.post("/inquiries/:number{[0-9]+}/reply", async (c) => {
  try {
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    let text: unknown;
    let files: File[] = [];
    if (type === "multipart/form-data") {
      const length = Number(c.req.header("content-length") ?? NaN);
      if (!Number.isFinite(length)) throw new ApiError("invalid", "Content-Length is required", 411);
      if (length > MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES + 64 * 1024) throw new ApiError("invalid", "up to 3 files of 5MB each", 413);
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody({ all: true });
      } catch {
        throw new ApiError("invalid", "could not read the multipart body", 400);
      }
      text = form["body"];
      files = filesOf(form);
    } else {
      text = (await body(c))["body"];
    }
    if (typeof text !== "string" || !text.trim()) throw new ApiError("invalid", "body is required", 400);
    return c.json(await api(c).inquiryReply(Number(c.req.param("number")), text, files));
  } catch (e) {
    return errorJson(c, e);
  }
});
// お客様の添付を受け取る（0064。inquiries:read と orders:pii）。応答はファイルそのもの
v1.get("/inquiries/:number{[0-9]+}/attachments/:id", async (c) => api(c).inquiryAttachment(Number(c.req.param("number")), c.req.param("id")).catch((e) => errorJson(c, e)));
v1.post("/inquiries/:number{[0-9]+}/status", async (c) =>
  body(c)
    .then((b) => {
      if (!isInquiryApiStatus(b["status"])) throw new ApiError("invalid", "status must be closed, waiting_shop or waiting_customer", 400);
      return api(c).inquirySetStatus(Number(c.req.param("number")), b["status"]);
    })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);

v1.get("/stores", async (c) => api(c).storesList().then((r) => c.json({ stores: r })).catch((e) => errorJson(c, e)));
v1.get("/tryon-requests", async (c) =>
  api(c)
    .tryonRequestsList({ status: c.req.query("status") || undefined, storeId: c.req.query("store_id") || undefined, limit: int(c.req.query("limit"), 50), offset: int(c.req.query("offset"), 0) })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
v1.get("/tryon-requests/:number{[0-9]+}", async (c) => api(c).tryonRequestGet(Number(c.req.param("number"))).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.post("/tryon-requests/:number{[0-9]+}/restock", async (c) => api(c).tryonRequestRestock(Number(c.req.param("number"))).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.post("/tryon-requests/:number{[0-9]+}/status", async (c) =>
  body(c)
    .then((b) => {
      const s = b["status"];
      const hold = b["hold_until"];
      if (!isTryonApiStatus(s)) throw new ApiError("invalid", "status must be sent, ready, purchased, not_purchased or cancelled", 400);
      if (hold !== undefined && (typeof hold !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(hold))) throw new ApiError("invalid", "hold_until must be YYYY-MM-DD", 400);
      if (s === "ready" && hold === undefined) throw new ApiError("invalid", "hold_until is required for ready", 400);
      return api(c).tryonRequestUpdate(Number(c.req.param("number")), s, hold as string | undefined);
    })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);

// ページ・ブログの記事（0083。content:read / content:write、docs/ai-access.md §9）。:ref は id（UUID）か handle。消すのはゴミ箱へ
v1.get("/pages", async (c) =>
  api(c)
    .pagesList({ status: c.req.query("status") || undefined, query: c.req.query("q") || undefined, limit: int(c.req.query("limit"), 50), offset: int(c.req.query("offset"), 0) })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
v1.post("/pages", async (c) => body(c).then((b) => api(c).pageSave(b)).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.get("/pages/:ref", async (c) => api(c).pageGet(c.req.param("ref")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.patch("/pages/:id", async (c) => body(c).then((b) => api(c).pageSave({ ...b, id: c.req.param("id") })).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.delete("/pages/:id", async (c) => api(c).pageTrash(c.req.param("id")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.get("/blogs", async (c) => api(c).blogsList().then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.get("/blogs/:blog/articles", async (c) =>
  api(c)
    .articlesList(c.req.param("blog"), { status: c.req.query("status") || undefined, query: c.req.query("q") || undefined, tag: c.req.query("tag") || undefined, limit: int(c.req.query("limit"), 50), offset: int(c.req.query("offset"), 0) })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
v1.post("/blogs/:blog/articles", async (c) => body(c).then((b) => api(c).articleSave(c.req.param("blog"), b)).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.get("/blogs/:blog/articles/:ref", async (c) => api(c).articleGet(c.req.param("blog"), c.req.param("ref")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.patch("/blogs/:blog/articles/:id", async (c) => body(c).then((b) => api(c).articleSave(c.req.param("blog"), { ...b, id: c.req.param("id") })).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.delete("/blogs/:blog/articles/:id", async (c) => api(c).articleTrash(c.req.param("blog"), c.req.param("id")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));

// クーポン（0036。coupons:read / coupons:write）。:ref は id（UUID）かコード
v1.get("/coupons", async (c) =>
  api(c)
    .couponsList({ query: c.req.query("q") || undefined, active: c.req.query("active") === undefined ? undefined : c.req.query("active") === "true", limit: int(c.req.query("limit"), 50), offset: int(c.req.query("offset"), 0) })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
v1.post("/coupons", async (c) => body(c).then((b) => api(c).couponCreate(b)).then((r) => c.json(r, 201)).catch((e) => errorJson(c, e)));
v1.get("/coupons/:ref", async (c) => api(c).couponGet(c.req.param("ref")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.patch("/coupons/:id", async (c) => body(c).then((b) => api(c).couponUpdate(c.req.param("id"), b)).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.delete("/coupons/:id", async (c) => api(c).couponDelete(c.req.param("id")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.get("/coupons/:id/grants", async (c) =>
  api(c)
    .couponGrantsList(c.req.param("id"), { status: c.req.query("status") || undefined, limit: int(c.req.query("limit"), 50), offset: int(c.req.query("offset"), 0) })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
v1.post("/coupons/:id/grants", async (c) =>
  body(c)
    .then((b) => {
      const ids = b["customer_ids"] ?? [];
      const count = b["count"] ?? 0;
      if (!Array.isArray(ids) || !ids.every((x): x is string => typeof x === "string")) throw new ApiError("invalid", "customer_ids must be an array of member ids", 400);
      if (typeof count !== "number" || !Number.isInteger(count)) throw new ApiError("invalid", "count must be an integer", 400);
      return api(c).couponGrantsIssue(c.req.param("id"), ids, count);
    })
    .then((r) => c.json(r, 201))
    .catch((e) => errorJson(c, e)),
);
v1.post("/coupon-grants/:id/revoke", async (c) => api(c).couponGrantRevoke(c.req.param("id")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));

// 会員（0036。customers:read / customers:write。メールアドレスは変えられない）
v1.get("/customers", async (c) =>
  api(c)
    .customersList({
      query: c.req.query("q") || undefined,
      email: c.req.query("email") || undefined,
      limit: int(c.req.query("limit"), 50),
      offset: int(c.req.query("offset"), 0),
      externalProvider: c.req.query("external_provider") || undefined,
      externalId: c.req.query("external_id") || undefined,
      updatedSince: c.req.query("updated_since") || undefined,
      marketingConsent: c.req.query("marketing_consent") === "true" ? true : c.req.query("marketing_consent") === "false" ? false : undefined,
    })
    .then((r) => c.json(r, 200, { "cache-control": "no-store" }))
    .catch((e) => errorJson(c, e)),
);
v1.post("/customers", async (c) => body(c).then((b) => api(c).customerCreate(b)).then((r) => c.json(r, 201)).catch((e) => errorJson(c, e)));
// 0047: メールアドレスで引いて、あれば更新、無ければ作る（外部の顧客マスタからの同期の窓口）。created なら 201
v1.post("/customers/upsert", async (c) =>
  body(c)
    .then((b) => api(c).customerUpsert(b))
    .then((r) => c.json(r, r["created"] === true ? 201 : 200))
    .catch((e) => errorJson(c, e)),
);
v1.get("/customers/:id", async (c) => api(c).customerGet(c.req.param("id")).then((r) => c.json(r, 200, { "cache-control": "no-store" })).catch((e) => errorJson(c, e)));
v1.patch("/customers/:id", async (c) => body(c).then((b) => api(c).customerUpdate(c.req.param("id"), b)).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.delete("/customers/:id", async (c) => api(c).customerDelete(c.req.param("id")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));

v1.get("/stats/sales", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const groupBy = c.req.query("group_by") ?? "day";
  if (!from || !to) return c.json({ error: { code: "invalid", message: "from and to (ISO 8601) are required" } }, 400);
  if (groupBy !== "day" && groupBy !== "month" && groupBy !== "product") return c.json({ error: { code: "invalid", message: "group_by must be day, month or product" } }, 400);
  return api(c).salesSummary(from, to, groupBy).then((r) => c.json(r)).catch((e) => errorJson(c, e));
});
v1.get("/stats/inventory-low", async (c) =>
  api(c)
    .inventoryLow(c.req.query("threshold") ? int(c.req.query("threshold"), 3) : undefined)
    .then((r) => c.json({ items: r }))
    .catch((e) => errorJson(c, e)),
);

// ---- テーマ（theme:write / theme:publish、0072、docs/themes.md）。CLI（cli/banto-theme.mjs）と GitHub Actions が使う。MCP には出さない ----
// 取り込み: POST /themes（束ねたファイル）→ PUT /themes/:id/assets/:name（資産を 1 つずつ）→ POST /themes/:id/complete
v1.get("/themes", async (c) => api(c).themesList().then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.post("/themes", async (c) =>
  body(c, THEME_UPLOAD_MAX_BYTES)
    .then((b) => api(c).themeCreate(typeof b["name"] === "string" ? b["name"] : "", b["bundle"]))
    .then((r) => c.json(r, 201))
    .catch((e) => errorJson(c, e)),
);
v1.put("/themes/:id/assets/:name", async (c) => {
  try {
    const length = Number(c.req.header("content-length") ?? NaN);
    if (!Number.isFinite(length)) throw new ApiError("invalid", "Content-Length is required", 411);
    const read = await readBodyLimited(c.req.raw, THEME_BUNDLE_LIMITS.assetBytes);
    if (!read) throw new ApiError("invalid", "invalid_asset: an asset can be up to 5MB", 413);
    return c.json(await api(c).themeAssetPut(c.req.param("id"), c.req.param("name"), read.slice().buffer));
  } catch (e) {
    return errorJson(c, e);
  }
});
v1.post("/themes/:id/complete", async (c) => api(c).themeComplete(c.req.param("id")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.post("/themes/:id/preview", async (c) => api(c).themePreview(c.req.param("id")).then((r) => c.json(r, 200, { "cache-control": "no-store" })).catch((e) => errorJson(c, e)));
v1.delete("/themes/:id", async (c) => api(c).themeDelete(c.req.param("id")).then((r) => c.json(r)).catch((e) => errorJson(c, e)));
v1.post("/themes/publish", async (c) =>
  body(c)
    .then((b) => {
      const v = b["version_id"];
      if (v !== null && typeof v !== "string") throw new ApiError("invalid", "version_id must be a string (or null to unpublish)", 400);
      return api(c).themePublish(v);
    })
    .then((r) => c.json(r))
    .catch((e) => errorJson(c, e)),
);
