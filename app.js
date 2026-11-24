/* FinForme — Controle financeiro do cliente */
const VERSION = "1.6.1";
const { useState, useEffect, useMemo, useRef } = React;
const html = htm.bind(React.createElement);
const I = {};
Object.keys(ICON_PATHS).forEach((k) => (I[k] = mkIcon(k)));
const P = window.MMParsers;
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "./lib/pdf.worker.js";

const C = {
  bg: "#F4F8FA", card: "#FFFFFF", text: "#0F3D47", textSec: "#4F6F77",
  peach: "#2F6FDE", peachDark: "#1B4DB3", soft: "#CFE0E6", teal: "#1F6B66",
  tealLight: "#6FA9B3", alerta: "#C0443C", borda: "#DAE6EA",
};
const DEFAULT_CATS = [
  { key: "vendas", label: "Vendas / Serviços prestados", kind: "receita" },
  { key: "fornecedores", label: "Fornecedores / Compras" },
  { key: "folha", label: "Folha de pagamento / Pró-labore" },
  { key: "encargos", label: "Impostos e encargos (DAS, FGTS, INSS)" },
  { key: "aluguel", label: "Aluguel e condomínio" },
  { key: "utilidades", label: "Energia, água, internet, telefone" },
  { key: "marketing", label: "Marketing e publicidade" },
  { key: "terceiros", label: "Serviços de terceiros (contador, etc.)" },
  { key: "transporte", label: "Combustível, frete e transporte" },
  { key: "manutencao", label: "Manutenção e equipamentos" },
  { key: "tarifas", label: "Tarifas bancárias e juros" },
  { key: "financiamentos", label: "Empréstimos e financiamentos" },
  { key: "retirada", label: "Retirada dos sócios" },
  { key: "transferencia", label: "Transferência (não conta)", kind: "transf" },
  { key: "outros", label: "Outros" },
];
const LEGACY_CAT = { receita: "vendas", moradia: "aluguel", alimentacao: "outros", saude: "outros", educacao: "outros", lazer: "outros", impostos: "encargos", pessoal: "retirada" };
DEFAULT_CATS.forEach((c) => { c.kind = c.kind || "despesa"; });
let CATS = DEFAULT_CATS;
const catLabel = (k) => (CATS.find((c) => c.key === k) || { label: "Sem categoria" }).label;
const METHODS = { banco: "Banco", dinheiro: "Dinheiro", pix: "PIX", cartao: "Cartão" };
const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const STORE = "finforme-data";
const OLD_STORE = "meumes-clientes-data";

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const fmt = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const pad = (n) => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowKey = () => todayStr().slice(0, 7);
const monthLabel = (k) => `${MONTHS[parseInt(k.slice(5), 10) - 1]} de ${k.slice(0, 4)}`;
const shiftMonth = (k, d) => { const dt = new Date(+k.slice(0, 4), +k.slice(5) - 1 + d, 1); return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`; };
const monthDiff = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5) - +a.slice(5));
const brDate = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function initialState() {
  return {
    version: 2,
    client: { name: "", doc: "" },
    banks: [], cashInitial: 0,
    tx: [], card: { name: "", limit: 0, closingDay: 20, dueDay: 28 },
    purchases: [], cardPaid: {}, budgets: {}, goals: [], rules: [], recEnded: {}, categories: DEFAULT_CATS,
  };
}
function migrate(s) {
  const o = { ...initialState(), ...s };
  const fix = (k) => (LEGACY_CAT[k] || k);
  o.tx = (o.tx || []).map((t) => (t.category && LEGACY_CAT[t.category] ? { ...t, category: fix(t.category) } : t));
  o.rules = (o.rules || []).map((r) => ({ ...r, category: fix(r.category) }));
  o.tx = o.tx.map((t) => ((t.source === "ofx" || t.source === "pdf") && !t.category && isInternalMove(t.desc) ? { ...t, category: "transferencia" } : t));
  const base = o.categories && o.categories.length ? o.categories : DEFAULT_CATS;
  o.categories = base.map((c) => ({ ...c, kind: c.kind || (c.key === "transferencia" ? "transf" : c.key === "vendas" ? "receita" : "despesa") }));
  const b = {}; Object.entries(o.budgets || {}).forEach(([k, v]) => { b[fix(k)] = (b[fix(k)] || 0) + v; }); o.budgets = b;
  return o;
}

// mês da fatura em que o lançamento de cartão cai
function effMonth(t, card) {
  const m = t.date.slice(0, 7);
  if (t.method === "cartao" && +t.date.slice(8, 10) > (+card.closingDay || 31)) return shiftMonth(m, 1);
  return m;
}
const isTransfer = (t) => t.category === "transferencia";
function installmentOf(p, mk) {
  const idx = monthDiff(p.firstMonth, mk);
  if (idx < 0 || idx >= p.installments) return null;
  return { value: p.totalValue / p.installments, index: idx + 1, total: p.installments };
}
// Aplicações e resgates automáticos (ex.: BB Rende Fácil) são dinheiro que só muda de bolso:
// não são receita nem despesa, então entram como "Transferência" e ficam fora de Recebido/Pago.
const INTERNAL_RE = /rende\s*f[aá]cil|invest\s*f[aá]cil|aplica[cç][aã]o|aplic\.?\s*(fin|autom)|resgate|\bcdb\b|\brdb\b|poupan[cç]a\s*autom/i;
const isInternalMove = (desc) => INTERNAL_RE.test(norm(desc));
function applyRules(desc, rules) {
  const d = norm(desc);
  const r = (rules || []).find((r) => r.kw && d.includes(norm(r.kw)));
  if (r) return r.category;
  return isInternalMove(desc) ? "transferencia" : "";
}
const isDone = (t) => t.status !== "previsto";
// só lançamentos vindos de extrato (OFX/PDF) precisam ser conferidos; os manuais já nascem conferidos
const needsCheck = (t) => (t.source === "ofx" || t.source === "pdf") && isDone(t);
const dayDiff = (a, b) => Math.round((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 864e5);
const daysIn = (mk) => new Date(+mk.slice(0, 4), +mk.slice(5), 0).getDate();
// Gera, mês a mês, as ocorrências previstas das contas fixas / variáveis
function ensureRecurring(s, mk) {
  if (mk > shiftMonth(nowKey(), 12)) return s;
  const groups = {};
  s.tx.forEach((t) => { if (t.recId) (groups[t.recId] = groups[t.recId] || []).push(t); });
  const add = [];
  for (const [rid, arr] of Object.entries(groups)) {
    const ended = (s.recEnded || {})[rid];
    let cur = [...arr].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    let m = shiftMonth(cur.date.slice(0, 7), 1);
    for (; m <= mk; m = shiftMonth(m, 1)) {
      if (ended && m >= ended) break;
      const day = Math.min(cur.dueDay || +cur.date.slice(8, 10), daysIn(m));
      cur = { ...cur, id: uid(), date: `${m}-${pad(day)}`, status: "previsto", est: cur.kind === "variavel", nf: "", note: "", checked: false, fitid: "", source: "recorrente" };
      add.push(cur);
    }
  }
  return add.length ? { ...s, tx: [...s.tx, ...add] } : s;
}
function dueInfo(t) {
  const d = dayDiff(t.date, todayStr());
  if (d < 0) return { tone: "bad", label: `Venceu há ${-d} dia${d === -1 ? "" : "s"}`, d };
  if (d === 0) return { tone: "gold", label: "Vence hoje", d };
  if (d <= 7) return { tone: "gold", label: `Vence em ${d} dia${d === 1 ? "" : "s"}`, d };
  return { tone: "", label: `Vence ${brDate(t.date).slice(0, 5)}`, d };
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || "text/plain;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

/* ------------------------------ UI atoms ------------------------------ */
const inputStyle = { width: "100%", border: `1.5px solid ${C.borda}`, borderRadius: 12, padding: "11px 13px", fontSize: 15, color: C.text, background: "#FAFCFD", outline: "none", boxSizing: "border-box", fontFamily: "inherit" };
const sectionTitle = { fontFamily: "'Playfair Display', Georgia, serif", fontSize: 18, fontWeight: 600, margin: "0 0 14px" };

const Card = ({ children, style }) => html`<div style=${{ background: C.card, borderRadius: 18, border: `1px solid ${C.borda}`, boxShadow: "0 2px 14px rgba(15,61,71,0.05)", padding: "18px 20px", marginBottom: 14, ...style }}>${children}</div>`;
const Pill = ({ children, tone }) => {
  const t = { good: ["#D9EBEA", C.teal], bad: ["#FADDD6", C.alerta], gold: ["#FFF1D6", "#8A5A00"] }[tone] || [C.soft, C.text];
  return html`<span style=${{ background: t[0], color: t[1], fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 999, whiteSpace: "nowrap" }}>${children}</span>`;
};
const Btn = ({ onClick, children, ghost, style, full, disabled }) => html`<button disabled=${disabled} onClick=${onClick} style=${{
  background: ghost ? "transparent" : C.peach, color: ghost ? C.peachDark : "#fff", border: ghost ? `1.5px solid ${C.peach}` : "none",
  borderRadius: 14, padding: "11px 18px", fontWeight: 600, fontSize: 14.5, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
  display: "inline-flex", alignItems: "center", gap: 8, minHeight: 44, width: full ? "100%" : "auto", justifyContent: "center", fontFamily: "inherit", ...style }}>${children}</button>`;
const IconBtn = ({ onClick, children, danger, title }) => html`<button title=${title} onClick=${onClick} style=${{ border: "none", background: "transparent", cursor: "pointer", color: danger ? C.alerta : C.textSec, padding: 8, borderRadius: 10, minWidth: 40, minHeight: 40, display: "flex", alignItems: "center", justifyContent: "center" }}>${children}</button>`;
const Field = ({ label, children }) => html`<label style=${{ display: "block", marginBottom: 12 }}><div style=${{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 5 }}>${label}</div>${children}</label>`;
const Bar = ({ value, max, color }) => html`<div style=${{ background: "#E3ECEF", borderRadius: 999, height: 9, overflow: "hidden" }}><div style=${{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`, height: "100%", background: color || C.peach, borderRadius: 999 }} /></div>`;
const Empty = ({ text }) => html`<div style=${{ textAlign: "center", padding: "30px 16px", color: C.textSec, fontSize: 14.5 }}>${text}</div>`;
function Modal({ title, onClose, children, wide }) {
  return html`<div onClick=${onClose} style=${{ position: "fixed", inset: 0, background: "rgba(15,61,71,0.4)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
    <div onClick=${(e) => e.stopPropagation()} style=${{ background: C.bg, borderRadius: "22px 22px 0 0", padding: "20px 20px 28px", width: "100%", maxWidth: wide ? 760 : 500, maxHeight: "92vh", overflowY: "auto" }}>
      <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h3 style=${{ ...sectionTitle, fontSize: 21, margin: 0 }}>${title}</h3>
        <${IconBtn} onClick=${onClose}><${I.X} size=${20} /><//>
      </div>${children}</div></div>`;
}
const Stat = ({ label, value, color }) => html`<div style=${{ flex: 1, minWidth: 140, background: C.card, border: `1px solid ${C.borda}`, borderRadius: 16, padding: "14px 16px" }}>
  <div style=${{ fontSize: 12.5, color: C.textSec, fontWeight: 600 }}>${label}</div>
  <div style=${{ fontSize: 21, fontWeight: 700, color: color || C.text, marginTop: 4 }}>${value}</div></div>`;

/* ------------------------------ Lançamento (com anotações) ------------------------------ */
function TxModal({ data, state, methods, onSave, onDelete, onClose }) {
  const isNew = !data.id;
  const [f, setF] = useState({
    sign: data.value > 0 ? "in" : "out", value: data.value ? String(Math.abs(data.value)).replace(".", ",") : "",
    date: data.date || todayStr(), desc: data.desc || "", method: data.method || "banco", bankId: data.bankId || (state.banks[0] && state.banks[0].id) || "",
    category: data.category || "", nf: data.nf || "", note: data.note || "", checked: !!data.checked,
    status: data.status === "previsto" ? "previsto" : "feito", kind: data.kind || "avulsa",
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const needsBank = f.method === "banco" || f.method === "pix";
  const isCard = f.method === "cartao";
  const isCash = f.method === "dinheiro";
  const simple = isCard || isCash; // sem "A pagar/A receber" nem repetição
  const allowed = methods && methods.length ? methods : Object.keys(METHODS);
  const showForma = allowed.length > 1;
  const val = P.parseAmount(f.value || "0");
  const ok = !isNaN(val) && val !== 0 && f.desc.trim() && f.date;
  const inn = f.sign === "in";
  const seg = (items, cur, on, color) => html`<div style=${{ display: "flex", gap: 8, marginBottom: 12 }}>${items.map(([k, label]) => html`<button key=${k} onClick=${() => on(k)} style=${{ flex: 1, minHeight: 44, borderRadius: 12, border: `1.5px solid ${cur === k ? "transparent" : C.borda}`, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit", background: cur === k ? (color ? color(k) : C.peach) : "transparent", color: cur === k ? "#fff" : C.text }}>${label}</button>`)}</div>`;
  const save = () => {
    const recurring = !simple && f.kind !== "avulsa";
    const o = { ...data, id: data.id, date: f.date, desc: f.desc.trim(), value: inn ? Math.abs(val) : -Math.abs(val), method: f.method, bankId: needsBank ? f.bankId : "", category: f.category, nf: f.nf.trim(), note: f.note.trim(), checked: f.checked, source: data.source || "manual",
      status: data.status === "previsto" && !simple ? "previsto" : "feito", kind: recurring ? f.kind : "", recId: recurring ? (data.recId || uid()) : "", dueDay: +f.date.slice(8, 10), est: false };
    if (!recurring && data.recId) o._endRec = data.recId;
    onSave(o);
  };
  return html`<${Modal} title=${isNew ? "Novo lançamento" : "Lançamento"} onClose=${onClose}>
    ${seg([["out", "Pago (saída)"], ["in", "Recebido (entrada)"]], f.sign, (k) => set("sign", k), (k) => (k === "in" ? C.teal : C.peach))}
    ${data.est && html`<div style=${{ background: "#EAF1FD", borderRadius: 12, padding: "9px 12px", fontSize: 13.5, marginBottom: 12 }}>Valor estimado (copiado do mês anterior). Informe o valor real.</div>`}
    <${Field} label="Descrição"><input style=${inputStyle} value=${f.desc} onInput=${(e) => set("desc", e.target.value)} /><//>
    <div style=${{ display: "flex", gap: 10 }}>
      <div style=${{ flex: 1 }}><${Field} label="Valor (R$)"><input style=${inputStyle} inputMode="decimal" value=${f.value} onInput=${(e) => set("value", e.target.value)} placeholder="0,00" /><//></div>
      <div style=${{ flex: 1 }}><${Field} label=${f.status === "previsto" && !simple ? "Vencimento" : "Data"}><input type="date" style=${inputStyle} value=${f.date} onInput=${(e) => set("date", e.target.value)} /><//></div>
    </div>
    <div style=${{ display: "flex", gap: 10 }}>
      ${showForma && html`<div style=${{ flex: 1 }}><${Field} label="Forma"><select style=${inputStyle} value=${f.method} onChange=${(e) => set("method", e.target.value)}>${allowed.map((k) => html`<option key=${k} value=${k}>${METHODS[k]}</option>`)}</select><//></div>`}
      ${needsBank && html`<div style=${{ flex: 1 }}><${Field} label="Conta"><select style=${inputStyle} value=${f.bankId} onChange=${(e) => set("bankId", e.target.value)}><option value="">— escolher —</option>${state.banks.map((b) => html`<option key=${b.id} value=${b.id}>${b.name}</option>`)}</select><//></div>`}
    </div>
    ${!simple && html`<div style=${{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 5 }}>Tipo de conta</div>
      ${seg([["avulsa", "Única"], ["fixa", "Fixa"], ["variavel", "Variável"]], f.kind, (k) => set("kind", k))}
      ${f.kind !== "avulsa" && html`<div style=${{ fontSize: 12.5, color: C.textSec, marginTop: -4, marginBottom: 12 }}>${f.kind === "fixa" ? "Repete todo mês com o mesmo valor (ex.: aluguel, internet). No mês seguinte ela aparece em Vencimentos como \"A pagar\"." : "Repete todo mês, mas o valor muda (ex.: energia). No mês seguinte vem como estimada; você informa o valor real ao pagar."}</div>`}`}
    <${Field} label="Categoria"><select style=${inputStyle} value=${f.category} onChange=${(e) => set("category", e.target.value)}><option value="">Sem categoria</option>${CATS.map((c) => html`<option key=${c.key} value=${c.key}>${c.label}</option>`)}</select><//>
    <div style=${{ background: "#EAF1FD", border: `1px solid #CFE0FB`, borderRadius: 14, padding: "12px 12px 2px", marginBottom: 12 }}>
      <div style=${{ fontWeight: 700, fontSize: 13.5, marginBottom: 8, display: "flex", gap: 6, alignItems: "center" }}><${I.StickyNote} size=${16} /> Anotações deste lançamento</div>
      <${Field} label="Nota fiscal / documento"><input style=${inputStyle} value=${f.nf} onInput=${(e) => set("nf", e.target.value)} placeholder="Ex.: NF 1234 - Fornecedor X" /><//>
      <${Field} label="Observação"><textarea style=${{ ...inputStyle, minHeight: 80, resize: "vertical" }} value=${f.note} onInput=${(e) => set("note", e.target.value)} placeholder="Ex.: pagamento parcial da NF 1234, referente a ..." /><//>
    </div>
    ${needsCheck(data) && html`<label style=${{ display: "flex", gap: 10, alignItems: "center", fontSize: 14.5, marginBottom: 16, cursor: "pointer" }}><input type="checkbox" checked=${f.checked} onChange=${(e) => set("checked", e.target.checked)} style=${{ width: 20, height: 20 }} /> Conferido com o extrato / comprovante</label>`}
    ${data.source && data.source !== "manual" && data.source !== "recorrente" && html`<div style=${{ fontSize: 12.5, color: C.textSec, marginBottom: 12 }}>Importado de extrato (${data.source.toUpperCase()}).</div>`}
    <div style=${{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <${Btn} full disabled=${!ok} onClick=${save}>Salvar<//>
      ${!isNew && html`<${Btn} ghost onClick=${() => onDelete(data.id, false)} style=${{ color: C.alerta, borderColor: C.alerta }}><${I.Trash2} size=${17} /> Apagar<//>`}
      ${!isNew && data.recId && html`<${Btn} ghost onClick=${() => onDelete(data.id, true)} style=${{ color: C.alerta, borderColor: C.alerta }}>Apagar este e os próximos<//>`}
    </div></${Modal}>`;
}

/* ------------------------------ Lista de lançamentos ------------------------------ */
function TxList({ list, state, onEdit, onToggle, onPay, emptyText, bankName }) {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState("");
  const shown = useMemo(() => {
    let l = list;
    if (q.trim()) { const n = norm(q); l = l.filter((t) => norm(t.desc + " " + t.nf + " " + t.note + " " + catLabel(t.category)).includes(n)); }
    if (only === "semnota") l = l.filter((t) => !t.note && !t.nf);
    if (only === "naoconf") l = l.filter((t) => needsCheck(t) && !t.checked);
    return [...l].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [list, q, only]);
  const chip = (k, label) => html`<button onClick=${() => setOnly(only === k ? "" : k)} style=${{ border: `1.5px solid ${only === k ? C.peach : C.borda}`, background: only === k ? "#EAF1FD" : "transparent", color: C.text, borderRadius: 999, padding: "6px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>${label}</button>`;
  return html`<div>
    <div style=${{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
      <div style=${{ position: "relative", flex: "1 1 200px" }}><input style=${{ ...inputStyle, paddingLeft: 36 }} placeholder="Buscar descrição, NF ou nota…" value=${q} onInput=${(e) => setQ(e.target.value)} /><span style=${{ position: "absolute", left: 11, top: 11, color: C.textSec }}><${I.Search} size=${17} /></span></div>
      ${chip("semnota", "Sem anotação")} ${list.some(needsCheck) && chip("naoconf", "Não conferidos")}
    </div>
    ${shown.length === 0 ? html`<${Empty} text=${emptyText || "Nenhum lançamento."} />` : shown.map((t) => html`
      <div key=${t.id} style=${{ display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 4px", borderBottom: `1px solid ${C.borda}` }}>
        ${!isDone(t) ? html`<span title="Agendado" style=${{ width: 26, minWidth: 26, marginTop: 2, color: C.peachDark, display: "flex", justifyContent: "center" }}><${I.CalendarClock} size=${22} /></span>` : !needsCheck(t) ? (list.some(needsCheck) ? html`<span style=${{ width: 26, minWidth: 26 }}></span>` : null) : html`<button title="Conferido" onClick=${() => onToggle(t.id)} style=${{ width: 26, height: 26, minWidth: 26, borderRadius: 8, marginTop: 2, border: `1.8px solid ${t.checked ? C.teal : C.borda}`, background: t.checked ? C.teal : "transparent", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>${t.checked && html`<${I.Check} size=${15} />`}</button>`}
        <div onClick=${() => onEdit(t)} style=${{ flex: 1, minWidth: 0, cursor: "pointer" }}>
          <div style=${{ fontSize: 14.5, fontWeight: 600, overflowWrap: "anywhere" }}>${t.desc}</div>
          <div style=${{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>${!isDone(t) && html`<${Pill} tone=${dueInfo(t).tone}>${t.value >= 0 ? "A receber" : "A pagar"} · ${dueInfo(t).label}<//>`}${t.kind && html`<${Pill}>${t.kind === "fixa" ? "Fixa" : "Variável"}<//>`}</div>
          <div style=${{ fontSize: 12.5, color: C.textSec, marginTop: 2 }}>${brDate(t.date)} · ${METHODS[t.method]}${bankName && t.bankId ? " · " + bankName(t.bankId) : ""}${t.category ? " · " + catLabel(t.category) : ""}</div>
          ${(t.nf || t.note) && html`<div style=${{ marginTop: 6, background: "#EAF1FD", borderRadius: 10, padding: "6px 10px", fontSize: 13, color: "#123A85", overflowWrap: "anywhere" }}>
            ${t.nf && html`<b>${t.nf}</b>`}${t.nf && t.note ? " — " : ""}${t.note}</div>`}
        </div>
        <div style=${{ textAlign: "right" }}>
          <div style=${{ fontWeight: 700, fontSize: 15, color: t.value >= 0 ? C.teal : C.text, whiteSpace: "nowrap", opacity: isDone(t) ? 1 : 0.8 }}>${t.est ? "~ " : ""}${t.value >= 0 ? "+" : "−"} ${fmt(Math.abs(t.value))}</div>
          ${!isDone(t) && onPay ? html`<${Btn} ghost style=${{ minHeight: 34, padding: "4px 12px", fontSize: 13, marginTop: 4 }} onClick=${() => onPay(t)}>${t.value >= 0 ? "Receber" : "Pagar"}<//>` : html`<${IconBtn} onClick=${() => onEdit(t)} title="Anotar / editar"><${I.Pencil} size=${16} /><//>`}
        </div>
      </div>`)}
  </div>`;
}

/* ------------------------------ Importação OFX / PDF ------------------------------ */
function ImportModal({ state, monthKey, onImport, onClose, defaultMethod }) {
  const [step, setStep] = useState("pick");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null); // {name, buf, type}
  const [year, setYear] = useState(+monthKey.slice(0, 4));
  const [parsed, setParsed] = useState(null);
  const [rows, setRows] = useState([]);
  const [bankId, setBankId] = useState((state.banks[0] && state.banks[0].id) || "");
  const [asCard, setAsCard] = useState(defaultMethod === "cartao");

  const sameTx = (a, b) => (a.fitid && b.fitid && a.fitid === b.fitid && (a.bankId || "") === (b.bankId || "")) || (a.date === b.date && Math.abs(a.value - b.value) < 0.005 && norm(a.desc) === norm(b.desc));

  async function run(f, yr) {
    setBusy(true); setErr("");
    try {
      let res;
      if (f.type === "pdf") {
        if (!window.pdfjsLib) throw new Error("Leitor de PDF não carregou. Verifique a conexão e recarregue.");
        res = await P.parsePDF(f.buf.slice(0), pdfjsLib, yr);
      } else res = P.parseOFX(P.decodeBuffer(f.buf));
      if (!res.items.length) throw new Error(f.type === "pdf" ? "Não encontrei lançamentos neste PDF. Ele pode ser uma imagem escaneada ou ter um formato diferente. Se possível, use o OFX do banco." : "Nenhum lançamento encontrado neste arquivo.");
      setParsed(res);
      if (res.kind === "cartao") setAsCard(true);
      if (res.acctId) { const b = state.banks.find((b) => b.acctId && res.acctId.includes(b.acctId.replace(/\D/g, ""))); if (b) setBankId(b.id); }
      setStep("review");
    } catch (e) { setErr(e.message || String(e)); setStep("pick"); }
    setBusy(false);
  }
  // reconstrói as linhas de revisão quando muda destino / arquivo
  useEffect(() => {
    if (!parsed) return;
    const used = new Set();
    setRows(parsed.items.map((it, i) => {
      const method = asCard ? "cartao" : /pix/i.test(it.desc) ? "pix" : "banco";
      const t = { ...it, method, bankId: asCard ? "" : bankId };
      const dup = state.tx.some((x) => isDone(x) && sameTx(x, t));
      let match = null;
      if (!dup && !asCard) {
        const c = state.tx.filter((x) => !isDone(x) && x.method !== "cartao" && !used.has(x.id) && Math.sign(x.value) === Math.sign(it.value) &&
          ((x.est || x.kind === "variavel") ? Math.abs(Math.abs(x.value) - Math.abs(it.value)) <= Math.abs(x.value) * 0.5 : Math.abs(Math.abs(x.value) - Math.abs(it.value)) < 0.005) && Math.abs(dayDiff(x.date, it.date)) <= 15)
          .sort((a, b) => Math.abs(dayDiff(a.date, it.date)) - Math.abs(dayDiff(b.date, it.date)))[0];
        if (c) { used.add(c.id); match = c; }
      }
      return { ...t, _k: i, dup, match, sel: !dup, category: match ? match.category : applyRules(it.desc, state.rules) };
    }));
  }, [parsed, bankId, asCard]);

  async function pick(e) {
    const fl = e.target.files[0]; if (!fl) return;
    const type = /\.pdf$/i.test(fl.name) ? "pdf" : "ofx";
    const buf = await fl.arrayBuffer();
    const f = { name: fl.name, buf, type }; setFile(f); run(f, year);
  }
  const flip = (k) => setRows((r) => r.map((x) => (x._k === k ? { ...x, value: -x.value, uncertain: false } : x)));
  const tog = (k) => setRows((r) => r.map((x) => (x._k === k ? { ...x, sel: !x.sel } : x)));
  const chosen = rows.filter((r) => r.sel);
  const sum = chosen.reduce((s, r) => s + r.value, 0);
  const confirm = () => {
    const settles = chosen.filter((r) => r.match).map((r) => ({ id: r.match.id, patch: { status: "feito", value: r.value, date: r.date, method: r.method, bankId: r.bankId, fitid: r.fitid, source: file.type, est: false } }));
    onImport(chosen.filter((r) => !r.match).map((r) => ({ id: uid(), date: r.date, desc: r.desc, value: r.value, method: r.method, bankId: r.bankId, category: r.category, nf: "", note: "", checked: false, fitid: r.fitid, source: file.type })), settles);
  };
  return html`<${Modal} title="Importar extrato" wide onClose=${onClose}>
    ${step === "pick" && html`<div>
      <p style=${{ marginTop: 0, color: C.textSec, fontSize: 14.5 }}>Escolha o arquivo do extrato: <b>OFX</b> (recomendado, mais preciso) ou <b>PDF</b> (leitura aproximada — você confere antes de importar).</p>
      ${state.banks.length === 0 && html`<div style=${{ background: "#EAF1FD", borderRadius: 12, padding: 12, fontSize: 14, marginBottom: 12 }}>Cadastre uma conta em <b>Ajustes → Contas bancárias</b> para vincular os lançamentos a um banco.</div>`}
      <${Field} label="Ano dos lançamentos (usado quando o PDF só traz dia/mês)"><input style=${inputStyle} inputMode="numeric" value=${year} onInput=${(e) => setYear(+e.target.value || year)} /><//>
      <label style=${{ display: "block", border: `2px dashed ${C.peach}`, borderRadius: 16, padding: "28px 16px", textAlign: "center", cursor: "pointer", background: "#EAF1FD" }}>
        <${I.FileUp} size=${30} /><div style=${{ fontWeight: 600, marginTop: 8 }}>${busy ? "Lendo arquivo…" : "Toque para escolher OFX ou PDF"}</div>
        <input type="file" accept=".ofx,.qfx,.pdf,application/pdf" onChange=${pick} style=${{ display: "none" }} />
      </label>
      ${err && html`<div style=${{ color: C.alerta, marginTop: 12, fontSize: 14 }}>${err}</div>`}
    </div>`}
    ${step === "review" && html`<div>
      <div style=${{ fontSize: 13.5, color: C.textSec, marginBottom: 10 }}>${file.name} — ${rows.length} lançamentos encontrados${parsed.lineCount ? "" : ""}.</div>
      ${rows.some((r) => r.category === "transferencia") && html`<div style=${{ background: "#EAF1FD", borderRadius: 12, padding: "10px 12px", fontSize: 13.5, marginBottom: 10 }}>${rows.filter((r) => r.category === "transferencia").length} lançamento(s) de aplicação/resgate (ex.: Rende Fácil) foram marcados como <b>Transferência</b> e <b>não entram em Recebido/Pago</b>. Você pode mudar a categoria depois.</div>`}
      <div style=${{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style=${{ flex: "1 1 200px" }}><${Field} label="Destino"><select style=${inputStyle} value=${asCard ? "cartao" : "banco"} onChange=${(e) => setAsCard(e.target.value === "cartao")}><option value="banco">Conta bancária / PIX</option><option value="cartao">Fatura de cartão</option></select><//></div>
        ${!asCard && html`<div style=${{ flex: "1 1 200px" }}><${Field} label="Conta"><select style=${inputStyle} value=${bankId} onChange=${(e) => setBankId(e.target.value)}><option value="">— sem conta —</option>${state.banks.map((b) => html`<option key=${b.id} value=${b.id}>${b.name}</option>`)}</select><//></div>`}
      </div>
      ${file.type === "pdf" && html`<div style=${{ background: "#EAF1FD", borderRadius: 12, padding: "10px 12px", fontSize: 13.5, marginBottom: 10 }}>Leitura de PDF é aproximada. Confira datas, valores e o sinal (entrada/saída). Linhas marcadas <b>?</b> tiveram o sinal presumido — toque em ⇅ para inverter.</div>`}
      <div style=${{ border: `1px solid ${C.borda}`, borderRadius: 14, background: C.card, maxHeight: "46vh", overflowY: "auto" }}>
        ${rows.map((r) => html`<div key=${r._k} style=${{ display: "flex", gap: 8, alignItems: "center", padding: "9px 10px", borderBottom: `1px solid ${C.borda}`, opacity: r.sel ? 1 : 0.5 }}>
          <input type="checkbox" checked=${r.sel} onChange=${() => tog(r._k)} style=${{ width: 20, height: 20, flexShrink: 0 }} />
          <div style=${{ flex: 1, minWidth: 0 }}>
            <div style=${{ fontSize: 13.5, fontWeight: 600, overflowWrap: "anywhere" }}>${r.desc}</div>
            <div style=${{ fontSize: 12, color: C.textSec }}>${brDate(r.date)} · ${METHODS[r.method]}${r.dup ? " · já lançado" : ""}${r.match ? " · dá baixa em “" + r.match.desc + "”" : ""}${r.category ? " · " + catLabel(r.category) : ""}</div>
          </div>
          <div style=${{ fontWeight: 700, fontSize: 14, color: r.value >= 0 ? C.teal : C.text, whiteSpace: "nowrap" }}>${r.uncertain ? "? " : ""}${r.value >= 0 ? "+" : "−"} ${fmt(Math.abs(r.value))}</div>
          <${IconBtn} onClick=${() => flip(r._k)} title="Inverter entrada/saída"><${I.ArrowUpDown} size=${16} /><//>
        </div>`)}
      </div>
      <div style=${{ display: "flex", justifyContent: "space-between", margin: "12px 2px", fontSize: 14 }}><span>${chosen.length} selecionados</span><b>Saldo: ${fmt(sum)}</b></div>
      <div style=${{ display: "flex", gap: 10 }}><${Btn} full disabled=${!chosen.length} onClick=${confirm}>Importar ${chosen.length}<//><${Btn} ghost onClick=${() => { setStep("pick"); setParsed(null); }}>Voltar<//></div>
    </div>`}
  <//>`;
}

/* ------------------------------ Abas ------------------------------ */
function Visao({ s, monthKey, T, accounts, pend, goTab, alerts, onPay }) {
  const last6 = useMemo(() => Array.from({ length: 6 }, (_, i) => { const k = shiftMonth(monthKey, i - 5); return { k, ...T(k) }; }), [s, monthKey]);
  const cur = T(monthKey);
  const maxB = Math.max(1, ...last6.map((x) => Math.max(x.in, x.out)));
  const cats = useMemo(() => {
    const m = {};
    s.tx.forEach((t) => { if (isDone(t) && effMonth(t, s.card) === monthKey && t.value < 0 && !isTransfer(t)) { const k = t.category || "_"; m[k] = (m[k] || 0) - t.value; } });
    return Object.entries(m).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
  }, [s, monthKey]);
  const maxC = Math.max(1, ...cats.map((c) => c.v));
  return html`<div>
    <div style=${{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
      <${Stat} label="Recebido" value=${fmt(cur.in)} color=${C.teal} /><${Stat} label="Pago" value=${fmt(cur.out)} /><${Stat} label="Resultado do mês" value=${fmt(cur.in - cur.out)} color=${cur.in - cur.out >= 0 ? C.teal : C.alerta} />
    </div>
    ${(cur.toIn > 0 || cur.toOut > 0) && html`<div style=${{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}><${Stat} label="A receber no mês" value=${fmt(cur.toIn)} color=${C.teal} /><${Stat} label="A pagar no mês" value=${fmt(cur.toOut)} color=${C.peachDark} /></div>`}
    ${alerts.length > 0 && html`<${Card} style=${{ borderColor: alerts.some((a) => a.d < 0) ? "#F2B6AC" : C.borda }}><h3 style=${sectionTitle}>Vencimentos</h3>
      ${alerts.slice(0, 10).map(({ t }) => { const di = dueInfo(t); return html`<div key=${t.id} style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "9px 0", borderBottom: `1px solid ${C.borda}` }}>
        <div style=${{ minWidth: 0 }}><div style=${{ fontWeight: 600, fontSize: 14.5, overflowWrap: "anywhere" }}>${t.desc}</div><div style=${{ marginTop: 3 }}><${Pill} tone=${di.tone}>${t.value >= 0 ? "Receber" : "Pagar"} · ${di.label}<//></div></div>
        <div style=${{ display: "flex", alignItems: "center", gap: 8 }}><b style=${{ whiteSpace: "nowrap" }}>${t.est ? "~ " : ""}${fmt(Math.abs(t.value))}</b><${Btn} ghost style=${{ minHeight: 36, padding: "4px 12px", fontSize: 13 }} onClick=${() => onPay(t)}>${t.value >= 0 ? "Receber" : "Pagar"}<//></div></div>`; })}
      ${alerts.length > 10 && html`<div style=${{ fontSize: 13, color: C.textSec, marginTop: 8 }}>+ ${alerts.length - 10} vencimentos</div>`}<//>`}
    <${Card}><h3 style=${sectionTitle}>Saldos atuais</h3>
      ${accounts.map((a) => html`<div key=${a.id} style=${{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${C.borda}` }}><span>${a.name}</span><b style=${{ color: a.balance < 0 ? C.alerta : C.text }}>${fmt(a.balance)}</b></div>`)}
      <div style=${{ display: "flex", justifyContent: "space-between", paddingTop: 10, fontSize: 16 }}><b>Total</b><b>${fmt(accounts.reduce((x, a) => x + a.balance, 0))}</b></div>
    <//>
    ${(pend.semNota > 0 || pend.semCat > 0 || pend.naoConf > 0) && html`<${Card} style=${{ background: "#EAF1FD", borderColor: "#CFE0FB" }}><h3 style=${sectionTitle}>Pendências do mês</h3>
      <div style=${{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        ${pend.semCat > 0 && html`<${Pill} tone="gold">${pend.semCat} sem categoria<//>`}
        ${pend.semNota > 0 && html`<${Pill} tone="gold">${pend.semNota} sem anotação<//>`}
        ${pend.naoConf > 0 && html`<${Pill} tone="gold">${pend.naoConf} importados a conferir<//>`}
      </div><div style=${{ marginTop: 12 }}><${Btn} ghost onClick=${() => goTab("banco")}>Revisar lançamentos<//></div><//>`}
    <${Card}><h3 style=${sectionTitle}>Para onde foi o dinheiro</h3>
      ${cats.length === 0 ? html`<${Empty} text="Sem saídas neste mês." />` : cats.map((c) => html`<div key=${c.k} style=${{ marginBottom: 12 }}>
        <div style=${{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 5 }}><span>${c.k === "_" ? "Sem categoria" : catLabel(c.k)}</span><b>${fmt(c.v)}</b></div><${Bar} value=${c.v} max=${maxC} color=${c.k === "_" ? C.tealLight : C.peach} /></div>`)}
    <//>
    <${Card}><h3 style=${sectionTitle}>Últimos 6 meses</h3>
      <div style=${{ display: "flex", gap: 8, alignItems: "flex-end", height: 170 }}>
        ${last6.map((x) => html`<div key=${x.k} style=${{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
          <div style=${{ display: "flex", gap: 3, alignItems: "flex-end", height: 140 }}>
            <div title=${"Entradas " + fmt(x.in)} style=${{ width: 14, background: C.teal, borderRadius: "5px 5px 0 0", height: Math.max(3, (x.in / maxB) * 140) }}></div>
            <div title=${"Saídas " + fmt(x.out)} style=${{ width: 14, background: C.peach, borderRadius: "5px 5px 0 0", height: Math.max(3, (x.out / maxB) * 140) }}></div></div>
          <div style=${{ fontSize: 11.5, color: C.textSec, marginTop: 6, fontWeight: 600 }}>${MONTHS[+x.k.slice(5) - 1].slice(0, 3)}</div></div>`)}
      </div>
      <div style=${{ display: "flex", gap: 14, fontSize: 12.5, color: C.textSec, marginTop: 8 }}><span><b style=${{ color: C.teal }}>■</b> Entradas</span><span><b style=${{ color: C.peach }}>■</b> Saídas</span></div>
    <//>
  </div>`;
}

function Bancos({ s, monthKey, onEdit, onToggle, onPay, onAdd, onImport, bankName, setTab }) {
  const [sel, setSel] = useState("");
  const list = s.tx.filter((t) => (t.method === "banco" || t.method === "pix") && t.date.slice(0, 7) === monthKey && (!sel || t.bankId === sel));
  const dn = list.filter(isDone);
  const inn = dn.filter((t) => t.value > 0 && !isTransfer(t)).reduce((a, t) => a + t.value, 0), out = dn.filter((t) => t.value < 0 && !isTransfer(t)).reduce((a, t) => a - t.value, 0);
  const toIn = list.filter((t) => !isDone(t) && t.value > 0).reduce((a, t) => a + t.value, 0), toOut = list.filter((t) => !isDone(t) && t.value < 0).reduce((a, t) => a - t.value, 0);
  return html`<div>
    <div style=${{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}><${Btn} onClick=${onImport}><${I.FileUp} size=${18} /> Importar extrato (OFX/PDF)<//><${Btn} ghost onClick=${() => onAdd("banco")}><${I.Plus} size=${18} /> Lançamento<//></div>
    <div style=${{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
      ${[{ id: "", name: "Todas as contas" }, ...s.banks].map((b) => html`<button key=${b.id} onClick=${() => setSel(b.id)} style=${{ border: `1.5px solid ${sel === b.id ? C.peach : C.borda}`, background: sel === b.id ? "#EAF1FD" : C.card, borderRadius: 999, padding: "7px 14px", fontWeight: 600, fontSize: 13.5, cursor: "pointer", color: C.text, fontFamily: "inherit" }}>${b.name}</button>`)}
    </div>
    ${s.banks.length === 0 && html`<${Card}><div style=${{ fontSize: 14.5 }}>Nenhuma conta cadastrada. <a href="#" onClick=${(e) => { e.preventDefault(); setTab("ajustes"); }} style=${{ color: C.peachDark, fontWeight: 600 }}>Cadastrar em Ajustes</a></div><//>`}
    <div style=${{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 6 }}><${Stat} label="Recebido" value=${fmt(inn)} color=${C.teal} /><${Stat} label="Pago" value=${fmt(out)} />${toIn > 0 && html`<${Stat} label="A receber" value=${fmt(toIn)} color=${C.teal} />`}${toOut > 0 && html`<${Stat} label="A pagar" value=${fmt(toOut)} color=${C.peachDark} />`}</div>
    <${Card}><${TxList} list=${list} state=${s} onEdit=${onEdit} onToggle=${onToggle} onPay=${onPay} bankName=${bankName} emptyText="Nenhum lançamento bancário neste mês. Importe um extrato ou adicione manualmente." /><//>
  </div>`;
}

function Simples({ s, monthKey, method, title, onEdit, onToggle, onPay, onAdd, onImport, bankName }) {
  const list = s.tx.filter((t) => t.method === method && t.date.slice(0, 7) === monthKey);
  const dn = list.filter(isDone);
  const inn = dn.filter((t) => t.value > 0 && !isTransfer(t)).reduce((a, t) => a + t.value, 0), out = dn.filter((t) => t.value < 0 && !isTransfer(t)).reduce((a, t) => a - t.value, 0);
  const toIn = list.filter((t) => !isDone(t) && t.value > 0).reduce((a, t) => a + t.value, 0), toOut = list.filter((t) => !isDone(t) && t.value < 0).reduce((a, t) => a - t.value, 0);
  return html`<div>
    <div style=${{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}><${Btn} onClick=${() => onAdd(method)}><${I.Plus} size=${18} /> ${method === "pix" ? "Novo PIX" : "Novo lançamento"}<//>
      ${method === "pix" && html`<${Btn} ghost onClick=${onImport}><${I.FileUp} size=${18} /> Importar extrato<//>`}</div>
    ${method === "pix" && html`<div style=${{ fontSize: 13.5, color: C.textSec, marginBottom: 12 }}>Ao importar um extrato, lançamentos com "PIX" na descrição aparecem aqui automaticamente.</div>`}
    <div style=${{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 6 }}><${Stat} label=${"Recebido (" + title + ")"} value=${fmt(inn)} color=${C.teal} /><${Stat} label=${"Pago (" + title + ")"} value=${fmt(out)} />${toIn > 0 && html`<${Stat} label="A receber" value=${fmt(toIn)} color=${C.teal} />`}${toOut > 0 && html`<${Stat} label="A pagar" value=${fmt(toOut)} color=${C.peachDark} />`}</div>
    <${Card}><${TxList} list=${list} state=${s} onEdit=${onEdit} onToggle=${onToggle} onPay=${onPay} bankName=${bankName} emptyText=${"Nenhum lançamento em " + title + " neste mês."} /><//>
  </div>`;
}

function CartaoTab({ s, setS, monthKey, onEdit, onToggle, onAdd, onImport, bankName }) {
  const [modal, setModal] = useState(null);
  const txs = s.tx.filter((t) => t.method === "cartao" && effMonth(t, s.card) === monthKey);
  const inst = s.purchases.map((p) => ({ p, i: installmentOf(p, monthKey) })).filter((x) => x.i);
  const total = txs.reduce((a, t) => a - t.value, 0) + inst.reduce((a, x) => a + x.i.value, 0);
  const paid = !!s.cardPaid[monthKey];
  const hasCard = s.card.name.trim().length > 0;
  return html`<div>
    <${Card}><div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
      <div><div style=${{ fontWeight: 700, fontSize: 17 }}>${hasCard ? s.card.name : "Cartão não configurado"}</div>
        ${hasCard && html`<div style=${{ fontSize: 13, color: C.textSec }}>Fecha dia ${s.card.closingDay} · vence dia ${s.card.dueDay}${s.card.limit ? " · limite " + fmt(s.card.limit) : ""}</div>`}</div>
      <${Btn} ghost onClick=${() => setModal("cfg")}>${hasCard ? "Editar" : "Configurar"}<//></div><//>
    <${Card}><div style=${{ fontSize: 13, color: C.textSec, fontWeight: 600 }}>Fatura de ${monthLabel(monthKey)}</div>
      <div style=${{ fontSize: 26, fontWeight: 700, margin: "4px 0 10px" }}>${fmt(total)}</div>
      ${s.card.limit > 0 && html`<${Bar} value=${total} max=${s.card.limit} />`}
      <div style=${{ marginTop: 12 }}><${Btn} ghost=${!paid} onClick=${() => setS((p) => ({ ...p, cardPaid: { ...p.cardPaid, [monthKey]: !paid } }))}>${paid ? "✓ Fatura paga" : "Marcar fatura como paga"}<//></div>
      <div style=${{ fontSize: 12.5, color: C.textSec, marginTop: 8 }}>Dica: o pagamento da fatura no extrato do banco deve ficar na categoria "Transferência" para não contar duas vezes.</div>
    <//>
    <div style=${{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}><${Btn} onClick=${() => onAdd("cartao")}><${I.Plus} size=${18} /> Compra no cartão<//><${Btn} ghost onClick=${() => setModal({ purchase: {} })}>Compra parcelada<//><${Btn} ghost onClick=${onImport}><${I.FileUp} size=${18} /> Importar fatura<//></div>
    ${inst.length > 0 && html`<${Card}><h3 style=${sectionTitle}>Parcelas do mês</h3>${inst.map((x) => html`<div key=${x.p.id} style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.borda}` }}>
      <div><div style=${{ fontWeight: 600 }}>${x.p.name}</div><div style=${{ fontSize: 12.5, color: C.textSec }}>Parcela ${x.i.index}/${x.i.total}${x.p.nf ? " · " + x.p.nf : ""}</div></div>
      <div style=${{ display: "flex", alignItems: "center" }}><b>${fmt(x.i.value)}</b><${IconBtn} onClick=${() => setModal({ purchase: x.p })}><${I.Pencil} size=${16} /><//></div></div>`)}<//>`}
    <${Card}><h3 style=${sectionTitle}>Lançamentos da fatura</h3><${TxList} list=${txs} state=${s} onEdit=${onEdit} onToggle=${onToggle} bankName=${bankName} emptyText="Sem compras nesta fatura." /><//>
    ${modal === "cfg" && html`<${CardCfg} data=${s.card} onClose=${() => setModal(null)} onSave=${(c) => { setS((p) => ({ ...p, card: c })); setModal(null); }} />`}
    ${modal && modal.purchase && html`<${PurchaseModal} data=${modal.purchase} monthKey=${monthKey} onClose=${() => setModal(null)}
      onSave=${(d) => { setS((p) => ({ ...p, purchases: d.id ? p.purchases.map((x) => (x.id === d.id ? d : x)) : [...p.purchases, { ...d, id: uid() }] })); setModal(null); }}
      onDelete=${(id) => { setS((p) => ({ ...p, purchases: p.purchases.filter((x) => x.id !== id) })); setModal(null); }} />`}
  </div>`;
}
function CardCfg({ data, onSave, onClose }) {
  const [f, setF] = useState({ name: data.name, limit: data.limit ? String(data.limit).replace(".", ",") : "", closingDay: data.closingDay, dueDay: data.dueDay });
  return html`<${Modal} title="Cartão" onClose=${onClose}>
    <${Field} label="Nome do cartão"><input style=${inputStyle} value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Visa Itaú" /><//>
    <${Field} label="Limite (R$)"><input style=${inputStyle} inputMode="decimal" value=${f.limit} onInput=${(e) => setF({ ...f, limit: e.target.value })} /><//>
    <div style=${{ display: "flex", gap: 10 }}><div style=${{ flex: 1 }}><${Field} label="Dia de fechamento"><input style=${inputStyle} inputMode="numeric" value=${f.closingDay} onInput=${(e) => setF({ ...f, closingDay: e.target.value })} /><//></div>
    <div style=${{ flex: 1 }}><${Field} label="Dia de vencimento"><input style=${inputStyle} inputMode="numeric" value=${f.dueDay} onInput=${(e) => setF({ ...f, dueDay: e.target.value })} /><//></div></div>
    <${Btn} full onClick=${() => onSave({ name: f.name, limit: P.parseAmount(f.limit || "0") || 0, closingDay: +f.closingDay || 20, dueDay: +f.dueDay || 28 })}>Salvar<//><//>`;
}
function PurchaseModal({ data, monthKey, onSave, onDelete, onClose }) {
  const [f, setF] = useState({ name: data.name || "", total: data.totalValue ? String(data.totalValue).replace(".", ",") : "", n: data.installments || 1, first: data.firstMonth || monthKey, nf: data.nf || "" });
  const tv = P.parseAmount(f.total || "0");
  return html`<${Modal} title="Compra parcelada" onClose=${onClose}>
    <${Field} label="Descrição"><input style=${inputStyle} value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} /><//>
    <div style=${{ display: "flex", gap: 10 }}><div style=${{ flex: 1 }}><${Field} label="Valor total (R$)"><input style=${inputStyle} inputMode="decimal" value=${f.total} onInput=${(e) => setF({ ...f, total: e.target.value })} /><//></div>
    <div style=${{ flex: 1 }}><${Field} label="Parcelas"><input style=${inputStyle} inputMode="numeric" value=${f.n} onInput=${(e) => setF({ ...f, n: e.target.value })} /><//></div></div>
    <${Field} label="Mês da 1ª parcela"><input type="month" style=${inputStyle} value=${f.first} onInput=${(e) => setF({ ...f, first: e.target.value })} /><//>
    <${Field} label="Nota fiscal / observação"><input style=${inputStyle} value=${f.nf} onInput=${(e) => setF({ ...f, nf: e.target.value })} /><//>
    <div style=${{ display: "flex", gap: 10 }}><${Btn} full disabled=${!f.name.trim() || !(tv > 0)} onClick=${() => onSave({ ...data, name: f.name.trim(), totalValue: tv, installments: Math.max(1, +f.n || 1), firstMonth: f.first, nf: f.nf })}>Salvar<//>
    ${data.id && html`<${Btn} ghost onClick=${() => onDelete(data.id)} style=${{ color: C.alerta, borderColor: C.alerta }}><${I.Trash2} size=${17} /><//>`}</div><//>`;
}

function CatModal({ data, onSave, onClose }) {
  const [name, setName] = useState(data.label || "");
  const [kind, setKind] = useState(data.kind || "despesa");
  const locked = data.kind === "transf";
  return html`<${Modal} title=${data.key ? "Editar categoria" : "Nova categoria"} onClose=${onClose}>
    <${Field} label="Nome da categoria"><input style=${inputStyle} value=${name} onInput=${(e) => setName(e.target.value)} placeholder="Ex.: Embalagens" autoFocus /><//>
    ${!locked && html`<div style=${{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 5 }}>Tipo</div>
    <div style=${{ display: "flex", gap: 8, marginBottom: 14 }}>${[["despesa", "Despesa (tem orçamento)"], ["receita", "Receita"]].map(([k, l]) => html`<button key=${k} onClick=${() => setKind(k)} style=${{ flex: 1, minHeight: 44, borderRadius: 12, border: `1.5px solid ${kind === k ? "transparent" : C.borda}`, background: kind === k ? C.peach : "transparent", color: kind === k ? "#fff" : C.text, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>${l}</button>`)}</div>`}
    ${locked && html`<div style=${{ fontSize: 13, color: C.textSec, marginBottom: 14 }}>Esta categoria é especial: lançamentos nela não entram nos totais (ex.: pagamento de fatura, transferência entre contas). Só o nome pode ser alterado.</div>`}
    <${Btn} full disabled=${!name.trim()} onClick=${() => onSave({ ...data, label: name.trim(), kind: locked ? "transf" : kind })}>Salvar<//><//>`;
}

function CategoriasCard({ s, setS }) {
  const [cat, setCat] = useState(null);
  const [delCat, setDelCat] = useState(null);
  const saveCat = (c) => {
    setS((p) => ({ ...p, categories: c.key ? p.categories.map((x) => (x.key === c.key ? c : x)) : [...p.categories, { ...c, key: "c_" + uid() }] }));
    setCat(null);
  };
  const removeCat = (c) => {
    setS((p) => ({ ...p, categories: p.categories.filter((x) => x.key !== c.key), rules: p.rules.filter((r) => r.category !== c.key), tx: p.tx.map((t) => (t.category === c.key ? { ...t, category: "" } : t)) }));
    setDelCat(null);
  };
  const used = (k) => s.tx.filter((t) => t.category === k).length;
  const kindLabel = (k) => (k === "receita" ? "Receita" : k === "transf" ? "Não conta nos totais" : "Despesa");
  return html`<${Card}><div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}><h3 style=${{ ...sectionTitle, margin: 0 }}>Categorias</h3><${Btn} ghost onClick=${() => setCat({})}><${I.Plus} size=${16} /> Categoria<//></div>
    ${s.categories.map((c) => html`<div key=${c.key} style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, padding: "4px 0", borderBottom: `1px solid ${C.borda}` }}>
      <div style=${{ minWidth: 0 }}><div style=${{ fontSize: 14.5, overflowWrap: "anywhere" }}>${c.label}</div><div style=${{ fontSize: 12, color: C.textSec }}>${kindLabel(c.kind)}</div></div>
      <div style=${{ display: "flex" }}><${IconBtn} title="Editar" onClick=${() => setCat(c)}><${I.Pencil} size=${16} /><//>${c.kind !== "transf" && html`<${IconBtn} danger title="Excluir" onClick=${() => setDelCat(c)}><${I.Trash2} size=${16} /><//>`}</div></div>`)}
    ${cat && html`<${CatModal} data=${cat} onSave=${saveCat} onClose=${() => setCat(null)} />`}
    ${delCat && html`<${Modal} title="Excluir categoria" onClose=${() => setDelCat(null)}>
      <p style=${{ marginTop: 0 }}>Excluir <b>${delCat.label}</b>? ${used(delCat.key) > 0 ? used(delCat.key) + " lançamento(s) ficarão \"Sem categoria\". " : ""}Regras automáticas ligadas a ela também serão removidas. Não dá para desfazer.</p>
      <div style=${{ display: "flex", gap: 10 }}><${Btn} full onClick=${() => removeCat(delCat)} style=${{ background: C.alerta }}>Excluir<//><${Btn} ghost onClick=${() => setDelCat(null)}>Cancelar<//></div><//>`}
  <//>`;
}

function Ajustes({ s, setS, monthKey, restore, clearMonth }) {
  const [bank, setBank] = useState(null);
  const [txt, setTxt] = useState("");
  const [msg, setMsg] = useState("");
  const [rule, setRule] = useState({ kw: "", category: "fornecedores" });
  const exportCsv = () => {
    const rows = [["Data", "Descrição", "Valor", "Forma", "Conta", "Categoria", "NF/Documento", "Observação", "Conferido", "Situação", "Tipo de conta"]];
    [...s.tx].sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((t) => rows.push([brDate(t.date), t.desc, String(t.value).replace(".", ","), METHODS[t.method], (s.banks.find((b) => b.id === t.bankId) || {}).name || "", catLabel(t.category), t.nf, t.note, (!needsCheck(t) || t.checked) ? "Sim" : "Não", isDone(t) ? (t.value >= 0 ? "Recebido" : "Pago") : (t.value >= 0 ? "A receber" : "A pagar"), t.kind === "fixa" ? "Fixa" : t.kind === "variavel" ? "Variável" : "Única"]));
    download("lancamentos.csv", "﻿" + rows.map((r) => r.map((c) => `"${String(c || "").replace(/"/g, '""')}"`).join(";")).join("\r\n"), "text/csv;charset=utf-8");
  };
  const applyAll = () => { let n = 0; setS((p) => ({ ...p, tx: p.tx.map((t) => { if (t.category) return t; const c = applyRules(t.desc, p.rules); if (c) { n++; return { ...t, category: c }; } return t; }) })); setMsg("Regras aplicadas aos lançamentos sem categoria."); };
  return html`<div>
    <div style=${{ textAlign: "center", marginBottom: 14 }}><img src="./icons/logo.png" alt="FinForme - Suas finanças. Simples assim." style=${{ width: "100%", maxWidth: 260, borderRadius: 18 }} /></div>
    <${Card}><h3 style=${sectionTitle}>Cliente</h3>
      <${Field} label="Nome"><input style=${inputStyle} value=${s.client.name} onInput=${(e) => setS((p) => ({ ...p, client: { ...p.client, name: e.target.value } }))} /><//>
      <${Field} label="CPF / CNPJ"><input style=${inputStyle} value=${s.client.doc} onInput=${(e) => setS((p) => ({ ...p, client: { ...p.client, doc: e.target.value } }))} /><//>
      <${Field} label="Saldo inicial do caixa (dinheiro)"><input style=${inputStyle} inputMode="decimal" defaultValue=${s.cashInitial ? String(s.cashInitial).replace(".", ",") : ""} onBlur=${(e) => setS((p) => ({ ...p, cashInitial: P.parseAmount(e.target.value || "0") || 0 }))} /><//><//>
    <${Card}><div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}><h3 style=${{ ...sectionTitle, margin: 0 }}>Contas bancárias</h3><${Btn} ghost onClick=${() => setBank({})}><${I.Plus} size=${16} /> Conta<//></div>
      ${s.banks.length === 0 ? html`<${Empty} text="Cadastre os bancos do cliente para vincular os extratos." />` : s.banks.map((b) => html`<div key=${b.id} style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.borda}` }}><div><b>${b.name}</b><div style=${{ fontSize: 12.5, color: C.textSec }}>${b.acctId ? "Conta " + b.acctId + " · " : ""}Saldo inicial ${fmt(b.initial)}</div></div><${IconBtn} onClick=${() => setBank(b)}><${I.Pencil} size=${16} /><//></div>`)}<//>
    <${CategoriasCard} s=${s} setS=${setS} />
    <${Card}><h3 style=${sectionTitle}>Regras de categoria automática</h3>
      <div style=${{ fontSize: 13.5, color: C.textSec, marginBottom: 10 }}>Se a descrição contiver o texto, a categoria é aplicada na importação.</div>
      ${s.rules.map((r, i) => html`<div key=${i} style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${C.borda}`, fontSize: 14 }}><span>"${r.kw}" → <b>${catLabel(r.category)}</b></span><${IconBtn} danger onClick=${() => setS((p) => ({ ...p, rules: p.rules.filter((_, j) => j !== i) }))}><${I.Trash2} size=${16} /><//></div>`)}
      <div style=${{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}><input style=${{ ...inputStyle, flex: "1 1 140px", width: "auto" }} placeholder="Texto (ex.: ENEL)" value=${rule.kw} onInput=${(e) => setRule({ ...rule, kw: e.target.value })} />
        <select style=${{ ...inputStyle, flex: "1 1 160px", width: "auto" }} value=${rule.category} onChange=${(e) => setRule({ ...rule, category: e.target.value })}>${CATS.map((c) => html`<option key=${c.key} value=${c.key}>${c.label}</option>`)}</select>
        <${Btn} disabled=${!rule.kw.trim()} onClick=${() => { setS((p) => ({ ...p, rules: [...p.rules, { kw: rule.kw.trim(), category: rule.category }] })); setRule({ ...rule, kw: "" }); }}>Adicionar<//></div>
      <div style=${{ marginTop: 10 }}><${Btn} ghost onClick=${applyAll}>Aplicar aos lançamentos sem categoria<//></div><//>
    <${Card}><h3 style=${sectionTitle}>Backup e exportação</h3>
      <div style=${{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <${Btn} onClick=${() => download(`finforme-backup-${todayStr()}.json`, JSON.stringify(s), "application/json")}><${I.Download} size=${17} /> Baixar backup<//>
        <${Btn} ghost onClick=${exportCsv}>Exportar CSV (Excel)<//></div>
      <${Field} label="Restaurar backup (arquivo)"><input type="file" accept=".json,application/json" onChange=${async (e) => { const f = e.target.files[0]; if (f) setMsg(restore(await f.text()) ? "Backup restaurado." : "Arquivo de backup inválido."); }} /><//>
      <${Field} label="…ou cole o texto do backup"><textarea style=${{ ...inputStyle, minHeight: 70 }} value=${txt} onInput=${(e) => setTxt(e.target.value)} /><//>
      <${Btn} ghost onClick=${() => setMsg(restore(txt) ? "Backup restaurado." : "Não foi possível ler este backup.")}><${I.Upload} size=${17} /> Restaurar do texto<//>
      ${msg && html`<div style=${{ marginTop: 10, fontSize: 14, color: C.teal }}>${msg}</div>`}<//>
    <div style=${{ textAlign: "center", fontSize: 12.5, color: C.textSec, margin: "4px 0 14px" }}>FinForme v${VERSION}</div>
    <${Card}><h3 style=${sectionTitle}>Limpar</h3><${Btn} ghost style=${{ color: C.alerta, borderColor: C.alerta }} onClick=${clearMonth}><${I.AlertTriangle} size=${16} /> Apagar lançamentos de ${monthLabel(monthKey)}<//><//>
    ${bank && html`<${BankModal} data=${bank} onClose=${() => setBank(null)} onSave=${(d) => { setS((p) => ({ ...p, banks: d.id ? p.banks.map((x) => (x.id === d.id ? d : x)) : [...p.banks, { ...d, id: uid() }] })); setBank(null); }}
      onDelete=${(id) => { setS((p) => ({ ...p, banks: p.banks.filter((x) => x.id !== id), tx: p.tx.map((t) => (t.bankId === id ? { ...t, bankId: "" } : t)) })); setBank(null); }} />`}
  </div>`;
}
function BankModal({ data, onSave, onDelete, onClose }) {
  const [f, setF] = useState({ name: data.name || "", acctId: data.acctId || "", initial: data.initial ? String(data.initial).replace(".", ",") : "" });
  return html`<${Modal} title="Conta bancária" onClose=${onClose}>
    <${Field} label="Nome (banco / conta)"><input style=${inputStyle} value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Itaú Conta Corrente" /><//>
    <${Field} label="Nº da conta (opcional, ajuda a reconhecer o OFX)"><input style=${inputStyle} value=${f.acctId} onInput=${(e) => setF({ ...f, acctId: e.target.value })} /><//>
    <${Field} label="Saldo inicial (R$)"><input style=${inputStyle} inputMode="decimal" value=${f.initial} onInput=${(e) => setF({ ...f, initial: e.target.value })} /><//>
    <div style=${{ fontSize: 12.5, color: C.textSec, marginBottom: 12 }}>O saldo atual = saldo inicial + todos os lançamentos vinculados à conta.</div>
    <div style=${{ display: "flex", gap: 10 }}><${Btn} full disabled=${!f.name.trim()} onClick=${() => onSave({ ...data, name: f.name.trim(), acctId: f.acctId.trim(), initial: P.parseAmount(f.initial || "0") || 0 })}>Salvar<//>
    ${data.id && html`<${Btn} ghost onClick=${() => onDelete(data.id)} style=${{ color: C.alerta, borderColor: C.alerta }}><${I.Trash2} size=${17} /><//>`}</div><//>`;
}

/* ------------------------------ App ------------------------------ */
function App() {
  const [s, setS] = useState(null);
  const [monthKey, setMonthKey] = useState(nowKey());
  const [tab, setTab] = useState("visao");
  const [modal, setModal] = useState(null);
  const [confirmBox, setConfirmBox] = useState(null);

  useEffect(() => { try { const v = localStorage.getItem(STORE) || localStorage.getItem(OLD_STORE); setS(v ? migrate(JSON.parse(v)) : initialState()); } catch { setS(initialState()); } }, []);
  useEffect(() => {
    if (!s) return;
    setS((p) => { let n = ensureRecurring(p, monthKey); n = ensureRecurring(n, nowKey()); n = ensureRecurring(n, shiftMonth(nowKey(), 1)); return n; });
  }, [monthKey, s && s.tx]);
  useEffect(() => { if (s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) { /* armazenamento cheio/bloqueado */ } } }, [s]);
  if (!s) return html`<div style=${{ padding: 40, textAlign: "center", color: C.textSec }}>Carregando…</div>`;
  CATS = s.categories || DEFAULT_CATS;

  const T = (mk) => {
    let inn = 0, out = 0;
    let toIn = 0, toOut = 0;
    s.tx.forEach((t) => { if (isTransfer(t) || effMonth(t, s.card) !== mk) return; if (!isDone(t)) { if (t.value > 0) toIn += t.value; else toOut -= t.value; return; } if (t.value > 0) inn += t.value; else out -= t.value; });
    s.purchases.forEach((p) => { const i = installmentOf(p, mk); if (i) out += i.value; });
    return { in: inn, out, toIn, toOut };
  };
  const accounts = [
    ...s.banks.map((b) => ({ id: b.id, name: b.name, balance: (b.initial || 0) + s.tx.filter((t) => isDone(t) && t.bankId === b.id && (t.method === "banco" || t.method === "pix")).reduce((a, t) => a + t.value, 0) })),
    { id: "_cash", name: "Dinheiro (caixa)", balance: (s.cashInitial || 0) + s.tx.filter((t) => isDone(t) && t.method === "dinheiro").reduce((a, t) => a + t.value, 0) },
  ];
  const monthTx = s.tx.filter((t) => isDone(t) && effMonth(t, s.card) === monthKey);
  const alerts = s.tx.filter((t) => !isDone(t) && t.method !== "cartao").map((t) => ({ t, d: dayDiff(t.date, todayStr()) })).filter((x) => x.d <= 7).sort((a, b) => a.d - b.d);
  const pend = { semNota: monthTx.filter((t) => !t.note && !t.nf).length, semCat: monthTx.filter((t) => !t.category).length, naoConf: monthTx.filter((t) => needsCheck(t) && !t.checked).length };
  const bankName = (id) => (s.banks.find((b) => b.id === id) || {}).name || "";

  const saveTx = (d) => {
    const end = d._endRec; delete d._endRec;
    setS((p) => ({ ...p, tx: d.id ? p.tx.map((t) => (t.id === d.id ? d : t)) : [...p.tx, { ...d, id: uid() }], recEnded: end ? { ...p.recEnded, [end]: d.date.slice(0, 7) } : p.recEnded }));
    setModal(null);
  };
  const delTx = (id, all) => {
    setS((p) => {
      const t = p.tx.find((x) => x.id === id);
      if (all && t && t.recId) return { ...p, tx: p.tx.filter((x) => !(x.recId === t.recId && x.date >= t.date)), recEnded: { ...p.recEnded, [t.recId]: t.date.slice(0, 7) } };
      return { ...p, tx: p.tx.filter((x) => x.id !== id) };
    });
    setModal(null);
  };
  const pay = (t) => { if (t.est) setModal({ tx: { ...t, status: "feito" } }); else setS((p) => ({ ...p, tx: p.tx.map((x) => (x.id === t.id ? { ...x, status: "feito" } : x)) })); };
  const toggle = (id) => setS((p) => ({ ...p, tx: p.tx.map((t) => (t.id === id ? { ...t, checked: !t.checked } : t)) }));
  const addTx = (method) => setModal({ tx: { method, category: "" } });
  const editTx = (t) => setModal({ tx: t });
  const openImport = (m) => setModal({ imp: m || "banco" });
  const restore = (json) => { try { const o = JSON.parse(json); if (!Array.isArray(o.tx) || !o.card) throw 0; setS(migrate(o)); return true; } catch { return false; } };
  const clearMonth = () => setConfirmBox({ text: `Apagar TODOS os lançamentos de ${monthLabel(monthKey)}? Não dá para desfazer.`, yes: () => { setS((p) => ({ ...p, tx: p.tx.filter((t) => effMonth(t, p.card) !== monthKey) })); setConfirmBox(null); } });

  const TABS = [["visao", "Visão Geral", I.LayoutDashboard], ["banco", "Bancos", I.Landmark], ["dinheiro", "Dinheiro", I.Banknote], ["pix", "PIX", I.Pix], ["cartao", "Cartão", I.CreditCard], ["ajustes", "Ajustes", I.Settings]];
  const common = { s, monthKey, onEdit: editTx, onToggle: toggle, onPay: pay, onAdd: addTx, bankName };
  return html`<div style=${{ background: C.bg, minHeight: "100vh", color: C.text, padding: "20px 14px 70px", boxSizing: "border-box" }}>
    <div style=${{ maxWidth: 860, margin: "0 auto" }}>
      <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div style=${{ display: "flex", alignItems: "center", gap: 12 }}>
          <img src="./icons/logo-icon.png" alt="FinForme" width="48" height="48" style=${{ borderRadius: 12, display: "block" }} />
          <div><h1 style=${{ fontSize: 26, margin: 0, fontWeight: 700, letterSpacing: -0.5, lineHeight: 1.1 }}><span style=${{ color: "#0A2A6B" }}>Fin</span><span style=${{ color: "#E0A41E" }}>Forme</span><span style=${{ fontSize: 11.5, fontWeight: 600, color: C.textSec, marginLeft: 8, letterSpacing: 0, verticalAlign: "middle", background: C.soft, borderRadius: 999, padding: "2px 8px" }}>v${VERSION}</span></h1>
          <div style=${{ fontSize: 13.5, color: C.textSec }}>${s.client.name || "Suas finanças. Simples assim."}</div></div></div>
        <div style=${{ display: "flex", alignItems: "center", gap: 4, background: C.card, border: `1px solid ${C.borda}`, borderRadius: 14, padding: 3 }}>
          <${IconBtn} onClick=${() => setMonthKey(shiftMonth(monthKey, -1))}><${I.ChevronLeft} /><//>
          <span style=${{ fontWeight: 600, fontSize: 14.5, minWidth: 128, textAlign: "center" }}>${MONTHS[+monthKey.slice(5) - 1]} ${monthKey.slice(0, 4)}</span>
          <${IconBtn} onClick=${() => setMonthKey(shiftMonth(monthKey, 1))}><${I.ChevronRight} /><//></div>
      </div>
      <div style=${{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8, marginBottom: 12 }}>
        ${TABS.map(([k, label, Ic]) => html`<button key=${k} onClick=${() => setTab(k)} style=${{ display: "flex", alignItems: "center", gap: 7, padding: "10px 15px", borderRadius: 13, whiteSpace: "nowrap", border: tab === k ? "none" : `1.5px solid ${C.borda}`, background: tab === k ? C.peach : C.card, color: tab === k ? "#fff" : C.text, fontWeight: 600, fontSize: 14, cursor: "pointer", minHeight: 44, fontFamily: "inherit" }}><${Ic} size=${17} />${label}</button>`)}
      </div>
      ${tab === "visao" && html`<${Visao} s=${s} monthKey=${monthKey} T=${T} accounts=${accounts} pend=${pend} goTab=${setTab} alerts=${alerts} onPay=${pay} />`}
      ${tab === "banco" && html`<${Bancos} ...${common} onImport=${() => openImport("banco")} setTab=${setTab} />`}
      ${tab === "dinheiro" && html`<${Simples} ...${common} method="dinheiro" title="dinheiro" />`}
      ${tab === "pix" && html`<${Simples} ...${common} method="pix" title="PIX" onImport=${() => openImport("banco")} />`}
      ${tab === "cartao" && html`<${CartaoTab} ...${common} setS=${setS} onImport=${() => openImport("cartao")} />`}
      ${tab === "ajustes" && html`<${Ajustes} s=${s} setS=${setS} monthKey=${monthKey} restore=${restore} clearMonth=${clearMonth} />`}
    </div>
    ${modal && modal.tx && html`<${TxModal} data=${modal.tx} state=${s} methods=${{ dinheiro: ["dinheiro"], pix: ["pix"], cartao: ["cartao"], banco: ["banco", "pix"] }[tab]} onSave=${saveTx} onDelete=${delTx} onClose=${() => setModal(null)} />`}
    ${modal && modal.imp && html`<${ImportModal} state=${s} monthKey=${monthKey} defaultMethod=${modal.imp} onClose=${() => setModal(null)}
      onImport=${(list, settles) => { setS((p) => ({ ...p, tx: [...p.tx.map((t) => { const st = (settles || []).find((x) => x.id === t.id); return st ? { ...t, ...st.patch } : t; }), ...list] })); const d = [...list, ...(settles || []).map((x) => x.patch)].map((x) => x.date).sort()[0]; if (d) setMonthKey(d.slice(0, 7)); setModal(null); }} />`}
    ${confirmBox && html`<${Modal} title="Confirmar" onClose=${() => setConfirmBox(null)}><p style=${{ marginTop: 0 }}>${confirmBox.text}</p><div style=${{ display: "flex", gap: 10 }}><${Btn} full onClick=${confirmBox.yes} style=${{ background: C.alerta, color: "#fff" }}>Apagar<//><${Btn} ghost onClick=${() => setConfirmBox(null)}>Cancelar<//></div><//>`}
  </div>`;
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
