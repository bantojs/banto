import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { EMBED_SCRIPT, parseEmbedUrl } from "../src/pages/embeds";
import { parseShopBlock, shopBlockLine, shopBlocksOf } from "../src/pages/shop-blocks";
import { markdownToHtml } from "../src/pages/markdown";

/** 埋め込み（`::: embed url=…`、src/pages/embeds.ts）: 押すまで外へつながない・iframe の URL は Banto が組み直す */

describe("埋め込みの URL", () => {
  it("対応する形だけを読み、iframe の URL は取り出した ID から組み直す", () => {
    expect(parseEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s")).toEqual({ provider: "youtube", src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1", link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(parseEmbedUrl("https://youtu.be/dQw4w9WgXcQ")?.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
    expect(parseEmbedUrl("https://youtube.com/shorts/dQw4w9WgXcQ")?.provider).toBe("youtube");
    expect(parseEmbedUrl("https://twitter.com/jack/status/20?s=20")).toEqual({ provider: "x", src: "https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true", link: "https://x.com/jack/status/20" });
    expect(parseEmbedUrl("https://www.instagram.com/reel/Cabc123_-/?igsh=x")?.src).toBe("https://www.instagram.com/reel/Cabc123_-/embed/");
    expect(parseEmbedUrl("https://www.tiktok.com/@shop.jp/video/7300000000000000000")?.src).toBe("https://www.tiktok.com/embed/v2/7300000000000000000");
    expect(parseEmbedUrl("https://www.reddit.com/r/japan/comments/abc123/some_title/")?.src).toBe("https://embed.reddit.com/r/japan/comments/abc123/");
    const did = "did:plc:abcdefghijklmnopqrstuvwx";
    expect(parseEmbedUrl(`https://bsky.app/profile/${did}/post/3kabc`)?.src).toBe(`https://embed.bsky.app/embed/${did}/app.bsky.feed.post/3kabc`);
    expect(parseEmbedUrl(`at://${did}/app.bsky.feed.post/3kabc`)?.link).toBe(`https://bsky.app/profile/${did}/post/3kabc`);
    // ハンドルの URL はリンクだけ
    expect(parseEmbedUrl("https://bsky.app/profile/shop.bsky.social/post/3kabc")).toEqual({ provider: "bluesky", src: null, link: "https://bsky.app/profile/shop.bsky.social/post/3kabc" });
  });

  it("ほかのサイト・形の違うもの・javascript: は読まない", () => {
    for (const u of ["https://evil.example/watch?v=dQw4w9WgXcQ", "javascript:alert(1)", "https://www.youtube.com/watch?v=short", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "https://user@youtube.com/watch?v=dQw4w9WgXcQ", "https://x.com/jack", "https://www.instagram.com/shop/", "ftp://youtu.be/dQw4w9WgXcQ", 'https://youtu.be/dQw4w9WgXcQ"onload="x'])
      expect(parseEmbedUrl(u)).toBeNull();
  });
});

describe("埋め込みのブロック", () => {
  it("1 行を読み書きし（大文字小文字を変えない）、データを引くブロックに数えない", () => {
    const b = parseShopBlock('::: embed url="https://youtu.be/dQw4w9WgXcQ"')!;
    expect(b.attrs["url"]).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(shopBlockLine(b)).toBe('::: embed url="https://youtu.be/dQw4w9WgXcQ"');
    expect(parseShopBlock("::: embed url=https://evil.example/x")).toBeNull();
    expect(shopBlocksOf('::: embed url="https://youtu.be/dQw4w9WgXcQ"')).toEqual([]);
  });

  it("押すまでは枠とリンクだけ（iframe も外の画像も無い）。スクリプトは 1 回だけ", () => {
    const html = markdownToHtml('::: embed url="https://youtu.be/dQw4w9WgXcQ"\n\n::: embed url="https://x.com/jack/status/20"\n\n::: embed url="https://bsky.app/profile/shop.bsky.social/post/3kabc"', { mediaBase: "https://m.example.jp" });
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("ytimg");
    expect(html).toContain('data-banto-embed-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1"');
    expect(html).toContain("YouTube の動画を読み込む");
    expect(html).toContain("X の投稿を読み込む");
    expect(html).toContain('href="https://x.com/jack/status/20" target="_blank" rel="noopener noreferrer"');
    // Bluesky のハンドルの URL はリンクだけ（読み込むボタンが無い）
    expect(html).toMatch(/banto-embed--bluesky"><a class="banto-embed__link" href="https:\/\/bsky\.app\/profile\/shop\.bsky\.social\/post\/3kabc"/);
    expect(html.split("window.__bantoEmbed=1").length - 1).toBe(1);
    // 編集の画面には描かない（箱だけ）
    const ed = markdownToHtml('::: embed url="https://youtu.be/dQw4w9WgXcQ"', { mediaBase: "https://m.example.jp", editor: true });
    expect(ed).toContain('data-kind="embed"');
    expect(ed).not.toContain("<script");
  });

  it("スクリプトは決まった相手の URL しか iframe にしない", () => {
    const ok = /var ok=(\/.*?\/);/.exec(EMBED_SCRIPT)![1]!;
    const re = new Function(`return ${ok}`)() as RegExp;
    expect(re.test("https://www.youtube-nocookie.com/embed/x")).toBe(true);
    expect(re.test("https://embed.bsky.app/embed/did:plc:x/app.bsky.feed.post/y")).toBe(true);
    expect(re.test("https://evil.example/")).toBe(false);
    expect(re.test("javascript:alert(1)")).toBe(false);
  });

  it("お店の画面のページに出る", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true } } });
    sb.addPage(shop.id, { handle: "about", title: "店", body: '動画です\n\n::: embed url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"' });
    const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
    const html = await (await new Browser(app, BASE).get("/my-shop/pages/about")).text();
    expect(html).toContain("banto-embed--youtube");
    expect(html).toContain("window.__bantoEmbed=1");
    expect(html).not.toContain("<iframe");
  });
});
