import { handleRequest, type PluginEnv } from "./plugin";

/** Cloudflare Workers の入口。他のランタイムでは handleRequest を直接呼ぶ */
export default {
  fetch: (req: Request, env: PluginEnv): Promise<Response> => handleRequest(req, env, { fetch }),
};
