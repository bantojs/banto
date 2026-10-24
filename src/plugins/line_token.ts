/**
 * LINE の Messaging API のチャネルアクセストークン。ショップに設定があればそれ（0021、暗号文をサイトの秘密で開く）、
 * 無ければデプロイの Workers Secret（LINE_CHANNEL_ACCESS_TOKEN、1 つのショップだけの運営向け）。どちらも無ければ null。
 */
import { openSecret } from "../members/secret-box";
import type { PluginContext } from "./types";

export const LINE_SECRET_PURPOSE = "line_messaging";

export async function lineToken(ctx: PluginContext): Promise<string | null> {
  if (ctx.sessionSecret) {
    const box = await ctx.privileged.shopSecret(ctx.envelope.shop_id, LINE_SECRET_PURPOSE);
    if (box) {
      const token = await openSecret(ctx.sessionSecret, ctx.envelope.shop_id, LINE_SECRET_PURPOSE, box);
      if (token) return token;
      // サイトの秘密が変わった等で開けない。デプロイのトークンには落とさない（別のチャネルから送らない）
      throw new Error("line: ショップのチャネルアクセストークンを開けません（SESSION_SECRET を変えたら入れ直してください）");
    }
  }
  try {
    return ctx.config.secret("LINE_CHANNEL_ACCESS_TOKEN");
  } catch {
    return null;
  }
}
