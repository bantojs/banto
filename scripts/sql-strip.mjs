// マイグレーションの SQL から注釈（-- から行の終わり）と、文字列の外の字下げ・行末の空白・空の行を外す（Worker に埋め込む大きさを減らすため）。
// 文字列（'…'、E'…'）・識別子（"…"）の中は 1 文字も変えない。関数の本文（as か do の直後のドル引用 $$ … $$、$tag$ … $tag$）は
// 同じ規則で読む（plpgsql・sql の本文の注釈と文字列は外と同じ書き方）。それ以外のドル引用（本文の中の $q$ … $q$ など）は文字列として写す。
// /* */ の注釈は今のマイグレーションに無いので、文字列の外に出たら止める。
// scripts/gen-migrations.mjs が使う。DB のテスト（test/db/harness.ts）は外した後の SQL を当てるので、外し方の誤りはそこで捕まる。

const IDENT = /[A-Za-z0-9_$\u0080-\uffff]/;
const TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

export function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  /** いま読んでいる関数の本文の札（本文の外なら null） */
  let body = null;
  /** 行の頭（字下げを飛ばす） */
  let lineStart = true;

  const newline = () => {
    let end = out.length;
    while (end > 0 && (out[end - 1] === " " || out[end - 1] === "\t")) end--;
    out = out.slice(0, end);
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
    lineStart = true;
  };

  while (i < n) {
    const ch = sql[i];
    if (ch === "\n" || ch === "\r") {
      newline();
      i++;
      continue;
    }
    if (lineStart && (ch === " " || ch === "\t")) {
      i++;
      continue;
    }
    lineStart = false;
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") throw new Error(`sql-strip: /* */ comments are not supported (at ${i})`);
    if (ch === "'") {
      // E'…' だけ \ が逃がしの記号（standard_conforming_strings = on）
      const prev = out[out.length - 1];
      const escapes = (prev === "E" || prev === "e") && !IDENT.test(out[out.length - 2] ?? "");
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error(`sql-strip: unterminated string (at ${i})`);
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0) throw new Error(`sql-strip: unterminated identifier (at ${i})`);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "$" && !IDENT.test(out[out.length - 1] ?? "")) {
      const m = TAG.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        if (body === tag) body = null;
        else if (body === null && /(?:^|[^A-Za-z0-9_])(?:as|do)\s*$/i.test(out.slice(-16))) body = tag;
        else {
          const end = sql.indexOf(tag, i + tag.length);
          if (end < 0) throw new Error(`sql-strip: unterminated dollar quote ${tag} (at ${i})`);
          out += sql.slice(i, end + tag.length);
          i = end + tag.length;
          continue;
        }
        out += tag;
        i += tag.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  if (body !== null) throw new Error(`sql-strip: unterminated dollar quote ${body}`);
  newline();
  return out;
}
