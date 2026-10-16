/* Year 11 C# Homework engine
 * Renders a homework from window.HW_DATA (decoded from content/hwNN.js),
 * marks answers in the browser, saves progress to localStorage and
 * produces a PDF completion report with a verification code.
 */
(function () {
  "use strict";

  var PASS_PERCENT = 80;
  var SECRET = "eltham-y11-cs-2026"; // used only to detect casual edits to reports
  var store = {
    get: function (k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  /* ---------------- utilities ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function cyrb53(str, seed) {
    var h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  function seededShuffle(arr, seedStr) {
    var a = arr.slice(), s = cyrb53(seedStr) % 4294967296;
    function rnd() { s |= 0; s = (s + 0x6d2b79f5) | 0; var t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var tmp = a[i]; a[i] = a[j]; a[j] = tmp; }
    return a;
  }
  function b64urlEncode(str) {
    var bytes = new TextEncoder().encode(str), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function decodeContent(encoded, id) {
    var bin = atob(encoded), key = "y11cs:" + id, bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function normOut(s) {
    var lines = String(s || "").replace(/\r/g, "").split("\n").map(function (l) { return l.replace(/\s+$/, ""); });
    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }
  function normCode(s) { return String(s || "").replace(/\s+/g, "").replace(/;+$/, ""); }
  function normCell(s) { return String(s == null ? "" : s).trim().replace(/^["']|["']$/g, "").toLowerCase(); }
  function wordCount(s) { var m = String(s || "").trim().match(/\S+/g); return m ? m.length : 0; }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

  /* ---------------- syntax highlighting ---------------- */
  var LANG = {
    cs: {
      kw: "if else for foreach while do switch case default break continue return new const static void using namespace class public private true false null var in out ref",
      ty: "int double float decimal string char bool long byte object Console Math Convert Random",
      str: /^\$?@?"(?:\\.|[^"\\])*"?|^'(?:\\.|[^'\\])'/,
      com: /^\/\/.*/
    },
    erl: {
      kw: "if then elseif else endif for to step next while endwhile do until switch case default endswitch function endfunction procedure endprocedure return print input const global array AND OR NOT MOD DIV true false",
      ty: "str int float real bool",
      str: /^"(?:\\.|[^"\\])*"?|^'(?:\\.|[^'\\])*'?/,
      com: /^\/\/.*/
    }
  };
  Object.keys(LANG).forEach(function (k) {
    LANG[k].kwSet = {}; LANG[k].kw.split(" ").forEach(function (w) { LANG[k].kwSet[w] = 1; });
    LANG[k].tySet = {}; LANG[k].ty.split(" ").forEach(function (w) { LANG[k].tySet[w] = 1; });
  });
  function highlightLine(line, lang) {
    var L = LANG[lang];
    if (!L) return esc(line);
    var out = "", rest = line, m;
    while (rest.length) {
      if ((m = rest.match(L.com))) { out += '<span class="t-com">' + esc(m[0]) + "</span>"; rest = rest.slice(m[0].length); continue; }
      if ((m = rest.match(L.str))) { out += '<span class="t-str">' + esc(m[0]) + "</span>"; rest = rest.slice(m[0].length); continue; }
      if ((m = rest.match(/^\d+(\.\d+)?[fFdDmM]?/))) { out += '<span class="t-num">' + esc(m[0]) + "</span>"; rest = rest.slice(m[0].length); continue; }
      if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/))) {
        var w = m[0], after = rest.slice(w.length);
        if (/^___\d+___$/.test(w)) out += w;
        else if (L.kwSet[w]) out += '<span class="t-kw">' + w + "</span>";
        else if (L.tySet[w]) out += '<span class="t-ty">' + w + "</span>";
        else if (/^\s*\(/.test(after)) out += '<span class="t-fn">' + w + "</span>";
        else out += w;
        rest = after; continue;
      }
      out += esc(rest[0]); rest = rest.slice(1);
    }
    return out;
  }
  function codeBlock(code, lang, opts) {
    opts = opts || {};
    var pre = el("pre", { class: "code" + (opts.lines === false ? " nolines" : "") });
    String(code).replace(/\r/g, "").replace(/\n$/, "").split("\n").forEach(function (line, i) {
      var html = highlightLine(line, lang).replace(/___(\d+)___/g, '<span class="gapslot" data-gap="$1"></span>');
      var row = el("div", { class: "row", "data-line": i + 1 });
      row.appendChild(el("span", { class: "ln" }, String(i + 1)));
      row.appendChild(el("span", { class: "src" }, html || " "));
      pre.appendChild(row);
    });
    return pre;
  }
  function langLabel(lang) { return lang === "erl" ? "OCR Exam Reference Language" : "C#"; }
  function enhanceTheory(root) {
    $all("pre[data-lang]", root).forEach(function (p) {
      var lang = p.getAttribute("data-lang");
      var wrap = el("div");
      if (p.hasAttribute("data-label")) wrap.appendChild(el("div", { class: "lang-label" }, esc(p.getAttribute("data-label") || langLabel(lang))));
      wrap.appendChild(codeBlock(p.textContent.replace(/^\n/, ""), lang, { lines: p.getAttribute("data-lines") !== "no" }));
      p.parentNode.replaceChild(wrap, p);
    });
  }

  /* ---------------- question types ---------------- */
  // Each type: label, tries(q), render(q, body), restore(q, body, resp), grade(q, body) -> result
  // result: { score, max, resp, feedback (html, shown on a wrong non-final try), final (html, shown when done) } or { error }
  function scale(correct, total, marks) { return total ? Math.floor(marks * correct / total) : 0; }

  var TYPES = {};

  TYPES.mcq = {
    label: "Multiple choice",
    tries: function (q) { return q.tries || (q.options.length <= 2 ? 1 : 2); },
    render: function (q, body) {
      var box = el("div", { class: "opts" });
      q.options.forEach(function (o, i) {
        var lab = el("label", { class: "opt" });
        lab.appendChild(el("input", { type: "radio", name: q.id, value: i }));
        lab.appendChild(el("span", null, o));
        box.appendChild(lab);
      });
      body.appendChild(box);
    },
    restore: function (q, body, resp) { if (resp != null) { var r = $('input[value="' + resp + '"]', body); if (r) r.checked = true; } },
    grade: function (q, body, final) {
      var r = $("input:checked", body);
      if (!r) return { error: "Choose an answer first." };
      var v = +r.value, ok = v === q.answer;
      $all(".opt", body).forEach(function (o) { o.classList.remove("wrong", "right"); });
      if (!ok) r.parentNode.classList.add("wrong");
      return { score: ok ? q.marks : 0, max: q.marks, resp: v };
    },
    reveal: function (q, body) { $all(".opt", body)[q.answer].classList.add("right"); }
  };

  TYPES.output = {
    label: "Predict the output",
    tries: function (q) { return q.tries || 2; },
    render: function (q, body) {
      body.appendChild(el("label", { class: "q-attempts" }, "Type exactly what appears on the screen. Put each line of output on a new line."));
      body.appendChild(el("textarea", { class: "out", spellcheck: "false", autocapitalize: "off", autocomplete: "off" }));
    },
    restore: function (q, body, resp) { if (resp != null) $("textarea", body).value = resp; },
    grade: function (q, body) {
      var raw = $("textarea", body).value;
      if (!raw.trim()) return { error: "Type the output first." };
      var a = normOut(raw), answers = [].concat(q.answer).map(normOut), ok = answers.indexOf(a) >= 0, fb = "";
      if (!ok) {
        var exp = answers[0];
        if (answers.some(function (x) { return x.toLowerCase() === a.toLowerCase(); })) fb = "Very close: check your capital letters. Output is copied exactly.";
        else if (answers.some(function (x) { return x.replace(/\s/g, "") === a.replace(/\s/g, ""); })) fb = "Very close: check your spaces and where each new line starts.";
        else {
          var n1 = a.split("\n").length, n2 = exp.split("\n").length;
          if (n1 !== n2) fb = "Your answer has " + plural(n1, "line") + ". The program prints " + plural(n2, "line") + ".";
        }
      }
      return { score: ok ? q.marks : 0, max: q.marks, resp: raw, feedback: fb };
    },
    reveal: function (q) { return "<p>The program prints:</p>" + codeBlock([].concat(q.answer)[0], "", { lines: false }).outerHTML; }
  };

  TYPES.gap = {
    label: "Fill the gaps",
    tries: function (q) { return q.tries || 2; },
    render: function (q, body) {
      var pre = codeBlock(q.code, q.lang || "cs");
      $all(".gapslot", pre).forEach(function (s) {
        var n = +s.getAttribute("data-gap");
        var inp = el("input", { type: "text", class: "gap", "data-gap": n, "aria-label": "Gap " + n, spellcheck: "false", autocapitalize: "off", autocomplete: "off", placeholder: String(n) });
        var minW = Math.max(6, (q.width && q.width[n - 1]) || 8);
        var grow = function () { inp.style.width = "calc(" + Math.max(minW, inp.value.length + 2) + "ch + 16px)"; };
        inp.addEventListener("input", grow); inp._grow = grow; grow();
        s.parentNode.replaceChild(inp, s);
      });
      body.appendChild(pre);
    },
    restore: function (q, body, resp) { if (resp) $all("input.gap", body).forEach(function (i, k) { i.value = resp[k] || ""; if (i._grow) i._grow(); }); },
    grade: function (q, body) {
      var inputs = $all("input.gap", body), resp = inputs.map(function (i) { return i.value; });
      if (resp.some(function (v) { return !v.trim(); })) return { error: "Fill in every gap first." };
      var right = 0;
      inputs.forEach(function (inp, k) {
        var g = q.gaps[k], acc = [].concat(g.accept || g), ci = g.ci;
        var v = normCode(inp.value), ok = acc.some(function (a) { return ci ? normCode(a).toLowerCase() === v.toLowerCase() : normCode(a) === v; });
        inp.classList.toggle("right", ok); inp.classList.toggle("wrong", !ok);
        if (ok) right++;
      });
      var marks = q.marks;
      return { score: scale(right, inputs.length, marks), max: marks, resp: resp, feedback: right + " of " + inputs.length + " gaps correct. The red gaps need another look." + (q.caseNote === false ? "" : " Remember that C# is case-sensitive.") };
    },
    reveal: function (q, body) {
      var wrong = [];
      $all("input.gap", body).forEach(function (inp, k) { if (inp.classList.contains("wrong")) wrong.push("Gap " + (k + 1) + ": <code>" + esc([].concat(q.gaps[k].accept || q.gaps[k])[0]) + "</code>"); });
      return wrong.length ? "<p>Correct answers: " + wrong.join(" · ") + "</p>" : "";
    }
  };

  TYPES.dropdown = {
    label: "Match up",
    tries: function (q) { return q.tries || 2; },
    render: function (q, body) {
      var box = el("div", { class: "dd" });
      var opts = q.shuffle === false ? q.options : seededShuffle(q.options, q.id);
      q.items.forEach(function (it, k) {
        box.appendChild(el("div", { class: q.plain ? "" : "item" }, q.plain ? it.t : esc(it.t)));
        var s = el("select", { "data-k": k, "aria-label": "Answer " + (k + 1) });
        s.appendChild(el("option", { value: "" }, "Choose…"));
        opts.forEach(function (o) { s.appendChild(el("option", { value: o, text: o })); });
        box.appendChild(s);
      });
      body.appendChild(box);
    },
    restore: function (q, body, resp) { if (resp) $all("select", body).forEach(function (s, k) { s.value = resp[k] || ""; }); },
    grade: function (q, body) {
      var sels = $all("select", body), resp = sels.map(function (s) { return s.value; });
      if (resp.some(function (v) { return !v; })) return { error: "Choose an answer for every row first." };
      var right = 0;
      sels.forEach(function (s, k) { var ok = s.value === q.items[k].a; s.classList.toggle("right", ok); s.classList.toggle("wrong", !ok); if (ok) right++; });
      return { score: scale(right, sels.length, q.marks), max: q.marks, resp: resp, feedback: right + " of " + sels.length + " correct. Look again at the red ones." };
    },
    reveal: function (q, body) {
      var wrong = [];
      $all("select", body).forEach(function (s, k) { if (s.classList.contains("wrong")) wrong.push((q.plain ? q.items[k].t : "<code>" + esc(q.items[k].t) + "</code>") + " → <code>" + esc(q.items[k].a) + "</code>"); });
      return wrong.length ? "<p>Correct answers:</p><ul><li>" + wrong.join("</li><li>") + "</li></ul>" : "";
    }
  };

  TYPES.trace = {
    label: "Trace table",
    tries: function (q) { return q.tries || 2; },
    render: function (q, body) {
      body.appendChild(codeBlock(q.code, q.lang || "cs"));
      var wrap = el("div", { class: "trace-wrap" }), t = el("table", { class: "trace" }), tr = el("tr");
      q.columns.forEach(function (c) { tr.appendChild(el("th", null, esc(c))); });
      t.appendChild(tr);
      q.rows.forEach(function (row, r) {
        var tr2 = el("tr");
        row.forEach(function (cell, c) {
          if (cell && typeof cell === "object") tr2.appendChild(el("td", { class: "given" }, esc(cell.g)));
          else {
            var td = el("td");
            td.appendChild(el("input", { type: "text", "data-r": r, "data-c": c, "aria-label": q.columns[c] + " row " + (r + 1), spellcheck: "false", autocapitalize: "off", autocomplete: "off" }));
            tr2.appendChild(td);
          }
        });
        t.appendChild(tr2);
      });
      wrap.appendChild(t);
      body.appendChild(wrap);
    },
    restore: function (q, body, resp) { if (resp) $all("td input", body).forEach(function (i, k) { i.value = resp[k] || ""; }); },
    grade: function (q, body) {
      var inputs = $all("td input", body), resp = inputs.map(function (i) { return i.value; });
      if (resp.every(function (v) { return !v.trim(); })) return { error: "Fill in the table first." };
      var right = 0, total = 0;
      inputs.forEach(function (inp) {
        var exp = q.rows[+inp.dataset.r][+inp.dataset.c];
        inp.classList.remove("right", "wrong");
        if (exp === "" ) { if (inp.value.trim()) inp.classList.add("wrong"); return; }
        total++;
        var ok = [].concat(exp).some(function (e) { return normCell(e) === normCell(inp.value); });
        inp.classList.add(ok ? "right" : "wrong");
        if (ok) right++;
      });
      var extra = $all("td input.wrong", body).filter(function (i) { return q.rows[+i.dataset.r][+i.dataset.c] === ""; }).length;
      var score = scale(Math.max(0, right - extra), total, q.marks);
      var fb = right + " of " + total + " values correct." + (extra ? " Some cells should be empty: only write a value when it changes on that line." : "");
      return { score: score, max: q.marks, resp: resp, feedback: fb };
    },
    reveal: function (q, body) {
      var t = "<table class='trace'><tr>" + q.columns.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>";
      q.rows.forEach(function (row) { t += "<tr>" + row.map(function (c) { return "<td>" + esc(c && typeof c === "object" ? c.g : [].concat(c)[0]) + "</td>"; }).join("") + "</tr>"; });
      return "<p>Completed trace table:</p><div class='trace-wrap'>" + t + "</table></div>";
    }
  };

  TYPES.parsons = {
    label: "Put the code in order",
    tries: function (q) { return q.tries || 3; },
    blocks: function (q) {
      var b = q.lines.map(function (t, i) { return { id: "L" + i, t: t }; });
      (q.distractors || []).forEach(function (t, i) { b.push({ id: "D" + i, t: t }); });
      return seededShuffle(b, q.id);
    },
    render: function (q, body) {
      var self = this, blocks = this.blocks(q);
      var grid = el("div", { class: "parsons" });
      var left = el("div"), right = el("div");
      left.appendChild(el("h4", null, "Code lines: click to add"));
      right.appendChild(el("h4", null, "Your program"));
      var pool = el("div", { class: "pool" }), built = el("div", { class: "built" });
      left.appendChild(pool); right.appendChild(built);
      grid.appendChild(left); grid.appendChild(right);
      body.appendChild(grid);
      body._blocks = blocks; body._order = [];
      body._redraw = function () { self.draw(q, body); };
      self.draw(q, body);
    },
    draw: function (q, body) {
      var pool = $(".pool", body), built = $(".built", body), order = body._order, locked = body._locked;
      pool.innerHTML = ""; built.innerHTML = "";
      body._blocks.forEach(function (b) {
        if (order.indexOf(b.id) >= 0) return;
        var d = el("div", { class: "pline", tabindex: locked ? "-1" : "0", role: "button" });
        d.appendChild(el("span", { class: "txt" }, highlightLine(b.t, q.lang || "cs")));
        if (!locked) {
          var add = function () { order.push(b.id); body._redraw(); };
          d.addEventListener("click", add);
          d.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); add(); } });
        }
        pool.appendChild(d);
      });
      if (!pool.children.length) pool.appendChild(el("div", { class: "empty-note" }, "All lines used. Any lines you do not need can be moved back."));
      order.forEach(function (id, k) {
        var b = body._blocks.filter(function (x) { return x.id === id; })[0];
        var d = el("div", { class: "pline" + (body._marks ? " " + body._marks[k] : "") });
        d.appendChild(el("span", { class: "txt" }, highlightLine(b.t, q.lang || "cs")));
        if (!locked) {
          var ctl = el("span", { class: "ctl" });
          var up = el("button", { type: "button", "aria-label": "Move up", title: "Move up" }, "↑");
          var dn = el("button", { type: "button", "aria-label": "Move down", title: "Move down" }, "↓");
          var rm = el("button", { type: "button", "aria-label": "Remove", title: "Remove" }, "✕");
          up.onclick = function () { if (k > 0) { order.splice(k - 1, 0, order.splice(k, 1)[0]); body._marks = null; body._redraw(); } };
          dn.onclick = function () { if (k < order.length - 1) { order.splice(k + 1, 0, order.splice(k, 1)[0]); body._marks = null; body._redraw(); } };
          rm.onclick = function () { order.splice(k, 1); body._marks = null; body._redraw(); };
          ctl.appendChild(up); ctl.appendChild(dn); ctl.appendChild(rm);
          d.appendChild(ctl);
        }
        built.appendChild(d);
      });
      if (!order.length) built.appendChild(el("div", { class: "empty-note" }, "Click lines on the left to build the program here."));
    },
    restore: function (q, body, resp) { if (resp) { body._order.length = 0; resp.forEach(function (x) { body._order.push(x); }); body._redraw(); } },
    grade: function (q, body) {
      var order = body._order.slice();
      if (!order.length) return { error: "Build your program first." };
      // compare by line text, so identical lines (for example two "}") are interchangeable
      var txt = {}; body._blocks.forEach(function (b) { txt[b.id] = b.t.trim(); });
      var got = order.map(function (id) { return txt[id]; });
      var target = q.lines.map(function (t) { return t.trim(); });
      var valid = [target].concat((q.alts || []).map(function (a) { return a.map(function (i) { return q.lines[i].trim(); }); }));
      var ok = valid.some(function (v) { return v.join("\n") === got.join("\n"); });
      var best = valid.reduce(function (acc, v) {
        var n = 0; got.forEach(function (t, k) { if (v[k] === t) n++; });
        return n > acc.n ? { n: n, v: v } : acc;
      }, { n: -1, v: target });
      var used = order.filter(function (id) { return id[0] === "D"; }).length;
      var fb = ok ? "" : best.n + " of " + target.length + " lines are in the right place." +
        (used ? " At least one line you used is not needed." : "") +
        (order.length < target.length ? " Some lines are missing." : "");
      body._best = best.v;
      return { score: ok ? q.marks : 0, max: q.marks, resp: order, feedback: fb };
    },
    reveal: function (q, body) {
      var v = body._best || q.lines.map(function (t) { return t.trim(); });
      var txt = {}; body._blocks.forEach(function (b) { txt[b.id] = b.t.trim(); });
      body._marks = body._order.map(function (id, k) { return v[k] === txt[id] ? "right" : "wrong"; });
      body._redraw();
      return "<p>A correct order:</p>" + codeBlock(q.lines.join("\n"), q.lang || "cs").outerHTML;
    },
    lock: function (q, body) { body._locked = true; body._redraw(); }
  };

  TYPES.bug = {
    label: "Find and fix the error",
    tries: function (q) { return q.tries || 2; },
    render: function (q, body) {
      var pre = codeBlock(q.code, q.lang || "cs");
      pre.classList.add("pick");
      body.appendChild(el("p", { class: "q-attempts" }, "1. Click the line that contains the error.  2. Rewrite that line correctly."));
      body.appendChild(pre);
      var lab = el("label", { class: "q-attempts" }, "Corrected line:");
      var inp = el("input", { type: "text", class: "mono fix", spellcheck: "false", autocapitalize: "off", autocomplete: "off", placeholder: "Click a line above first" });
      body.appendChild(lab); body.appendChild(inp);
      $all(".row", pre).forEach(function (row) {
        row.addEventListener("click", function () {
          if (body._locked) return;
          $all(".row", pre).forEach(function (r) { r.classList.remove("sel", "right", "wrong"); });
          row.classList.add("sel");
          body._sel = +row.dataset.line;
          inp.value = q.code.split("\n")[body._sel - 1].trim();
          inp.focus();
        });
      });
    },
    restore: function (q, body, resp) {
      if (!resp) return;
      body._sel = resp[0];
      var row = $('.row[data-line="' + resp[0] + '"]', body); if (row) row.classList.add("sel");
      $("input.fix", body).value = resp[1] || "";
    },
    grade: function (q, body) {
      var sel = body._sel, fix = $("input.fix", body).value;
      if (!sel) return { error: "Click the line with the error first." };
      var lineOk = sel === q.line;
      var fixOk = lineOk && [].concat(q.fix).some(function (f) { return normCode(f) === normCode(fix); });
      var row = $('.row[data-line="' + sel + '"]', body);
      row.classList.remove("sel"); row.classList.add(lineOk ? "right" : "wrong");
      var fb = lineOk ? (fixOk ? "" : "You found the right line, but your correction is not quite right.") : "That line is fine. Look for a different line.";
      return { score: (lineOk ? 1 : 0) + (fixOk ? 1 : 0), max: q.marks, resp: [sel, fix], feedback: fb };
    },
    reveal: function (q, body) {
      var row = $('.row[data-line="' + q.line + '"]', body); if (row) { row.classList.remove("wrong", "sel"); row.classList.add("right"); }
      return "<p>The error is on line " + q.line + ". A correct version:</p>" + codeBlock([].concat(q.fix)[0], q.lang || "cs", { lines: false }).outerHTML;
    }
  };

  TYPES.written = {
    label: "Exam-style answer",
    tries: function () { return 1; },
    render: function (q, body) {
      var ta = el("textarea", { class: "long" + (q.mono ? " mono" : ""), spellcheck: q.mono ? "false" : "true", autocapitalize: q.mono ? "off" : "sentences", placeholder: q.mono ? "Write your code here" : "Write your answer in full sentences" });
      var wc = el("div", { class: "wc" }, "0 words");
      ta.addEventListener("input", function () { wc.textContent = plural(wordCount(ta.value), "word"); });
      body.appendChild(ta); body.appendChild(wc);
      body.appendChild(el("p", { class: "q-attempts" }, "You get one attempt at this question. Check your answer before you submit."));
    },
    restore: function (q, body, resp) { if (resp != null) { $("textarea", body).value = resp; $(".wc", body).textContent = plural(wordCount(resp), "word"); } },
    grade: function (q, body) {
      var txt = $("textarea", body).value, min = q.minWords || (q.mono ? 4 : 8);
      if (wordCount(txt) < min) return { error: q.mono ? "Write your code first." : "Write a full answer first (at least " + min + " words)." };
      var hits = q.points.map(function (p) { return [].concat(p.match).some(function (rx) { return new RegExp(rx, "i").test(txt); }); });
      var n = hits.filter(Boolean).length;
      body._hits = hits;
      return { score: Math.min(q.marks, n), max: q.marks, resp: txt };
    },
    reveal: function (q, body) {
      var hits = body._hits || q.points.map(function (p) { return [].concat(p.match).some(function (rx) { return new RegExp(rx, "i").test($("textarea", body).value); }); });
      return "<p><strong>Mark points</strong> (" + plural(q.marks, "mark") + " available):</p><ul class='mp'>" +
        q.points.map(function (p, i) { return "<li class='" + (hits[i] ? "got" : "miss") + "'>" + p.text + "</li>"; }).join("") + "</ul>" +
        "<p class='q-attempts'>This answer was marked automatically by looking for key ideas. Your teacher can see what you wrote.</p>";
    }
  };

  /* ---------------- homework page ---------------- */
  var HW, KEY, state, questions = [];

  function blankState(prev) {
    return { ver: HW.version, student: prev && prev.student || store.get("y11cs:student"), run: prev ? (prev.run || 1) + 1 : 1, started: Date.now(), activeSec: 0, q: {}, finishedAt: null };
  }

  function save() { store.set(KEY, state); }

  function totals() {
    var s = 0, m = 0, done = 0;
    questions.forEach(function (q) { m += q.marks; var st = state.q[q.id]; if (st && st.done) { s += st.score; done++; } });
    return { score: s, max: m, done: done, count: questions.length, pct: m ? Math.round(100 * s / m) : 0 };
  }

  function updateProgress() {
    var t = totals();
    $("#progress-bar").style.width = (100 * t.done / t.count) + "%";
    $("#progress-label").textContent = t.done + " / " + t.count + " questions · " + t.score + " / " + t.max + " marks";
    $all(".side a[data-sec]").forEach(function (a) {
      var sec = HW.sections[+a.dataset.sec], d = 0, n = 0;
      sec._qs.forEach(function (q) { n++; if (state.q[q.id] && state.q[q.id].done) d++; });
      $(".sm", a).textContent = d + "/" + n;
    });
    renderFinish();
  }

  function renderQuestion(q, container) {
    var T = TYPES[q.type];
    var card = el("div", { class: "q", id: q.id });
    var head = el("div", { class: "q-head" });
    head.appendChild(el("span", null, '<span class="q-num">Q' + q.n + '</span> <span class="q-type">' + (q.label || T.label) + "</span>"));
    head.appendChild(el("span", { class: "q-marks" }, plural(q.marks, "mark")));
    card.appendChild(head);
    var pr = el("div", { class: "q-prompt" }, q.prompt); enhanceTheory(pr); card.appendChild(pr);
    if (q.code && q.type !== "gap" && q.type !== "trace" && q.type !== "bug") card.appendChild(codeBlock(q.code, q.lang || "cs"));
    var body = el("div", { class: "q-body" });
    card.appendChild(body);
    T.render(q, body);
    var actions = el("div", { class: "q-actions" });
    var btn = el("button", { type: "button", class: "check" }, "Check answer");
    var info = el("span", { class: "q-attempts" });
    actions.appendChild(btn); actions.appendChild(info);
    card.appendChild(actions);
    var fb = el("div", { class: "q-fb", "aria-live": "polite" });
    card.appendChild(fb);
    container.appendChild(card);

    var maxTries = T.tries(q);
    function st() { return state.q[q.id] || (state.q[q.id] = { tries: 0, done: false, score: 0 }); }
    function showInfo() {
      var s = st();
      info.textContent = s.done ? "" : (maxTries === 1 ? "One attempt" : (maxTries - s.tries) + " of " + maxTries + " attempts left");
    }
    function finalise(res, quiet) {
      var s = st();
      s.done = true; s.score = res.score;
      body._locked = true;
      $all("input, textarea, select", body).forEach(function (i) { i.disabled = true; });
      if (T.lock) T.lock(q, body);
      btn.disabled = true; btn.style.display = "none";
      card.classList.add("done", res.score === q.marks ? "full" : res.score > 0 ? "part" : "zero");
      var verdict = res.score === q.marks ? "Correct" : res.score > 0 ? "Partly correct" : "Not correct this time";
      var cls = res.score === q.marks ? "ok" : res.score > 0 ? "part" : "no";
      var reveal = T.reveal ? (T.reveal(q, body) || "") : "";
      fb.className = "q-fb fb " + cls;
      fb.innerHTML = "<strong class='v'>" + verdict + " · " + res.score + " / " + q.marks + "</strong>" +
        (res.score < q.marks || q.type === "written" ? reveal : "") + (q.explain ? "<div>" + q.explain + "</div>" : "");
      enhanceTheory(fb);
      showInfo();
      if (!quiet) { save(); updateProgress(); }
    }
    btn.addEventListener("click", function () {
      var s = st();
      if (s.done) return;
      var res = T.grade(q, body);
      if (res.error) { fb.className = "q-fb fb hint"; fb.textContent = res.error; return; }
      s.tries++; s.resp = res.resp; s.last = res.score;
      if (res.score === q.marks || s.tries >= maxTries) { s.final = res; finalise(res); return; }
      fb.className = "q-fb fb no";
      fb.innerHTML = "<strong class='v'>Not quite. Try again.</strong>" + (res.feedback ? "<p>" + res.feedback + "</p>" : "") + (q.hint ? "<p><strong>Hint:</strong> " + q.hint + "</p>" : "");
      enhanceTheory(fb);
      showInfo(); save();
    });
    // restore saved state
    var s = state.q[q.id];
    if (s && s.resp != null) {
      T.restore(q, body, s.resp);
      if (s.done) {
        // re-run grading silently to recolour the inputs, then lock
        var res = T.grade(q, body);
        res = res && !res.error ? res : { score: s.score };
        res.score = s.score;
        finalise(res, true);
      }
    }
    showInfo();
  }

  function renderFinish() {
    var box = $("#finish"), t = totals();
    if (!box) return;
    var home = "<div class='q-actions'><a class='btn' href='index.html'>Return to homepage</a></div>";
    if (t.done < t.count) {
      box.innerHTML = "<h2 style='border:0;margin:0 0 8px;padding:0'>Finish</h2><p>You have answered " + t.done + " of " + t.count + " questions. Answer them all to see your result. Your progress is saved, so you can come back later.</p>" + home;
      return;
    }
    if (!state.finishedAt) { state.finishedAt = Date.now(); save(); }
    var passed = t.pct >= PASS_PERCENT;
    var html = "<h2 style='border:0;margin:0 0 8px;padding:0'>Your result</h2>" +
      "<div class='big'>" + t.score + " / " + t.max + " (" + t.pct + "%)</div>";
    html += "<table>" + HW.sections.map(function (sec) {
      var s = 0, m = 0; sec._qs.forEach(function (q) { m += q.marks; s += (state.q[q.id] || {}).score || 0; });
      return "<tr><td>" + esc(sec.title) + "</td><td>" + s + " / " + m + "</td></tr>";
    }).join("") + "</table>";
    if (passed) {
      html += "<p>Well done. You reached the " + PASS_PERCENT + "% needed, so this homework is <strong>complete</strong>. Your result is saved in this browser. Return to the homepage to download your report, then hand it in on the Teams assignment.</p>" + home;
    } else {
      html += "<p>You need <strong>" + PASS_PERCENT + "%</strong> for this homework to count as complete on your report. Re-read the theory for the sections where you dropped marks, then start the homework again. Your teacher will see how many attempts you took.</p>" +
        "<div class='q-actions'><button type='button' id='restart' class='secondary'>Start the homework again</button><a class='btn' href='index.html'>Return to homepage</a></div>";
    }
    box.innerHTML = html;
    var rs = $("#restart", box);
    if (rs) rs.onclick = function () {
      if (rs.dataset.armed) { state = blankState(state); save(); location.hash = ""; location.reload(); return; }
      rs.dataset.armed = "1"; rs.textContent = "Click again to clear your answers and restart";
    };
  }

  function askStudent(force) {
    var s = state.student;
    if (s && s.first && s.last && s.form && !force) return;
    var bg = el("div", { class: "modal-bg" });
    var m = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "mh" });
    m.innerHTML = "<h2 id='mh'>Before you start</h2><p>Your name goes on the report you hand in, so type it exactly as your teacher knows you.</p>" +
      "<label for='sf'>First name</label><input type='text' id='sf' autocomplete='given-name'>" +
      "<label for='sl'>Surname</label><input type='text' id='sl' autocomplete='family-name'>" +
      "<label for='sg'>Form or class (for example 11X)</label><input type='text' id='sg'>" +
      "<div class='err' id='se'></div><div class='q-actions'><button type='button' id='sgo'>Start</button></div>";
    bg.appendChild(m); document.body.appendChild(bg);
    if (s) { $("#sf").value = s.first || ""; $("#sl").value = s.last || ""; $("#sg").value = s.form || ""; }
    $("#sf").focus();
    $("#sgo").onclick = function () {
      var f = $("#sf").value.trim(), l = $("#sl").value.trim(), g = $("#sg").value.trim().toUpperCase();
      if (!f || !l || !g) { $("#se").textContent = "Fill in all three boxes."; return; }
      state.student = { first: f, last: l, form: g };
      store.set("y11cs:student", state.student);
      save(); bg.remove(); showWho();
    };
    m.addEventListener("keydown", function (e) { if (e.key === "Enter") $("#sgo").click(); });
  }
  function showWho() {
    var w = $("#who"), s = state.student;
    w.innerHTML = s ? esc(s.first + " " + s.last + " · " + s.form) + " <a href='#' id='editwho' style='text-decoration:underline;font-weight:400'>change</a>" : "";
    var e = $("#editwho"); if (e) e.onclick = function (ev) { ev.preventDefault(); askStudent(true); };
  }

  function trackTime() {
    var last = Date.now();
    ["click", "keydown", "scroll", "touchstart", "input"].forEach(function (ev) { document.addEventListener(ev, function () { last = Date.now(); }, { passive: true }); });
    setInterval(function () {
      if (document.visibilityState === "visible" && Date.now() - last < 120000 && !state.finishedAt) { state.activeSec += 15; save(); }
    }, 15000);
  }

  /* ---------------- PDF report ---------------- */
  function latin(s) {
    return String(s == null ? "" : s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-")
      .replace(/\u2026/g, "...").replace(/\u2192/g, "->").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
  }
  function plain(html) { var d = document.createElement("div"); d.innerHTML = String(html).replace(/<svg[\s\S]*?<\/svg>/gi, " [diagram] ").replace(/<(\/p|\/li|br|pre|\/pre|ul|\/ul)\b[^>]*>/gi, " $&"); return (d.textContent || "").replace(/\s+/g, " ").trim(); }

  /* ---------------- homepage: progress and the combined report ---------------- */
  var REG = {}; // id -> decoded homework

  function summarise(hw) {
    var qs = [], n = 0;
    hw.sections.forEach(function (sec) {
      sec._qs = [];
      (sec.questions || []).forEach(function (q) { n++; q.n = n; q.id = "q" + n; q.marks = q.marks || 1; sec._qs.push(q); qs.push(q); });
    });
    var st = store.get("y11cs:hw" + hw.id);
    if (st && st.ver !== hw.version) st = null;
    var s = 0, m = 0, done = 0;
    qs.forEach(function (q) { m += q.marks; var x = st && st.q && st.q[q.id]; if (x && x.done) { s += x.score; done++; } });
    var pct = m ? Math.round(100 * s / m) : 0, finished = !!st && done === qs.length;
    var status = !st || done === 0 ? "Not started" : !finished ? "In progress (" + done + " of " + qs.length + " answered)" : pct >= PASS_PERCENT ? "Complete" : "Below " + PASS_PERCENT + "%: not complete";
    return { hw: hw, qs: qs, st: st, score: s, max: m, pct: pct, done: done, finished: finished, passed: finished && pct >= PASS_PERCENT, status: status };
  }

  function reportCode(student, sums) {
    var payload = {
      v: 2, n: student.first + " " + student.last, f: student.form, d: new Date().toISOString(),
      h: sums.filter(function (x) { return x.finished; }).map(function (x) {
        return [x.hw.id, x.score, x.max, x.st.run || 1, Math.round((x.st.activeSec || 0) / 60), new Date(x.st.finishedAt || Date.now()).toISOString(), x.passed ? 1 : 0];
      })
    };
    var body = b64urlEncode(JSON.stringify(payload));
    return body + "." + cyrb53(body + SECRET).toString(36).toUpperCase();
  }

  function fmtDate(t) {
    var d = new Date(t);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  function makeReport(student, sums) {
    if (!window.jspdf) { alert("The PDF tool did not load. Refresh the page and try again."); return; }
    var doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    var W = 210, M = 16, y = 18, lh = 5;
    var INK = [27, 34, 51], MUTED = [91, 100, 120];
    function need(h) { if (y + h > 282) { doc.addPage(); y = 18; } }
    function text(str, size, style, color, indent) {
      doc.setFont("helvetica", style || "normal"); doc.setFontSize(size || 10); doc.setTextColor.apply(doc, color || INK);
      doc.splitTextToSize(latin(str), W - 2 * M - (indent || 0)).forEach(function (ln) { need(lh); doc.text(ln, M + (indent || 0), y); y += size > 12 ? size * 0.45 : lh; });
    }
    function cell(str, x, opts) { doc.text(latin(str), x, y, opts || {}); }
    var complete = sums.filter(function (x) { return x.passed; });

    doc.setFillColor(31, 58, 109); doc.rect(0, 0, W, 30, "F");
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(16);
    doc.text("Year 11 C# Programming - Homework report", M, 13);
    doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    doc.text("OCR J277 Paper 2: algorithms and programming", M, 21);
    y = 40;
    [["Student", student.first + " " + student.last], ["Form", student.form], ["Report created", fmtDate(Date.now())],
     ["Homeworks complete", complete.length + " of " + sums.length + " (" + PASS_PERCENT + "% or more)"]].forEach(function (r) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor.apply(doc, MUTED); doc.text(r[0], M, y);
      doc.setFont("helvetica", "normal"); doc.setTextColor.apply(doc, INK); doc.text(latin(r[1]), M + 44, y); y += 7;
    });

    // summary table
    y += 3; text("Summary", 12, "bold"); y += 1;
    doc.setFontSize(8.5); doc.setFont("helvetica", "bold"); doc.setTextColor.apply(doc, MUTED);
    var cx = { n: M + 1, t: M + 9, s: M + 98, sc: W - M - 46, a: W - M - 32, d: W - M };
    cell("HW", cx.n); cell("Title", cx.t); cell("Status", cx.s); cell("Score", cx.sc, { align: "right" }); cell("Att.", cx.a, { align: "right" }); cell("Completed", cx.d, { align: "right" }); y += lh;
    doc.setFont("helvetica", "normal"); doc.setTextColor.apply(doc, INK);
    sums.forEach(function (x, i) {
      need(lh);
      if (i % 2 === 0) { doc.setFillColor(243, 245, 249); doc.rect(M, y - 3.6, W - 2 * M, lh, "F"); }
      var title = doc.splitTextToSize(latin(x.hw.title), cx.s - cx.t - 3)[0];
      var stat = x.passed ? "Complete" : x.finished ? "Below " + PASS_PERCENT + "%" : x.done ? "In progress" : "Not started";
      cell(String(x.hw.number), cx.n); cell(title, cx.t);
      doc.setFont("helvetica", x.passed ? "bold" : "normal"); cell(stat, cx.s); doc.setFont("helvetica", "normal");
      cell(x.done ? x.score + "/" + x.max + " (" + x.pct + "%)" : "-", cx.sc, { align: "right" });
      cell(x.st ? String(x.st.run || 1) : "-", cx.a, { align: "right" });
      cell(x.finished ? new Date(x.st.finishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "-", cx.d, { align: "right" });
      y += lh;
    });

    // detail for each complete homework
    complete.forEach(function (x) {
      var hw = x.hw, st = x.st;
      y += 6; need(40);
      doc.setDrawColor(201, 154, 46); doc.setLineWidth(0.6); doc.line(M, y - 4, W - M, y - 4);
      text("Homework " + hw.number + ": " + hw.title + " (J277 " + hw.spec + ")", 12.5, "bold");
      text("Score " + x.score + " / " + x.max + " (" + x.pct + "%)  ·  Completed " + fmtDate(st.finishedAt) + "  ·  Active time " + plural(Math.max(1, Math.round((st.activeSec || 0) / 60)), "minute") + "  ·  Attempt " + (st.run || 1), 9.5, "normal", MUTED);
      y += 1;
      hw.sections.forEach(function (sec) {
        var sc = 0, m = 0; sec._qs.forEach(function (q) { m += q.marks; sc += (st.q[q.id] || {}).score || 0; });
        need(lh); doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor.apply(doc, INK);
        doc.text(latin(sec.title), M + 2, y); doc.text(sc + " / " + m, W - M, y, { align: "right" }); y += lh - 0.4;
      });
      y += 2;
      doc.setFontSize(8.5); doc.setFont("helvetica", "bold"); doc.setTextColor.apply(doc, MUTED);
      need(lh); cell("Q", M + 2); cell("Type", M + 12); cell("Tries", W - M - 22, { align: "right" }); cell("Marks", W - M, { align: "right" }); y += lh - 0.5;
      doc.setFont("helvetica", "normal"); doc.setTextColor.apply(doc, INK);
      x.qs.forEach(function (q, i) {
        var r = st.q[q.id] || {};
        need(lh);
        if (i % 2 === 0) { doc.setFillColor(243, 245, 249); doc.rect(M, y - 3.4, W - 2 * M, lh - 0.5, "F"); }
        cell("Q" + q.n, M + 2); cell(q.label || TYPES[q.type].label, M + 12);
        cell(String(r.tries || 0), W - M - 22, { align: "right" }); cell((r.score || 0) + " / " + q.marks, W - M, { align: "right" }); y += lh - 0.5;
      });
      x.qs.filter(function (q) { return q.type === "written"; }).forEach(function (q) {
        var r = st.q[q.id] || {};
        y += 2; need(14);
        text("Q" + q.n + ". " + plain(q.prompt), 9, "bold");
        doc.setFont(q.mono ? "courier" : "helvetica", "normal"); doc.setFontSize(9); doc.setTextColor.apply(doc, INK);
        String(r.resp || "").replace(/\r/g, "").split("\n").forEach(function (para) {
          doc.splitTextToSize(latin(para) || " ", W - 2 * M - 4).forEach(function (ln) { need(lh); doc.text(ln, M + 4, y); y += lh - 0.8; });
        });
        text("Auto-mark: " + (r.score || 0) + " / " + q.marks, 8.5, "italic", MUTED, 4);
      });
    });

    y += 6; need(30);
    doc.setDrawColor(201, 154, 46); doc.setLineWidth(0.6); doc.line(M, y, W - M, y); y += 6;
    text("Verification code (for your teacher)", 10, "bold");
    doc.setFont("courier", "normal"); doc.setFontSize(8); doc.setTextColor.apply(doc, INK);
    doc.splitTextToSize(reportCode(student, sums), W - 2 * M).forEach(function (ln) { need(4); doc.text(ln, M, y); y += 3.8; });
    y += 2;
    text("Teachers: paste this code into the Verify page on the homework site to confirm the report has not been edited.", 8.5, "italic", MUTED);
    doc.save("Y11-CS-Homework_" + (student.last + "_" + student.first).replace(/[^A-Za-z0-9]+/g, "-") + "_" + student.form.replace(/[^A-Za-z0-9]+/g, "") + ".pdf");
  }

  function renderHome() {
    var list = $("#list"), box = $("#report");
    var sums = (window.HOMEWORKS || []).filter(function (h) { return h.ready && REG[h.id]; }).map(function (h) { return summarise(REG[h.id]); });
    list.innerHTML = "";
    (window.HOMEWORKS || []).forEach(function (h) {
      var x = sums.filter(function (s) { return s.hw.id === h.id; })[0];
      var li = el("li");
      var badge = !x ? "" : x.passed ? "<span class='badge ok'>Complete · " + x.pct + "%</span>" : x.finished ? "<span class='badge bad'>Below " + PASS_PERCENT + "% · " + x.pct + "%</span>" : x.done ? "<span class='badge'>" + x.done + " of " + x.qs.length + " answered</span>" : "";
      li.innerHTML = '<span class="n">' + Number(h.id) + '</span><span class="t">' +
        (x ? '<a href="homework.html?hw=' + h.id + '">' + esc(h.title) + '</a>' : esc(h.title)) + '<small>J277 ' + h.spec + '</small></span>' +
        (x ? badge : '<span class="soon">Coming soon</span>');
      list.appendChild(li);
    });
    var student = store.get("y11cs:student") || {};
    var complete = sums.filter(function (x) { return x.passed; }).length;
    box.innerHTML = "<h2 style='border:0;margin:0 0 6px;padding:0'>Download your report</h2>" +
      "<p>One PDF with all your homework results. Each homework counts as complete once you score " + PASS_PERCENT + "% or more. Download a new copy each time you finish a homework, and hand it in on the Teams assignment.</p>" +
      "<div class='row3'><div><label for='rf'>First name</label><input type='text' id='rf' autocomplete='given-name'></div>" +
      "<div><label for='rl'>Surname</label><input type='text' id='rl' autocomplete='family-name'></div>" +
      "<div><label for='rg'>Form</label><input type='text' id='rg'></div></div>" +
      "<p class='q-attempts' id='rsum'>Homeworks complete: <strong>" + complete + " of " + sums.length + "</strong></p>" +
      "<div class='err' id='rerr'></div>" +
      "<div class='q-actions'><button type='button' id='rdl'" + (complete ? "" : " disabled") + ">Download report (PDF)</button>" +
      (complete ? "" : "<span class='q-attempts'>Complete at least one homework to unlock your report.</span>") + "</div>";
    $("#rf").value = student.first || ""; $("#rl").value = student.last || ""; $("#rg").value = student.form || "";
    $("#rdl").onclick = function () {
      var s = { first: $("#rf").value.trim(), last: $("#rl").value.trim(), form: $("#rg").value.trim().toUpperCase() };
      if (!s.first || !s.last || !s.form) { $("#rerr").textContent = "Fill in your first name, surname and form."; return; }
      $("#rerr").textContent = "";
      store.set("y11cs:student", s);
      makeReport(s, sums);
    };
  }

  function buildPage() {
    document.title = "HW" + HW.number + ": " + HW.title + " · Year 11 C#";
    var main = $("#main"), side = $("#side");
    main.innerHTML = "";
    main.appendChild(el("h1", null, "Homework " + HW.number + ": " + esc(HW.title)));
    main.appendChild(el("p", { class: "lede" }, HW.intro || ""));
    var meta = el("div", { class: "meta" });
    ["OCR J277 " + HW.spec, HW.minutes + " minutes", "Language: C#", "Pass mark: " + PASS_PERCENT + "%"].forEach(function (p) { meta.appendChild(el("span", { class: "pill" }, esc(p))); });
    main.appendChild(meta);
    if (HW.howTo) { var how = el("div", { class: "card" }, HW.howTo); main.appendChild(how); }
    var ol = el("ol"), n = 0;
    HW.sections.forEach(function (sec, si) {
      sec._qs = [];
      var sid = "s" + (si + 1);
      var li = el("li"); li.appendChild(el("a", { href: "#" + sid, "data-sec": si }, esc(sec.title) + ' <span class="sm"></span>')); ol.appendChild(li);
      main.appendChild(el("h2", { id: sid }, (si + 1) + ". " + esc(sec.title)));
      if (sec.theory) { var th = el("div", { class: "theory" }, sec.theory); enhanceTheory(th); main.appendChild(th); }
      (sec.questions || []).forEach(function (q) {
        n++; q.n = n; q.id = "q" + n; q.marks = q.marks || 1;
        if (!TYPES[q.type]) { console.warn("Unknown type", q.type); return; }
        sec._qs.push(q); questions.push(q);
        renderQuestion(q, main);
      });
    });
    var li2 = el("li"); li2.appendChild(el("a", { href: "#finish" }, "Finish")); ol.appendChild(li2);
    side.appendChild(ol);
    main.appendChild(el("div", { class: "finish", id: "finish" }));
    showWho(); updateProgress();
  }

  window.HW_ENGINE = {
    load: function (a, b) {
      var id = b === undefined ? (new URLSearchParams(location.search).get("hw") || "").replace(/\D/g, "") : a;
      var encoded = b === undefined ? a : b;
      var data;
      try { data = decodeContent(encoded, id); } catch (e) { if (PAGE === "homework") $("#main").innerHTML = "<p>Sorry, this homework could not be loaded.</p>"; return; }
      if (PAGE === "home") { REG[id] = data; return; }
      HW = data;
      KEY = "y11cs:hw" + HW.id;
      state = store.get(KEY);
      if (!state || state.ver !== HW.version) { var keepStudent = state && state.student; state = blankState(null); if (keepStudent) state.student = keepStudent; save(); }
      buildPage(); trackTime(); askStudent(false);
    },
    // used by verify.html
    verify: function (code) {
      code = String(code || "").replace(/\s+/g, "");
      var parts = code.split(".");
      if (parts.length !== 2) return { ok: false, error: "That does not look like a verification code." };
      var sig = cyrb53(parts[0] + SECRET).toString(36).toUpperCase();
      var data = null;
      try { data = JSON.parse(b64urlDecode(parts[0])); } catch (e) { return { ok: false, error: "The code is damaged or incomplete. Copy all of it, including the part after the dot." }; }
      return { ok: sig === parts[1], data: data };
    },
    highlight: codeBlock,
    enhance: enhanceTheory
  };

  var PAGE = document.body && document.body.dataset.page;
  // homework page bootstrap
  if (PAGE === "homework") {
    var id = (new URLSearchParams(location.search).get("hw") || "").replace(/\D/g, "");
    if (!id) { $("#main").innerHTML = "<p>No homework chosen. <a href='index.html'>Back to the list</a>.</p>"; }
    else {
      var sc = document.createElement("script");
      sc.src = "content/hw" + id + ".js";
      sc.onerror = function () { $("#main").innerHTML = "<p>That homework is not available yet. <a href='index.html'>Back to the list</a>.</p>"; };
      document.body.appendChild(sc);
    }
  }
  // homepage bootstrap: load every homework so progress and the report can be worked out
  if (PAGE === "home") {
    var ready = (window.HOMEWORKS || []).filter(function (h) { return h.ready; }), left = ready.length;
    if (!left) renderHome();
    ready.forEach(function (h) {
      var s = document.createElement("script");
      s.src = "content/hw" + h.id + ".js";
      s.onload = s.onerror = function () { if (--left === 0) renderHome(); };
      document.body.appendChild(s);
    });
  }
})();
