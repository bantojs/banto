/**
 * 送り状 CSV のブラウザ側（管理画面に toString() で埋め込む。woo-import と同じ作り、CLIENT_PRELUDE を前に付ける）。
 * B2 クラウド・e飛伝Ⅲ は Shift_JIS の CSV を読むので、ブラウザで Shift_JIS に変換してダウンロードさせる（Worker の CPU を使わない）。
 * ブラウザの TextEncoder は UTF-8 しか作れないので、TextDecoder("shift_jis") で 2 バイトの全コードを読んで逆引きの表を作る。
 * 表に無い文字（絵文字など）は「?」にして、どの注文か画面に出す。
 * 送り状番号の取り込み: B2 クラウド・e飛伝Ⅲ が書き出した CSV（UTF-8 か Shift_JIS）をブラウザで読み、
 * 注文番号の列とお問い合わせ番号の列を見つけて（見出しから推測、選び直せる）、番号だけを Worker に送る。
 * この関数は外の変数を参照しない（toString() で切り出すため）。
 */
export function shippingLabelsClient() {
  interface El {
    textContent: string | null;
    append(...n: (El | string)[]): void;
    addEventListener(t: string, f: () => void): void;
    setAttribute(k: string, v: string): void;
    click(): void;
    remove(): void;
    disabled?: boolean;
    value?: string;
    files?: { arrayBuffer(): Promise<ArrayBuffer> }[] | null;
  }
  interface MountConfig {
    /** JSON の取得先（…/shipping-labels/rows.json） */
    rows: string;
    /** 送り状番号の送り先（…/shipping-labels/tracking） */
    tracking: string;
    t: Record<string, string>;
  }
  interface TrackingItem {
    number: string;
    carrier: string;
    tracking: string;
  }

  let table: Map<string, number> | null = null;
  function sjisTable(): Map<string, number> {
    if (table) return table;
    const dec = new TextDecoder("shift_jis");
    const map = new Map<string, number>();
    for (let b1 = 0x81; b1 <= 0xfc; b1++) {
      if (b1 > 0x9f && b1 < 0xe0) continue;
      for (let b2 = 0x40; b2 <= 0xfc; b2++) {
        if (b2 === 0x7f) continue;
        const s = dec.decode(new Uint8Array([b1, b2]));
        if (s.length === 1 && s !== "�" && !map.has(s)) map.set(s, (b1 << 8) | b2);
      }
    }
    // 見た目が同じで Unicode の違う文字（入力された文字が全角のチルダ・マイナスなど）
    const alias: [string, string][] = [
      ["～", "〜"],
      ["−", "－"],
      ["‖", "∥"],
      ["¢", "￠"],
      ["£", "￡"],
      ["¬", "￢"],
      ["—", "―"],
    ];
    // どちら向きでも引けるように（ブラウザの表がどちらの文字で持っているかは実装による）
    for (const [x, y] of alias) {
      if (!map.has(x) && map.has(y)) map.set(x, map.get(y)!);
      if (!map.has(y) && map.has(x)) map.set(y, map.get(x)!);
    }
    table = map;
    return map;
  }

  /** 文字列を Shift_JIS に。変換できなかった文字の一覧も返す */
  function encodeSjis(text: string): { bytes: Uint8Array<ArrayBuffer>; unmappable: string[] } {
    const map = sjisTable();
    const out: number[] = [];
    const bad = new Set<string>();
    for (const ch of text) {
      const c = ch.codePointAt(0)!;
      if (c < 0x80) out.push(c);
      else if (c >= 0xff61 && c <= 0xff9f) out.push(c - 0xff61 + 0xa1);
      else {
        const v = map.get(ch);
        if (v === undefined) {
          bad.add(ch);
          out.push(0x3f);
        } else out.push(v >> 8, v & 0xff);
      }
    }
    return { bytes: new Uint8Array(out), unmappable: [...bad] };
  }

  /** UTF-8 として読めなければ Shift_JIS（B2 クラウド・e飛伝Ⅲ の書き出しは Shift_JIS） */
  function decodeBytes(bytes: Uint8Array): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder("shift_jis").decode(bytes);
    }
  }

  /** RFC 4180 の CSV（ダブルクォート・"" のエスケープ・セル内の改行・CRLF / LF・先頭の BOM） */
  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
      const ch = text[i]!;
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else cell += ch;
    }
    if (cell !== "" || row.length > 0) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
  }

  /** 見出しから列を推測する。見出しが無ければ（1 行目が番号なら）-1 */
  function detectColumns(header: string[]): { number: number; tracking: number; carrier: string | null } {
    const norm = header.map((h) => h.replace(/\s/g, ""));
    const number = norm.findIndex((h) => /お客様管理(番号|ナンバー)|注文番号/.test(h));
    const tracking = norm.findIndex((h) => /^伝票番号$|送り状(No|NO|Ｎｏ|ＮＯ|番号)|問い?合わ?せ(番号|No|NO)/.test(h));
    const carrier = norm.some((h) => h === "伝票番号") ? "yamato" : norm.some((h) => /送り状(No|NO|Ｎｏ|ＮＯ)/.test(h)) ? "sagawa" : null;
    return { number, tracking, carrier };
  }

  /** 取り込む行。番号の列が数字でない行（見出し）・お問い合わせ番号の空の行は飛ばす */
  function trackingItems(rows: string[][], numberCol: number, trackingCol: number, carrier: string): TrackingItem[] {
    const out: TrackingItem[] = [];
    for (const r of rows) {
      const number = (r[numberCol] ?? "").trim();
      const tracking = (r[trackingCol] ?? "").trim();
      if (/^[0-9]{1,9}$/.test(number) && tracking) out.push({ number, carrier, tracking });
    }
    return out;
  }

  function mount(root: El, cfg: MountConfig) {
    const g = globalThis as unknown as {
      document: { createElement(tag: string): El; body: El };
      fetch: typeof fetch;
      URL: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void };
    };
    const t = (k: string, vars: Record<string, string | number> = {}) => (cfg.t[k] ?? k).replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? ""));
    const el = (tag: string, text = ""): El => {
      const e = g.document.createElement(tag);
      if (text) e.textContent = text;
      return e;
    };
    const log = el("div");
    const dateInput = el("input");
    dateInput.setAttribute("type", "date");
    dateInput.value = new Date().toISOString().slice(0, 10);
    const label = el("label", t("ship_date"));
    root.append(label, dateInput);
    for (const carrier of ["yamato", "sagawa"]) {
      const button = el("button", t(`download_${carrier}`));
      button.setAttribute("type", "button");
      button.addEventListener("click", async () => {
        button.disabled = true;
        log.textContent = t("loading");
        try {
          const res = await g.fetch(`${cfg.rows}?carrier=${carrier}&date=${encodeURIComponent(dateInput.value ?? "")}`, { credentials: "same-origin" });
          if (!res.ok) throw new Error(String(res.status));
          const data = (await res.json()) as { csv: string; count: number; warnings: { number: number; field: string }[] };
          const enc = encodeSjis(data.csv);
          const url = g.URL.createObjectURL(new Blob([enc.bytes], { type: "text/csv" }));
          const a = el("a");
          a.setAttribute("href", url);
          a.setAttribute("download", `${carrier === "yamato" ? "b2" : "ehiden3"}-${dateInput.value}.csv`);
          g.document.body.append(a);
          a.click();
          a.remove();
          g.URL.revokeObjectURL(url);
          log.textContent = "";
          log.append(el("p", t("done", { n: data.count })));
          if (enc.unmappable.length > 0) log.append(el("p", t("unmappable", { chars: enc.unmappable.join(" ") })));
          for (const w of data.warnings) log.append(el("p", t("warn", { number: w.number, field: t(`f_${w.field}`) })));
        } catch (e) {
          log.textContent = `${t("failed")} ${(e as Error).message}`;
        }
        button.disabled = false;
      });
      root.append(el("p", ""), button);
    }
    root.append(log);
  }

  function mountImport(root: El, cfg: MountConfig) {
    const g = globalThis as unknown as { document: { createElement(tag: string): El }; fetch: typeof fetch };
    const t = (k: string, vars: Record<string, string | number> = {}) => (cfg.t[k] ?? k).replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? ""));
    const el = (tag: string, text = ""): El => {
      const e = g.document.createElement(tag);
      if (text) e.textContent = text;
      return e;
    };
    const select = (options: [string, string][], value: string): El => {
      const s = el("select");
      for (const [v, label] of options) {
        const o = el("option", label);
        o.setAttribute("value", v);
        s.append(o);
      }
      s.value = value;
      return s;
    };
    const file = el("input");
    file.setAttribute("type", "file");
    file.setAttribute("accept", ".csv,text/csv");
    const form = el("div");
    const log = el("div");
    root.append(el("label", t("import_file")), file, form, log);
    file.addEventListener("change", async () => {
      form.textContent = "";
      log.textContent = "";
      const f = file.files?.[0];
      if (!f) return;
      const rows = parseCsv(decodeBytes(new Uint8Array(await f.arrayBuffer())));
      if (rows.length === 0) {
        log.textContent = t("import_no_rows");
        return;
      }
      const head = rows[0]!;
      const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
      const guess = detectColumns(head);
      const cols: [string, string][] = Array.from({ length: width }, (_, i) => [String(i), `${t("import_column", { n: i + 1 })}: ${(head[i] ?? "").slice(0, 30)}`]);
      const numberSel = select(cols, String(guess.number >= 0 ? guess.number : 0));
      const trackingSel = select(cols, String(guess.tracking >= 0 ? guess.tracking : Math.min(1, width - 1)));
      const carrierSel = select(["yamato", "sagawa", "japanpost", "other"].map((k) => [k, t(`carrier_${k}`)]), guess.carrier ?? "yamato");
      const preview = el("p");
      const items = () => trackingItems(rows, Number(numberSel.value), Number(trackingSel.value), carrierSel.value ?? "other");
      const refresh = () => {
        preview.textContent = t("import_preview", { n: items().length });
      };
      for (const s of [numberSel, trackingSel, carrierSel]) s.addEventListener("change", refresh);
      refresh();
      const go = el("button", t("import_start"));
      go.setAttribute("type", "button");
      go.addEventListener("click", async () => {
        const all = items();
        if (all.length === 0) {
          log.textContent = t("import_no_rows");
          return;
        }
        go.disabled = true;
        log.textContent = t("loading");
        const sum = { shipped: 0, updated: 0, invalid: 0, missing: [] as number[] };
        try {
          for (let i = 0; i < all.length; i += 500) {
            const res = await g.fetch(cfg.tracking, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ items: all.slice(i, i + 500) }),
            });
            if (!res.ok) throw new Error(String(res.status));
            const r = (await res.json()) as { shipped: number; updated: number; invalid: number; missing: number[] };
            sum.shipped += r.shipped;
            sum.updated += r.updated;
            sum.invalid += r.invalid;
            sum.missing.push(...r.missing);
          }
          log.textContent = "";
          log.append(el("p", t("import_done", { shipped: sum.shipped, updated: sum.updated, invalid: sum.invalid })));
          if (sum.missing.length > 0) log.append(el("p", t("import_missing", { numbers: sum.missing.join(", ") })));
        } catch (e) {
          log.textContent = `${t("failed")} ${(e as Error).message}`;
        }
        go.disabled = false;
      });
      form.append(el("label", t("import_col_number")), numberSel, el("label", t("import_col_tracking")), trackingSel, el("label", t("import_carrier")), carrierSel, preview, go);
    });
  }

  return { encodeSjis, decodeBytes, parseCsv, detectColumns, trackingItems, mount, mountImport };
}
