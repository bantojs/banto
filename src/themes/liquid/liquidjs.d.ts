// liquidjs のブラウザ向けの版（fs・path・stream を読み込まない。Workers と Node の両方で同じものを使う）の型。中身は "liquidjs" と同じ
declare module "liquidjs/dist/liquid.browser.mjs" {
  export * from "liquidjs";
}
