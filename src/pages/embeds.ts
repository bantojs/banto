/**
 * 本文の埋め込み（`::: embed url=…`、docs/pages.md「お店のブロック」）。YouTube・X・Instagram・TikTok・Reddit・Bluesky。
 *
 * - **押すまで外へつながない**（2 クリック、メンテナの決定 2026-11-03）: 最初は Banto が描いた枠とリンクだけを出し、押した人のブラウザだけが
 *   相手の埋め込みのページ（iframe）を読み込む。開いただけのお客様の閲覧が外のサービスに送られない。サムネイルも外から取らない
 * - 相手のスクリプトはお店の画面に読み込まない（iframe だけ。お店のオリジンで知らない JS を動かさない）
 * - iframe の URL は、決まった形の URL から取り出した ID だけで Banto が組み直す（貼られた URL をそのまま使わない）
 * - スクリプトが動かない画面（ヘッドレスで HTML を差し込んだときなど）でも、元の投稿へのリンクが残る
 * - Bluesky は投稿の持ち主が DID の形（did:plc:… / did:web:…）の URL だけ埋め込める（ハンドルの URL はリンクだけ）。
 *   ハンドルから DID を引くには外への問い合わせが要り、リクエストの途中ではしないため
 */
import { t, type MessageKey } from "../i18n";

export type EmbedProvider = "youtube" | "x" | "instagram" | "tiktok" | "reddit" | "bluesky";

export interface Embed {
  provider: EmbedProvider;
  /** 押したときに読み込む iframe の URL（Banto が組み直したもの）。無ければリンクだけ */
  src: string | null;
  /** 元の投稿・動画の URL（組み直したもの） */
  link: string;
}

const PROVIDER_NAMES: Record<EmbedProvider, string> = { youtube: "YouTube", x: "X", instagram: "Instagram", tiktok: "TikTok", reddit: "Reddit", bluesky: "Bluesky" };
export const embedProviderName = (p: EmbedProvider) => PROVIDER_NAMES[p];

/** 貼られた URL を読む。対応していない・形が違うものは null */
export function parseEmbedUrl(raw: string): Embed | null {
  const v = raw.trim();
  if (v.length > 300) return null;
  // Bluesky の埋め込みのコードにある AT URI（at://did:plc:…/app.bsky.feed.post/<rkey>）
  const at = /^at:\/\/(did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]{1,100}))\/app\.bsky\.feed\.post\/([a-z0-9]{1,20})$/.exec(v);
  if (at) return bluesky(at[1]!, at[2]!);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|old)\./, "");
  const path = u.pathname;
  let m: RegExpExecArray | null;
  if (host === "youtube.com" || host === "youtu.be") {
    const id = host === "youtu.be" ? /^\/([A-Za-z0-9_-]{11})\/?$/.exec(path)?.[1] : path === "/watch" ? u.searchParams.get("v") : /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(path)?.[1];
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`, link: `https://www.youtube.com/watch?v=${id}` };
  }
  if ((host === "x.com" || host === "twitter.com") && (m = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/.exec(path))) {
    return { provider: "x", src: `https://platform.twitter.com/embed/Tweet.html?id=${m[2]}&dnt=true`, link: `https://x.com/${m[1]}/status/${m[2]}` };
  }
  if (host === "instagram.com" && (m = /^\/(p|reel|tv)\/([A-Za-z0-9_-]{5,40})\/?$/.exec(path))) {
    return { provider: "instagram", src: `https://www.instagram.com/${m[1]}/${m[2]}/embed/`, link: `https://www.instagram.com/${m[1]}/${m[2]}/` };
  }
  if (host === "tiktok.com" && (m = /^\/@([A-Za-z0-9._]{1,30})\/video\/(\d{5,25})\/?$/.exec(path))) {
    return { provider: "tiktok", src: `https://www.tiktok.com/embed/v2/${m[2]}`, link: `https://www.tiktok.com/@${m[1]}/video/${m[2]}` };
  }
  if (host === "reddit.com" && (m = /^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{3,12})(?:\/[A-Za-z0-9_%-]{0,120})?\/?$/.exec(path))) {
    return { provider: "reddit", src: `https://embed.reddit.com/r/${m[1]}/comments/${m[2]}/`, link: `https://www.reddit.com/r/${m[1]}/comments/${m[2]}/` };
  }
  if (host === "bsky.app" && (m = /^\/profile\/([A-Za-z0-9.:-]{1,253})\/post\/([a-z0-9]{1,20})\/?$/.exec(path))) {
    return bluesky(m[1]!, m[2]!);
  }
  return null;
}

