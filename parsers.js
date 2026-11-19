/* Leitura de extratos: OFX e PDF. Funções puras (testáveis fora do navegador). */
(function (root) {
  const pad = (n) => String(n).padStart(2, "0");

  // "1.234,56" | "1,234.56" | "-12,5" | "(12,50)" -> número
  function parseAmount(s) {
    s = String(s).trim();
    let neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s);
    s = s.replace(/[^\d.,]/g, "");
    if (!s) return NaN;
    const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
    if (lc > -1 && ld > -1) {
      if (lc > ld) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (lc > -1) {
      s = s.replace(",", ".");
    } else if (ld > -1) {
      // só ponto: "1.234" (milhar) vs "12.50" (decimal)
      if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    }
    const v = parseFloat(s);
    return neg ? -v : v;
  }

  /* ----------------------------- OFX ----------------------------- */
  function decodeBuffer(buf) {
    const u8 = new Uint8Array(buf);
    const head = new TextDecoder("latin1").decode(u8.slice(0, 600));
    const m = head.match(/CHARSET:\s*(\w+)/i);
    let enc = m && m[1] === "1252" ? "windows-1252" : "utf-8";
    let txt = new TextDecoder(enc).decode(u8);
    if (enc === "utf-8" && txt.includes("�")) txt = new TextDecoder("windows-1252").decode(u8);
    return txt;
  }

  function parseOFX(text) {
    const tag = (blk, name) => {
      const r = new RegExp("<" + name + ">([^<\\r\\n]*)", "i").exec(blk);
      return r ? r[1].trim() : "";
    };
    const decodeEnt = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    const isCard = /<CCSTMTRS|<CREDITCARDMSGSRSV1/i.test(text);
    const bankId = tag(text, "BANKID"), acctId = tag(text, "ACCTID"), org = tag(text, "ORG");
    const blocks = text.split(/<STMTTRN>/i).slice(1);
    const items = [];
    for (const raw of blocks) {
      const blk = raw.split(/<\/STMTTRN>/i)[0];
      const dt = tag(blk, "DTPOSTED");
      const amtRaw = tag(blk, "TRNAMT");
      if (!dt || !amtRaw) continue;
      const value = amtRaw.includes(",") ? parseAmount(amtRaw) : parseFloat(amtRaw);
      if (isNaN(value)) continue;
      const name = decodeEnt(tag(blk, "NAME")), memo = decodeEnt(tag(blk, "MEMO"));
      const desc = [name, memo && memo !== name ? memo : ""].filter(Boolean).join(" - ") || tag(blk, "TRNTYPE") || "Lançamento";
      items.push({
        date: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`,
        desc: desc.replace(/\s+/g, " "),
        value,
        fitid: tag(blk, "FITID"),
        doc: tag(blk, "CHECKNUM") || tag(blk, "REFNUM"),
      });
    }
    return { kind: isCard ? "cartao" : "banco", bankId, acctId, org, items };
  }

  /* ----------------------------- PDF ----------------------------- */
  const DATE_RE = /^(\d{2})\/(\d{2})(?:\/(\d{2,4}))?\b/;
  const AMT_RE = /(-?\(?\s*R?\$?\s*\d{1,3}(?:\.\d{3})*,\d{2}\s*\)?-?)\s*([CD])?\s*$/i;
  const NEG_WORDS = /(pix\s*(enviado|enviada|pago|transf)|pagamento|pagto|compra|d[eé]bito|saque|tarifa|taxa|boleto|transfer[eê]ncia\s*(enviada|para)|ted\s*enviada|iof|juros|anuidade)/i;
  const POS_WORDS = /(pix\s*(recebido|recebida)|cr[eé]dito|dep[oó]sito|recebid|estorno|rendimento|sal[aá]rio|transfer[eê]ncia\s*(recebida|de)|ted\s*recebida)/i;
  const SKIP = /(saldo\s*(anterior|do dia|final|inicial|dispon[ií]vel|em conta|total)|total\s*(de|das)?\s*(entradas|sa[ií]das|cr[eé]ditos|d[eé]bitos)|limite|extrato|ag[eê]ncia|conta\s*corrente)/i;

  // linhas de texto: itens agrupados pela coordenada Y e ordenados por X
  function itemsToLines(items) {
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5], x = it.transform[4];
      let row = rows.find((r) => Math.abs(r.y - y) < 3);
      if (!row) { row = { y, parts: [] }; rows.push(row); }
      row.parts.push({ x, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(" ").replace(/\s+/g, " ").trim());
  }

  function parsePdfLines(lines, defaultYear) {
    let year = defaultYear;
    const ym = lines.join(" ").match(/\b(?:per[ií]odo|extrato|fatura)[^\d]{0,30}\d{2}\/\d{2}\/(\d{4})/i);
    if (ym) year = parseInt(ym[1], 10);
    const items = [];
    let carry = ""; // descrição que veio em linha separada antes da linha com data
    for (let line of lines) {
      const d = DATE_RE.exec(line);
      const a = AMT_RE.exec(line);
      if (!d || !a) {
        // linha de continuação de descrição: anexa ao último lançamento se não tiver data/valor
        if (!d && !a && items.length && !items[items.length - 1].cont && line.length < 60 &&
            !SKIP.test(line) && !/p[aá]gina|p[aá]g\.|saldo|total/i.test(line)) {
          items[items.length - 1].desc += " " + line; items[items.length - 1].cont = true;
        }
        continue;
      }
      if (SKIP.test(line)) continue;
      let desc = line.slice(d[0].length, line.length - a[0].length).replace(/\s+/g, " ").trim();
      // remove segunda data (data de lançamento/efetivação) no início da descrição
      desc = desc.replace(/^\d{2}\/\d{2}(\/\d{2,4})?\s+/, "").trim();
      if (!desc) desc = "Lançamento";
      let value = parseAmount(a[1]);
      if (isNaN(value)) continue;
      const hasSign = /-|\(/.test(a[1]);
      const cd = (a[2] || "").toUpperCase();
      let certain = true;
      if (cd === "D") value = -Math.abs(value);
      else if (cd === "C") value = Math.abs(value);
      else if (hasSign) value = -Math.abs(value);
      else if (POS_WORDS.test(desc)) value = Math.abs(value);
      else if (NEG_WORDS.test(desc)) value = -Math.abs(value);
      else { value = -Math.abs(value); certain = false; }
      const dd = parseInt(d[1], 10), mm = parseInt(d[2], 10);
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
      let yy = d[3] ? parseInt(d[3], 10) : year;
      if (yy < 100) yy += 2000;
      items.push({ date: `${yy}-${pad(mm)}-${pad(dd)}`, desc, value, fitid: "", doc: "", uncertain: !certain, cont: false });
    }
    return items;
  }

  async function parsePDF(buf, pdfjsLib, defaultYear) {
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      lines.push(...itemsToLines(tc.items));
    }
    const items = parsePdfLines(lines, defaultYear);
    return { kind: "banco", items, lineCount: lines.length };
  }

  root.MMParsers = { parseAmount, parseOFX, parsePDF, parsePdfLines, decodeBuffer };
  if (typeof module !== "undefined") module.exports = root.MMParsers;
})(typeof window !== "undefined" ? window : globalThis);
