import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { fieldSortOf, fieldsFromForm, parseArticleFieldRows } from "../src/blog/fields";
import { articlesLine, parseArticlesLine } from "../src/pages/blocks";
import { setTimeZone } from "../src/i18n/time";

/** 記事の項目の日付・日時（0124、メンテナの決定 2026-11-07）と、その順での並べ替え・今日以降だけ */
afterEach(() => setTimeZone("Asia/Tokyo"));

const DAY = 86_400_000;
const ymd = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { blog: true, pages: true } } });
  const org = String(sb.tables.shops.find((x) => x["id"] === shop.id)!["org_id"]);
  const stores = ["渋谷店", "新宿店"].map((name, i) => {
    const id = crypto.randomUUID();
    sb.tables.stores.push({ id, org_id: org, name, hours: {}, special_days: [], note: null, active: true, sort_order: i });
    sb.tables.shop_stores.push({ shop_id: shop.id, store_id: id, tryon: false, sort_order: i });
    return id;
  });
  const events = sb.addBlog(shop.id, { id: crypto.randomUUID(), handle: "events", title: "イベント", article_fields: [{ key: "store", label: "店舗", type: "store" }, { key: "starts", label: "開催日", type: "date" }, { key: "opens", label: "開場", type: "datetime" }] });
  const now = Date.now();
  // 公開した日時は新しい順にすると「来月 → 昨日 → 明日 → 日付なし」の並び
  const add = (handle: string, title: string, published: number, fields: Record<string, unknown>) => sb.addArticle(shop.id, events.id, { id: crypto.randomUUID(), handle, title, published_at: new Date(now - published * DAY).toISOString(), fields });
  add("tomorrow", "明日のフェア", 4, { store: stores[0], starts: ymd(now + DAY) });
  add("yesterday", "昨日の採寸会", 3, { store: stores[0], starts: ymd(now - DAY) });
  add("today", "今日の古着市", 2, { store: stores[1], starts: ymd(now) });
  add("next-month", "来月の試着会", 1, { store: stores[0], starts: ymd(now + 30 * DAY) });
  add("undated", "日付なし", 0, { store: stores[1] });
  return { sb, shop, app: appWith(sb, {}, new MemoryStorage(`${BASE}/media`)) };
}

let n = 0;
async function page(s: ReturnType<typeof setup>, body: string) {
  const handle = `p-${++n}`;
  s.sb.addPage(s.shop.id, { id: crypto.randomUUID(), handle, title: "t", body });
  return (await new Browser(s.app, BASE).get(`/my-shop/pages/${handle}`)).text();
}
const titles = (html: string) => [...html.matchAll(/font-weight:600">([^<]+)</g)].map((m) => m[1]);

describe("::: articles sort=field:<key> from=today", () => {
  it("日付の早い順（値の無い記事は後ろ）。from=today で昨日より前を出さない", async () => {
    const s = setup();
    expect(titles(await page(s, "::: articles blog=events limit=6"))).toEqual(["日付なし", "来月の試着会", "今日の古着市", "昨日の採寸会", "明日のフェア"]);
    expect(titles(await page(s, "::: articles blog=events sort=field:starts limit=6"))).toEqual(["昨日の採寸会", "今日の古着市", "明日のフェア", "来月の試着会", "日付なし"]);
    expect(titles(await page(s, "::: articles blog=events sort=field:starts from=today limit=2"))).toEqual(["今日の古着市", "明日のフェア"]);
    // 日付でない項目・無い項目は何も並べない
    expect(titles(await page(s, "::: articles blog=events sort=field:store"))).toEqual([]);
  });

  it("::: stores articles=… sort=field:starts from=today: 店舗ごとに今日以降を早い順で", async () => {
    const s = setup();
    const html = await page(s, "::: stores articles=events sort=field:starts from=today limit=3");
    const at = html.indexOf("新宿店");
    expect(titles(html.slice(0, at))).toEqual(["明日のフェア", "来月の試着会"]);
    expect(titles(html.slice(at))).toEqual(["今日の古着市"]);
  });

  it("書き方の読み書き。from は sort=field: のときだけ", () => {
    const b = parseArticlesLine("::: articles blog=events sort=field:starts from=today limit=4")!;
    expect(b).toMatchObject({ fieldSort: "starts", from: "today", sort: null });
    expect(articlesLine(b)).toBe("::: articles blog=events limit=4 layout=grid sort=field:starts from=today");
    const plain = parseArticlesLine("::: articles blog=events sort=new from=today")!;
    expect([plain.sort, plain.from ?? null]).toEqual(["new", null]);
    expect(parseArticlesLine("::: articles blog=events from=tomorrow")).toBeNull();
  });
});

describe("部品", () => {
  it("定義は当たるまで date / datetime を受けない。今日の下限はデプロイの時間帯", () => {
    expect(parseArticleFieldRows("starts | 開催日 | date", []).error).toBe("starts | 開催日 | date");
    expect(parseArticleFieldRows("starts | 開催日 | date\nopens | 開場 | datetime", [], { dates: true }).defs.map((d) => d.type)).toEqual(["date", "datetime"]);
    const blog = { article_fields: [{ key: "starts", label: "s", type: "date" }, { key: "opens", label: "o", type: "datetime" }, { key: "t", label: "t", type: "text" }] };
    const at = Date.UTC(2026, 10, 7, 16, 30); // 東京では 11/8 1:30
    expect(fieldSortOf(blog, "starts", true, at)).toEqual({ key: "starts", from: "2026-11-08" });
    expect(fieldSortOf(blog, "opens", true, at)).toEqual({ key: "opens", from: "2026-11-07T15:00:00Z" });
    expect(fieldSortOf(blog, "t", true, at)).toBeNull();
    setTimeZone("America/Los_Angeles");
    expect(fieldSortOf(blog, "starts", true, at)).toEqual({ key: "starts", from: "2026-11-07" });
  });

  it("画面の日時は時間帯の時刻として受け、時差つきにする", () => {
    const defs = [{ key: "opens", label: "o", type: "datetime" as const }, { key: "starts", label: "s", type: "date" as const }];
    expect(fieldsFromForm(defs, { field_opens: "2026-11-20T10:00", field_starts: "2026-11-20" })).toEqual({ opens: "2026-11-20T01:00:00.000Z", starts: "2026-11-20" });
  });
});