function bluesky(actor: string, rkey: string): Embed | null {
  const did = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]{1,100})$/.test(actor);
  if (!did && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}$/i.test(actor)) return null;
  return { provider: "bluesky", src: did ? `https://embed.bsky.app/embed/${actor}/app.bsky.feed.post/${rkey}` : null, link: `https://bsky.app/profile/${actor}/post/${rkey}` };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 押すまでの枠（外へつながない）。押したら EMBED_SCRIPT が iframe に差し替える */
export function embedHtml(e: Embed): string {
  const name = embedProviderName(e.provider);
  const kind = e.provider === "youtube" || e.provider === "tiktok" ? "video" : "post";
  const open = `<a class="banto-embed__link" href="${esc(e.link)}" target="_blank" rel="noopener noreferrer">${esc(t("embed.open").replace("{provider}", name))}</a>`;
  const button = e.src
    ? `<button type="button" class="banto-embed__load" data-banto-embed-src="${esc(e.src)}" data-title="${esc(name)}">${esc(t(`embed.load_${kind}` as MessageKey).replace("{provider}", name))}</button>` +
      `<span class="banto-embed__note">${esc(t("embed.note").replace("{provider}", name))}</span>`
    : "";
  return `<div class="banto-embed banto-embed--${e.provider}">${button}${open}</div>`;
}

/**
 * 押したら iframe にする（ページに 1 回だけ）。読み込む先は決まった相手の埋め込みの URL だけ。
 * sandbox は相手のページが動くのに要るものだけ（お店のページへは触れない。別のオリジンなので allow-same-origin は相手自身のオリジン）
 */
export const EMBED_SCRIPT = `(function(){if(window.__bantoEmbed)return;window.__bantoEmbed=1;var ok=/^https:\\/\\/(www\\.youtube-nocookie\\.com\\/embed\\/|platform\\.twitter\\.com\\/embed\\/Tweet\\.html\\?|www\\.instagram\\.com\\/(p|reel|tv)\\/|www\\.tiktok\\.com\\/embed\\/v2\\/|embed\\.reddit\\.com\\/r\\/|embed\\.bsky\\.app\\/embed\\/)/;document.addEventListener("click",function(e){var b=e.target&&e.target.closest&&e.target.closest("button[data-banto-embed-src]");if(!b)return;var s=b.getAttribute("data-banto-embed-src")||"";if(!ok.test(s))return;var box=b.parentNode,f=document.createElement("iframe");f.src=s;f.title=b.getAttribute("data-title")||"";f.setAttribute("allow","autoplay; encrypted-media; picture-in-picture; fullscreen");f.setAttribute("allowfullscreen","");f.setAttribute("sandbox","allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation");f.setAttribute("referrerpolicy","strict-origin-when-cross-origin");f.className="banto-embed__frame";box.insertBefore(f,b);var n=box.querySelector(".banto-embed__note");if(n)n.remove();b.remove();box.classList.add("is-loaded");});})();`;

/** 枠と iframe の CSS（大きさは相手ごと。色はテーマの CSS の変数） */
export const EMBED_CSS = [
  ".banto-embed{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;margin:1.25rem 0;padding:1.25rem;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:var(--banto-radius,.5rem);text-align:center;min-height:9rem}",
  ".banto-embed--youtube{aspect-ratio:16/9;min-height:0}.banto-embed__load{font:inherit;padding:.6rem 1rem;cursor:pointer}.banto-embed__note{font-size:.8em;opacity:.7}.banto-embed__link{font-size:.85em}",
  ".banto-embed.is-loaded{padding:0;border:0;display:block}.banto-embed__frame{display:block;width:100%;border:0;height:620px}.banto-embed.is-loaded .banto-embed__link{display:block;margin-top:.35rem;text-align:right}",
  ".banto-embed--youtube.is-loaded .banto-embed__frame{height:auto;aspect-ratio:16/9}.banto-embed--instagram .banto-embed__frame{height:720px;max-width:540px;margin:0 auto}.banto-embed--tiktok .banto-embed__frame{height:740px;max-width:340px;margin:0 auto}.banto-embed--reddit .banto-embed__frame,.banto-embed--bluesky .banto-embed__frame{height:520px;max-width:600px;margin:0 auto}",
].join("");
