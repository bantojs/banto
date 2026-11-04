// Worker に埋め込むマイグレーションのうち、土台（BASELINE_MIGRATION）までのファイルから、後で同じ形で定義し直される関数の古い定義を外す。
// 土台までのファイルを当てるのは新しい導入だけ（それより古い DB はサポートしない。CLAUDE.md §11）なので、最後の定義があれば足りる。
// supabase/migrations/ のファイルは変えない（記録としてそのまま）。外すのは scripts/gen-migrations.mjs の生成物だけ。
//
// 外してよい条件（どれかが欠ければ残す）:
//   - 同じ名前・同じ引数の型の `create or replace function` が後にある（後のものは土台の後のファイルでもよい）
//   - 外す定義は土台までのファイルにある
//   - 次の定義も土台までのファイルにある（土台の後のファイルは既存の DB にも当たるので変えない）
//   - その定義と次の定義のあいだに、その関数の名前を含む文が無い。ただし、その関数の revoke / grant / comment だけの文は、
//     次の定義のすぐ後ろへ移す（後の create or replace は関数を作り直すので、前の権限の文を同じ順に当て直す）。
//     test/db/squash.test.ts が「全部を当てた DB」と「外したものを当てた DB」の関数・権限・表・制約などを突き合わせて確かめる
//   - 定義を外すと、あいだの sql の関数の本文やトリガーから呼べなくなるので、名前を含む文が 1 つでもあれば残す

const TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/** 文に分ける（; で区切る。'…'・"…"・$tag$…$tag$ の中の ; は区切らない）。注釈は外してある前提（scripts/sql-strip.mjs の後） */
export function splitStatements(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === "$") {
      const m = TAG.exec(sql.slice(i, i + 64));
      // 識別子の途中の $（例 a$b）はドル引用ではない
      if (m && !(i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1]))) {
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end < 0) throw new Error("sql-squash: unterminated dollar quote");
        i = end + m[0].length;
        continue;
      }
    }
    if (ch === ";") {
      out.push(sql.slice(start, i + 1));
      start = i + 1;
    }
    i++;
  }
  const rest = sql.slice(start);
  if (rest.trim()) out.push(rest);
  return out;
}

/** 引数の並びを型だけの形にする（名前・既定値を外す）。読めなければ null（外さない側に倒す） */
function argTypes(args) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of args) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const types = [];
  for (const raw of parts) {
    let p = raw.replace(/\s+/g, " ").trim().toLowerCase();
    p = p.replace(/\s+(default|=)\s.*$/s, "");
    let toks = p.split(" ");
    if (["in", "out", "inout", "variadic"].includes(toks[0])) toks = toks.slice(1);
    // 名前つきの引数（このリポジトリは p_ / _ で始まる）
    if (toks.length > 1 && /^(p_|_)[a-z0-9_]*$/.test(toks[0])) toks = toks.slice(1);
    else if (toks.length > 1 && !/^(double|character|timestamp|time|bit|interval)$/.test(toks[0])) return null;
    types.push(toks.join(" "));
  }
  return types.join(",");
}

const DEF = /^\s*create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/i;

const BULK = /\bon\s+all\s+functions\b|\balter\s+default\s+privileges\b|^\s*do\s[\s\S]*\b(pg_proc|pg_catalog\.pg_proc|routines)\b/i;
const PLPGSQL = /\blanguage\s+plpgsql\b/i;

/** 関数の定義の文で、本文（最初のドル引用）の外に名前が出てくるか（引数の既定値・戻り値の型など。外にあれば作るときに要る） */
function mentionsOutsideBody(stmt, re) {
  const m = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(stmt);
  if (!m) return true;
  const end = stmt.indexOf(m[0], m.index + m[0].length);
  if (end < 0) return true;
  return re.test(stmt.slice(0, m.index)) || re.test(stmt.slice(end + m[0].length));
}

function nameRe(name) {
  return new RegExp(`(^|[^a-z0-9_$])${name}([^a-z0-9_$]|$)`, "i");
}

/** その関数の権限・注釈だけの文か */
function isAclOf(stmt, name) {
  const s = stmt.replace(/\s+/g, " ").trim().toLowerCase().replace(/;$/, "");
  const fn = `function (public\\.)?${name}\\s*\\(`;
  return new RegExp(`^(revoke|grant) [a-z ,]+ on function (public\\.)?${name} ?\\([^;]*$`).test(s) || new RegExp(`^comment on ${fn}`).test(s);
}

/**
 * entries: [{ version, sql }]（注釈を外した後）。baseline 以前のファイルから、後で定義し直される関数の古い定義を外したものを返す。
 * 何も外さないファイルは sql をそのまま返す
 */
export function squashMigrations(entries, baseline) {
  const stmts = [];
  entries.forEach((e, fi) => splitStatements(e.sql).forEach((text, si) => stmts.push({ fi, si, text, early: e.version <= baseline, drop: false })));
  const defsByKey = new Map();
  stmts.forEach((s, idx) => {
    const m = DEF.exec(s.text);
    if (!m) return;
    const types = argTypes(m[2]);
    if (types === null) return;
    const key = `${m[1].toLowerCase()}(${types})`;
    if (!defsByKey.has(key)) defsByKey.set(key, []);
    defsByKey.get(key).push({ idx, name: m[1].toLowerCase() });
  });
  // 外した定義のあいだにあった権限の文は捨てずに、次の定義のすぐ後ろへ移す（後の create or replace は関数を作り直すので、
  // 前の revoke が効かなくなる。元と同じ順に当て直せば、同じ権限になる）。次の定義が土台の後のファイルなら外さない（そのファイルは変えない）
  for (const defs of defsByKey.values()) {
    for (let k = 0; k + 1 < defs.length; k++) {
      const { idx, name } = defs[k];
      const next = defs[k + 1].idx;
      if (!stmts[idx].early || !stmts[next].early) continue;
      const re = nameRe(name);
      const acl = [];
      let ok = true;
      for (let j = idx + 1; j < next; j++) {
        // 名前を書かずに関数の権限をまとめて変える文（schema の関数すべて・pg_proc をなめる do・既定の権限）は、
        // そのとき関数があるかで結果が変わるので、あいだにあれば外さない
        if (BULK.test(stmts[j].text)) {
          ok = false;
          break;
        }
        if (!re.test(stmts[j].text)) continue;
        if (isAclOf(stmts[j].text, name)) acl.push(j);
        // plpgsql の本文は作るときに呼び先を確かめない（呼ぶのは後で、そのときは次の定義がある）
        else if (DEF.test(stmts[j].text) && PLPGSQL.test(stmts[j].text) && !mentionsOutsideBody(stmts[j].text, re)) continue;
        else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      stmts[idx].drop = true;
      const moved = [...(stmts[idx].after ?? [])];
      for (const j of acl) {
        stmts[j].drop = true;
        moved.push(stmts[j].text);
      }
      stmts[next].after = [...moved, ...(stmts[next].after ?? [])];
    }
  }
  return entries.map((e, fi) => {
    const mine = stmts.filter((s) => s.fi === fi);
    if (!mine.some((s) => s.drop || s.after)) return e;
    const out = [];
    for (const s of mine) {
      if (s.drop) continue;
      out.push(s.text.replace(/^\n+/, ""));
      for (const a of s.after ?? []) out.push(a.replace(/^\n+/, ""));
    }
    return { version: e.version, sql: out.join("\n").replace(/\n*$/, "\n") };
  });
}
