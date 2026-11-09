// Investigador do Passado — testa milhares de regras de operação curta em 6 anos de história (modo de mentira)
const http = require("http"), fs = require("fs"), path = require("path");
const { exec } = require("child_process");
const VERSAO = "2026-11-09.3";
const PASTA = __dirname, PORTA = 4703;
const DADOS = path.join(PASTA, "dados"), ARQ_RES = path.join(PASTA, "investigador-resultado.json");
const FAKE = process.env.INV_FAKE === "1";
const PARES = ["BTC", "ETH", "BNB", "XRP", "ADA", "DOGE", "LINK", "SOL", "AVAX"];
const INICIO = Date.UTC(2020, 0, 1), CORTE = Date.UTC(2024, 0, 1); // antes do corte = treino; depois = prova
const HORA = 3600e3, TAXA_LADO = 0.0015; // 0,15% por lado = 0,3% para entrar e sair
const DIA = 86400e3, JAN = 30, META = 0.30; // meta: 1% por dia = 30% em 30 dias
function janelas(dia, a, b) { // janelas de 30 dias começando nos dias a..b
  const pre = new Float64Array(dia.length + 1); for (let i = 0; i < dia.length; i++) pre[i + 1] = pre[i] + dia[i];
  const v = []; for (let s = a; s <= b && s + JAN <= dia.length; s++) v.push(pre[s + JAN] - pre[s]);
  if (!v.length) return { n: 0, pPos: 0, pMeta: 0, min: 0, med: 0, mean: 0, max: 0 };
  const o = v.slice().sort((x, y) => x - y);
  return { n: v.length, pPos: v.filter((x) => x > 0).length / v.length, pMeta: v.filter((x) => x >= META).length / v.length, min: o[0], med: o[o.length >> 1], mean: v.reduce((p, q) => p + q, 0) / v.length / JAN, max: o[o.length - 1] };
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = []; function log(m) { logs.push({ h: new Date().toLocaleString("pt-BR"), m }); if (logs.length > 200) logs.shift(); console.log(m); }
const est = { fase: "parado", pct: 0, texto: "Pronto para começar.", rodando: false };
function setEst(fase, pct, texto) { est.fase = fase; est.pct = pct; est.texto = texto; }

// ---------- dados ----------
function falso(par, k) { // mercado inventado só para testar o programa
  let s = 1 + k * 7, rnd = () => (s = (s * 16807) % 2147483647) / 2147483647, p = 100, t = INICIO, t0 = [], o = [], h = [], l = [], c = [];
  const fim = Date.now() - (Date.now() % HORA);
  for (; t < fim; t += HORA) { const r = (rnd() + rnd() + rnd() - 1.5) * 0.012, op = p; p *= 1 + r; t0.push(t); o.push(op); h.push(Math.max(op, p) * (1 + rnd() * 0.004)); l.push(Math.min(op, p) * (1 - rnd() * 0.004)); c.push(p); }
  return { t: t0, o, h, l, c };
}
async function baixar(par) {
  const arq = path.join(DADOS, par + "USDT.json"); let d = { t: [], o: [], h: [], l: [], c: [] };
  try { d = JSON.parse(fs.readFileSync(arq, "utf8")); } catch {}
  let desde = d.t.length ? d.t[d.t.length - 1] + HORA : INICIO;
  const hosts = ["https://api.binance.com", "https://data-api.binance.vision"];
  while (desde < Date.now() - HORA) {
    let lote = null, erro;
    for (const h of hosts) { try { const r = await fetch(`${h}/api/v3/klines?symbol=${par}USDT&interval=1h&startTime=${desde}&limit=1000`, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error("HTTP " + r.status); lote = await r.json(); break; } catch (e) { erro = e; } }
    if (!lote) throw new Error(`não consegui baixar ${par}: ${erro && erro.message}`);
    if (!lote.length) break;
    for (const v of lote) { if (v[0] + HORA > Date.now()) continue; d.t.push(v[0]); d.o.push(+v[1]); d.h.push(+v[2]); d.l.push(+v[3]); d.c.push(+v[4]); }
    desde = lote[lote.length - 1][0] + HORA; await dormir(120);
    if (lote.length < 2) break;
  }
  fs.mkdirSync(DADOS, { recursive: true }); fs.writeFileSync(arq, JSON.stringify(d));
  return d;
}

// ---------- indicadores ----------
const RETS = [1, 2, 3, 6, 12, 24, 48, 72], HHS = [24, 48, 168, 336];
function preparar(d) {
  const n = d.c.length, c = d.c, h = d.h, l = d.l, o = d.o, x = { n, ...d };
  x.ret = {}; for (const N of RETS) { const a = new Float32Array(n); for (let i = N; i < n; i++) a[i] = c[i] / c[i - N] - 1; x.ret[N] = a; }
  x.hh = {}; for (const N of HHS) { const a = new Float32Array(n); for (let i = N; i < n; i++) { let m = 0; for (let k = i - N; k < i; k++) if (h[k] > m) m = h[k]; a[i] = m; } x.hh[N] = a; }
  const sma = new Float32Array(n); let ac = 0; for (let i = 0; i < n; i++) { ac += c[i]; if (i >= 720) ac -= c[i - 720]; sma[i] = i >= 719 ? ac / 720 : 0; }
  x.tend = new Uint8Array(n); for (let i = 0; i < n; i++) x.tend[i] = sma[i] > 0 && c[i] > sma[i] ? 1 : 0;
  x.rsi = new Float32Array(n).fill(50); { let g = 0, p = 0; for (let i = 1; i < n; i++) { const df = c[i] - c[i - 1]; const gg = df > 0 ? df : 0, pp = df < 0 ? -df : 0; if (i <= 14) { g += gg / 14; p += pp / 14; } else { g = (g * 13 + gg) / 14; p = (p * 13 + pp) / 14; } if (i >= 14) x.rsi[i] = p === 0 ? 100 : 100 - 100 / (1 + g / p); } }
  x.pan = new Float32Array(n); x.pos = new Float32Array(n); { let ar = 0; for (let i = 0; i < n; i++) { const r = h[i] - l[i]; x.pan[i] = i >= 48 && ar > 0 ? r / ar : 0; x.pos[i] = r > 0 ? (c[i] - l[i]) / r : 0.5; ar += r / 48; if (i >= 48) ar -= (h[i - 48] - l[i - 48]) / 48; } }
  x.hora = new Uint8Array(n); x.dow = new Uint8Array(n); x.ano = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const dt = new Date(d.t[i]); x.hora[i] = dt.getUTCHours(); x.dow[i] = dt.getUTCDay(); x.ano[i] = dt.getUTCFullYear() - 2020; }
  x.iCorte = d.t.findIndex((t) => t >= CORTE); if (x.iCorte < 0) x.iCorte = n;
  return x;
}

// ---------- regras ----------
function* configs() {
  for (const N of [3, 6, 12, 24, 48]) for (const x of [.02, .03, .04, .06, .08, .10]) for (const f of [0, 1]) for (const H of [6, 12, 24, 48, 72]) for (const s of [0, .03, .06]) for (const tp of [0, .03, .06]) yield { fam: "queda", N, x, f, H, s, tp };
  for (const L of [15, 20, 25, 30]) for (const f of [0, 1]) for (const H of [6, 12, 24, 48, 72]) for (const s of [0, .03, .06]) for (const tp of [0, .03, .06]) yield { fam: "rsi", L, f, H, s, tp };
  for (const N of HHS) for (const f of [0, 1]) for (const H of [6, 12, 24, 48]) for (const s of [0, .03, .06]) for (const tp of [0, .03, .06]) yield { fam: "rompe", N, f, H, s, tp };
  for (const k of [3, 4, 5, 6]) for (const f of [0, 1]) for (const H of [6, 12, 24, 48]) for (const s of [0, .03, .06]) for (const tp of [0, .03, .06]) yield { fam: "panico", k, f, H, s, tp };
  for (let hr = 0; hr < 24; hr++) for (const dw of [-1, 0, 1, 2, 3, 4, 5, 6]) for (const H of [1, 2, 4, 8, 12, 24]) yield { fam: "relogio", hr, dw, H, f: 0, s: 0, tp: 0 };
}
const pc = (v) => (v * 100).toFixed(0).replace(".", ",") + "%";
function descrever(g) {
  const sai = `Fica no máximo ${g.H} hora${g.H > 1 ? "s" : ""}` + (g.tp ? `, sai antes se ganhar ${pc(g.tp)}` : "") + (g.s ? ` ou se perder ${pc(g.s)}` : "") + ".";
  const fil = g.f ? " Só opera se a moeda estiver acima da média do último mês." : "";
  const dn = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  if (g.fam === "queda") return `Compra quando a moeda cai ${pc(g.x)} ou mais em ${g.N} hora${g.N > 1 ? "s" : ""}, apostando que ela volta. ${sai}${fil}`;
  if (g.fam === "rsi") return `Compra quando a moeda fica "esgotada" (índice RSI abaixo de ${g.L}), apostando na volta. ${sai}${fil}`;
  if (g.fam === "rompe") return `Compra quando a moeda passa do preço mais alto dos últimos ${g.N >= 168 ? g.N / 24 + " dias" : g.N + " horas"}, apostando que continua subindo. ${sai}${fil}`;
  if (g.fam === "panico") return `Compra depois de uma hora de pânico (vela ${g.k}× maior que o normal, fechando perto da mínima), apostando na volta. ${sai}${fil}`;
  return `Compra todo dia às ${String(g.hr).padStart(2, "0")}h (horário de Londres)${g.dw >= 0 ? ", só na " + dn[g.dw] : ""} e vende ${g.H} hora${g.H > 1 ? "s" : ""} depois.`;
}
function sinal(g, x) {
  const f = g.f ? x.tend : null;
  switch (g.fam) {
    case "queda": { const r = x.ret[g.N], lim = -g.x; return f ? (i) => r[i] <= lim && f[i] === 1 : (i) => r[i] <= lim; }
    case "rsi": { const r = x.rsi, L = g.L; return f ? (i) => r[i] < L && f[i] === 1 : (i) => r[i] < L; }
    case "rompe": { const hh = x.hh[g.N], c = x.c; return f ? (i) => hh[i] > 0 && c[i] > hh[i] && f[i] === 1 : (i) => hh[i] > 0 && c[i] > hh[i]; }
    case "panico": { const p = x.pan, ps = x.pos, k = g.k, c = x.c, o = x.o; return (i) => p[i] >= k && ps[i] < 0.25 && c[i] < o[i] && (!f || f[i] === 1); }
    default: { const hr = x.hora, dw = x.dow, H = g.hr, D = g.dw; return D < 0 ? (i) => hr[i] === H : (i) => hr[i] === H && dw[i] === D; }
  }
}
// roda a regra num par; chama cb(indiceEntrada, retornoLiquido, indiceSaida)
function simular(g, x, cb) {
  const sig = sinal(g, x), n = x.n, o = x.o, h = x.h, l = x.l, c = x.c, H = g.H, s = g.s, tp = g.tp, tx = 2 * TAXA_LADO;
  let i = 800;
  while (i < n - 2) {
    if (!sig(i)) { i++; continue; }
    const e = o[i + 1], ps = s ? e * (1 - s) : 0, pt = tp ? e * (1 + tp) : 0, ult = Math.min(i + H, n - 1);
    let k = i + 1, sai = c[ult], ik = ult;
    for (; k <= ult; k++) {
      if (s && l[k] <= ps) { sai = Math.min(o[k], ps); ik = k; break; }
      if (tp && h[k] >= pt) { sai = Math.max(o[k], pt); ik = k; break; }
    }
    cb(i + 1, sai / e - 1 - tx, ik); i = ik + 1;
  }
}

// ---------- investigação ----------
async function investigar() {
  est.rodando = true; logs.length = 0;
  try {
    const X = [];
    for (let k = 0; k < PARES.length; k++) {
      setEst("baixando", Math.round((k / PARES.length) * 25), `Baixando o histórico de ${PARES[k]} (6 anos, hora a hora)…`);
      const d = FAKE ? falso(PARES[k], k) : await baixar(PARES[k]);
      if (d.c.length < 2000) { log(`${PARES[k]}: histórico curto demais, ignorado.`); continue; }
      const x = preparar(d); x.par = PARES[k]; X.push(x);
      log(`${PARES[k]}: ${d.c.length} velas, desde ${new Date(d.t[0]).toLocaleDateString("pt-BR")}.`); await dormir(0);
    }
    if (X.length < 3) throw new Error("Poucos pares com histórico. Veja a internet e tente de novo.");
    const NA = new Date().getUTCFullYear() - 2020 + 1;
    const anosDados = new Float64Array(NA), anosTreino = { v: 0 }, anosProva = { v: 0 };
    for (const x of X) { for (let i = 0; i < x.n; i++) anosDados[x.ano[i]] += 1 / 8766; anosTreino.v += Math.min(x.iCorte, x.n) / 8766; anosProva.v += (x.n - x.iCorte) / 8766; }
    // quanto o "só segurar" faria, por ano e cesta igual
    const seg = new Float64Array(NA), segN = new Float64Array(NA);
    for (const x of X) { const ini = new Array(NA).fill(0), fim = new Array(NA).fill(0); for (let i = 0; i < x.n; i++) { if (!ini[x.ano[i]]) ini[x.ano[i]] = x.o[i]; fim[x.ano[i]] = x.c[i]; } for (let a = 0; a < NA; a++) if (ini[a]) { seg[a] += fim[a] / ini[a] - 1; segN[a]++; } }
    const segurar = Array.from(seg, (v, a) => (segN[a] ? v / segN[a] : 0));
    const ND = Math.ceil((Date.now() - INICIO) / DIA) + 1, cortDia = Math.floor((CORTE - INICIO) / DIA), NP = X.length;
    const todos = [], lista = Array.from(configs()), total = lista.length;
    for (let q = 0; q < total; q++) {
      const g = lista[q], dia = new Float64Array(ND), soma = new Float64Array(NA), cnt = new Int32Array(NA), win = new Int32Array(NA); let sT = 0, nT = 0, sP = 0, nP = 0;
      for (const x of X) simular(g, x, (ie, r, is) => { dia[Math.floor((x.t[is] - INICIO) / DIA)] += r / NP; const a = x.ano[ie]; soma[a] += r; cnt[a]++; if (r > 0) win[a]++; if (ie < x.iCorte) { sT += r; nT++; } else { sP += r; nP++; } });
      if (nT + nP >= 150) todos.push({ g, soma: Array.from(soma), cnt: Array.from(cnt), win: Array.from(win), sT, nT, sP, nP, treino: sT / anosTreino.v, prova: sP / anosProva.v, j: janelas(dia, 0, ND), jT: janelas(dia, 0, cortDia - JAN), jP: janelas(dia, cortDia, ND) });
      if (q % 60 === 0) { setEst("testando", 25 + Math.round((q / total) * 70), `Testando regras: ${q} de ${total} (${todos.length} fizeram operações suficientes)…`); await dormir(0); }
    }
    setEst("finalizando", 96, "Escolhendo as melhores e montando os gráficos…");
    const res = montar(X, todos, total, segurar, anosTreino.v, anosProva.v, NA);
    fs.writeFileSync(ARQ_RES, JSON.stringify(res));
    XC = null; setEst("pronto", 100, "Pronto! Resultado abaixo."); log("Investigação concluída.");
  } catch (e) { log("Erro: " + e.message); setEst("erro", 0, "Deu erro: " + e.message); }
  est.rodando = false;
}
function curva(g, X) { // carteira dividida igualmente entre os pares; cada operação mexe só na fatia do par
  const tr = []; for (const x of X) simular(g, x, (ie, r, is) => tr.push([x.t[is], r]));
  tr.sort((a, b) => a[0] - b[0]); const N = X.length; let e = 1, pts = [], prox = 0; const pior = { dd: 0 }; let topo = 1;
  for (const [t, r] of tr) { e *= 1 + r / N; if (e > topo) topo = e; pior.dd = Math.min(pior.dd, e / topo - 1); if (t >= prox) { pts.push([t, e]); prox = t + 15 * 24 * HORA; } }
  pts.push([tr.length ? tr[tr.length - 1][0] : 0, e]);
  const bh = []; { let p2 = 0; const t0 = Math.max(...X.map((x) => x.t[0])); for (let t = t0; t <= Date.now(); t += 15 * 24 * HORA) { let v = 0; for (const x of X) { const j = Math.min(x.n - 1, Math.max(0, Math.round((t - x.t[0]) / HORA))); v += x.c[j] / x.c[Math.round((t0 - x.t[0]) / HORA)]; } bh.push([t, v / X.length]); } }
  const porPar = X.map((x) => { let sT = 0, sP = 0, n = 0; simular(g, x, (ie, r) => { n++; if (ie < x.iCorte) sT += r; else sP += r; }); return { par: x.par, treino: sT / (Math.min(x.iCorte, x.n) / 8766), prova: sP / ((x.n - x.iCorte) / 8766 || 1), ops: n }; });
  return { pts, bh, maxQueda: pior.dd, final: e, porPar };
}
function diario(g, X) { // blocos de 30 dias seguidos, carteira dividida entre as moedas
  const ND = Math.ceil((Date.now() - INICIO) / DIA) + 1, dia = new Float64Array(ND);
  for (const x of X) simular(g, x, (ie, r, is) => { dia[Math.floor((x.t[is] - INICIO) / DIA)] += r / X.length; });
  const blocos = []; for (let s = 0; s + JAN <= ND; s += JAN) { let t = 0; for (let k = s; k < s + JAN; k++) t += dia[k]; blocos.push([INICIO + s * DIA, t]); }
  return blocos;
}
const BICHOS = ["Raposa", "Lobo", "Falcão", "Pantera", "Tubarão", "Coruja", "Jacaré", "Urso", "Tigre", "Águia", "Cobra", "Leão"];
function nomear(g, frac) {
  const h = [...JSON.stringify(g)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7), b = BICHOS[h % BICHOS.length];
  const base = { queda: `Queda ${Math.round(g.x * 100)}% em ${g.N}h`, rsi: `RSI abaixo de ${g.L}`, rompe: `Rompe máxima de ${g.N >= 168 ? g.N / 24 + "d" : g.N + "h"}`, panico: `Pânico ${g.k}×`, relogio: `Relógio ${g.hr}h${g.dw >= 0 ? " dia " + g.dw : ""}` }[g.fam];
  return `${b} · ${base} · sai em ${g.H}h · ${frac}% por vez`;
}
function cenarios(X, todos, porMeta, consist, sobrev) {
  const lista = [], vistos = new Set();
  const add = (tipo, t, fracs) => { if (!t) return; let melhor = null; for (const f of fracs) { const c = carteira(t.g, X, f); if (!melhor || c.final > melhor.final) melhor = c; } const k = JSON.stringify([t.g, melhor.fracPct]); if (vistos.has(k)) return; vistos.add(k);
    const { pts, bh, blocos, ...res } = melhor; lista.push({ tipo, nome: nomear(t.g, melhor.fracPct), ...res }); };
  const top = todos.filter((t) => t.nT + t.nP >= 150).sort((a, b) => (b.sT + b.sP) - (a.sT + a.sP)).slice(0, 25);
  let best = null; for (const t of top) for (const f of [100, 50]) { const c = carteira(t.g, X, f); if (!best || c.final > best.c.final) best = { t, c, f }; }
  if (best) add("🏆 Melhor cenário imaginável (olhando o passado)", best.t, [best.f]);
  add("🛡 Mais constante (lucro em mais períodos de 30 dias)", consist[0], [100, 50]);
  add("🎯 Mais vezes na meta de 1% por dia", porMeta[0], [100, 50]);
  add("✅ Melhor sobrevivente (lucro no treino e na prova)", sobrev[0], [100, 50]);
  return lista;
}
function montar(X, todos, total, segurar, aT, aP, NA) {
  const lim = (t) => ({ g: t.g, desc: descrever(t.g), treino: t.treino, prova: t.prova, nT: t.nT, nP: t.nP, anos: t.soma.map((s, a) => { const nn = t.cnt[a]; return nn ? { ret: s, ops: nn, acerto: t.win[a] / nn } : null; }), media: (t.sT + t.sP) / (aT + aP), j: t.j, jT: t.jT, jP: t.jP, opsMedia: (t.nT + t.nP) / (aT + aP) });
  const pos = todos.filter((t) => t.nT >= 150 && t.nP >= 80);
  const melhorTotal = todos.slice().sort((a, b) => (b.sT + b.sP) - (a.sT + a.sP))[0];
  const porTreino = pos.filter((t) => t.treino > 0).sort((a, b) => b.treino - a.treino);
  const sobrev = pos.filter((t) => t.treino > 0 && t.prova > 0).sort((a, b) => Math.min(b.treino, b.prova) - Math.min(a.treino, a.prova));
  const top50 = porTreino.slice(0, 50), top10 = porTreino.slice(0, 10);
  const media = (arr, k) => (arr.length ? arr.reduce((s, t) => s + t[k], 0) / arr.length : 0);
  const gl = (t) => { const o = lim(t); Object.assign(o, curva(t.g, X)); return o; };
  const estat = {
    total, comOps: todos.length, lucroTreino: todos.filter((t) => t.treino > 0).length, lucroProva: todos.filter((t) => t.prova > 0).length,
    lucroAmbos: todos.filter((t) => t.treino > 0 && t.prova > 0).length, top50Treino: media(top50, "treino"), top50Prova: media(top50, "prova"),
    top50Sobrevivem: top50.filter((t) => t.prova > 0).length, top10Sobrevivem: top10.filter((t) => t.prova > 0).length,
    mediaTodasProva: media(todos, "prova"), mediaTodasTreino: media(todos, "treino"), anosTreino: aT, anosProva: aP,
  };
  const ok = todos.filter((t) => t.nT + t.nP >= 150 && t.j.n);
  const porMeta = ok.slice().sort((a, b) => b.j.pMeta - a.j.pMeta || b.j.mean - a.j.mean).slice(0, 8);
  const consist = ok.filter((t) => t.j.mean > 0 && t.jT.n && t.jP.n).sort((a, b) => Math.min(b.jT.pPos, b.jP.pPos) - Math.min(a.jT.pPos, a.jP.pPos) || b.j.min - a.j.min).slice(0, 8);
  const comBlocos = (t) => { const o = lim(t); o.blocos = diario(t.g, X); return o; };
  const meta30 = {
    limite: META, melhorPMeta: porMeta[0] ? porMeta[0].j.pMeta : 0, melhorPPos: ok.reduce((m, t) => Math.max(m, t.j.pPos), 0),
    qtdSempre: ok.filter((t) => t.j.pPos >= 0.999).length, qtdMeta50: ok.filter((t) => t.j.pMeta >= 0.5).length,
    porMeta: porMeta.map(lim), consist: consist.map(lim), topMeta: porMeta[0] ? comBlocos(porMeta[0]) : null, topConsist: consist[0] ? comBlocos(consist[0]) : null,
  };
  const cen = cenarios(X, todos, porMeta, consist, sobrev);
  return {
    cenarios: cen, meta30, quando: new Date().toISOString(), pares: X.map((x) => ({ par: x.par, desde: x.t[0], velas: x.n })), segurar, anoIni: 2020, estat,
    hindsight: melhorTotal ? gl(melhorTotal) : null,
    honestos: sobrev.slice(0, 12).map(lim), honestoTop: sobrev[0] ? gl(sobrev[0]) : null,
    porFamilia: ["queda", "rsi", "rompe", "panico", "relogio"].map((f) => { const a = todos.filter((t) => t.g.fam === f); return { fam: f, n: a.length, treino: media(a, "treino"), prova: media(a, "prova"), ambos: a.filter((t) => t.treino > 0 && t.prova > 0).length }; }),
  };
}

// ---------- carteira (explorador) ----------
let XC = null;
async function dadosMem() {
  if (XC) return XC; const X = [];
  for (let k = 0; k < PARES.length; k++) {
    const par = PARES[k]; let d;
    if (FAKE) d = falso(par, k); else { try { d = JSON.parse(fs.readFileSync(path.join(DADOS, par + "USDT.json"), "utf8")); } catch { continue; } }
    if (d.c.length < 2000) continue; const x = preparar(d); x.par = par; X.push(x);
  }
  if (X.length < 3) throw new Error("Primeiro clique em ▶ Começar a investigar (aba Investigar) para baixar o histórico.");
  XC = X; return X;
}
function fundir(g) { // valida o que veio da tela
  const num = (v, a, b, d) => { v = +v; return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  const fam = ["queda", "rsi", "rompe", "panico", "relogio"].includes(g.fam) ? g.fam : "queda";
  const o = { fam, H: Math.round(num(g.H, 1, 168, 24)), s: num(g.s, 0, 0.5, 0), tp: num(g.tp, 0, 0.5, 0), f: g.f ? 1 : 0 };
  if (fam === "queda") { o.N = RETS.includes(+g.N) ? +g.N : 24; o.x = num(g.x, 0.005, 0.5, 0.04); }
  if (fam === "rsi") o.L = num(g.L, 5, 50, 25);
  if (fam === "rompe") o.N = HHS.includes(+g.N) ? +g.N : 168;
  if (fam === "panico") o.k = num(g.k, 2, 12, 4);
  if (fam === "relogio") { o.hr = Math.round(num(g.hr, 0, 23, 12)); o.dw = Math.round(num(g.dw, -1, 6, -1)); o.f = 0; }
  return o;
}
function bhPts(X) {
  const bh = [], t0 = Math.max(...X.map((x) => x.t[0])), tf = Math.max(...X.map((x) => x.t[x.n - 1]));
  for (let t = t0; t <= tf; t += 7 * DIA) { let v = 0; for (const x of X) { const j = Math.min(x.n - 1, Math.max(0, Math.round((t - x.t[0]) / HORA))); v += x.c[j] / x.c[Math.round((t0 - x.t[0]) / HORA)]; } bh.push([t, v / X.length]); }
  return bh;
}
function carteira(g, X, fracPct) {
  const frac = Math.min(1, Math.max(0.05, fracPct / 100)), K = Math.max(1, Math.round(1 / frac)), tr = [];
  for (const x of X) simular(g, x, (ie, r, is) => tr.push([x.t[ie], x.t[is], r]));
  tr.sort((a, b) => a[0] - b[0]);
  const tf = Math.max(...X.map((x) => x.t[x.n - 1])), ND = Math.floor((tf - INICIO) / DIA) + 1;
  let eq = 1, open = [], nTr = 0, wins = 0; const ev = [];
  const fechar = (ate) => { open.sort((a, b) => a.sai - b.sai); while (open.length && open[0].sai <= ate) { const o = open.shift(); eq += o.stake * o.r; if (o.r > 0) wins++; ev.push([o.sai, eq]); } };
  for (const [te, ts, r] of tr) { fechar(te); if (open.length < K) { open.push({ sai: ts, r, stake: frac * eq }); nTr++; } }
  fechar(Infinity);
  const dia = new Float64Array(ND); { let e = 1, p = 0; for (let d = 0; d < ND; d++) { const fimDia = INICIO + (d + 1) * DIA; while (p < ev.length && ev[p][0] < fimDia) { e = ev[p][1]; p++; } dia[d] = e; } }
  const jan = (a, b) => { const v = []; for (let s0 = a; s0 <= b && s0 + JAN < ND; s0++) v.push(dia[s0 + JAN] / dia[s0] - 1); if (!v.length) return { n: 0, pPos: 0, pMeta: 0, min: 0, med: 0, max: 0 }; const o = v.slice().sort((x, y) => x - y); return { n: v.length, pPos: v.filter((x) => x > 0).length / v.length, pMeta: v.filter((x) => x >= META).length / v.length, min: o[0], med: o[o.length >> 1], max: o[o.length - 1] }; };
  const cortDia = Math.floor((CORTE - INICIO) / DIA), blocos = [];
  for (let s0 = 0; s0 + JAN < ND; s0 += JAN) blocos.push([INICIO + s0 * DIA, dia[s0 + JAN] / dia[s0] - 1]);
  const anos = []; for (let a = 0; a < 8; a++) { const d0 = Math.floor((Date.UTC(2020 + a, 0, 1) - INICIO) / DIA), d1 = Math.min(ND - 1, Math.floor((Date.UTC(2021 + a, 0, 1) - INICIO) / DIA) - 1); if (d0 >= ND) break; anos.push(dia[d1] / (d0 > 0 ? dia[d0 - 1] : 1) - 1); }
  let topo = 1, dd = 0; for (let d = 0; d < ND; d++) { if (dia[d] > topo) topo = dia[d]; dd = Math.min(dd, dia[d] / topo - 1); }
  const pts = []; for (let d = 0; d < ND; d += 7) pts.push([INICIO + d * DIA, dia[d]]); pts.push([INICIO + (ND - 1) * DIA, dia[ND - 1]]);
  return { desc: descrever(g), g, fracPct: Math.round(frac * 100), K, ops: nTr, acerto: nTr ? wins / nTr : 0, final: eq, dias: ND, porDia: Math.pow(Math.max(eq, 1e-9), 1 / ND) - 1, janelas: jan(0, ND), janT: jan(0, cortDia - JAN), janP: jan(cortDia, ND), blocos, anos, maxQueda: dd, pts, bh: bhPts(X) };
}

// ---------- simulação ao vivo (dinheiro de mentira) ----------
const SIM_ARQ = path.join(PASTA, "sim-estado.json");
let sim = null, simTimer = null;
try { sim = JSON.parse(fs.readFileSync(SIM_ARQ, "utf8")); } catch {}
const simSalvar = () => { try { fs.writeFileSync(SIM_ARQ, JSON.stringify(sim)); } catch {} };
async function velasVivas(par) {
  let erro; for (const h of ["https://api.binance.com", "https://data-api.binance.vision"]) {
    try { const r = await fetch(`${h}/api/v3/klines?symbol=${par}USDT&interval=1h&limit=1000`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(); const d = { t: [], o: [], h: [], l: [], c: [] }; for (const v of j) { d.t.push(v[0]); d.o.push(+v[1]); d.h.push(+v[2]); d.l.push(+v[3]); d.c.push(+v[4]); } return d; } catch (e) { erro = e; }
  } throw erro;
}
function velasFalsas(par) { const d = falso(par, PARES.indexOf(par)); const n = d.c.length, a = n - 1000; return { t: d.t.slice(a), o: d.o.slice(a), h: d.h.slice(a), l: d.l.slice(a), c: d.c.slice(a) }; }
const velasCache = {};
async function velasGrafico(par, tf) {
  tf = ["5m", "15m", "1h"].includes(tf) ? tf : "1h"; par = PARES.includes(par) ? par : "BTC"; const k = par + tf, ag = Date.now();
  if (velasCache[k] && ag - velasCache[k].em < 8000) return velasCache[k].v;
  let v;
  if (FAKE) { const d = falso(par, PARES.indexOf(par)), n = d.t.length; v = d.t.slice(n - 150).map((t, i) => ({ t, o: d.o[n - 150 + i], h: d.h[n - 150 + i], l: d.l[n - 150 + i], c: d.c[n - 150 + i] })); }
  else { const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${par}USDT&interval=${tf}&limit=150`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error("HTTP " + r.status); v = (await r.json()).map((a) => ({ t: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4] })); }
  velasCache[k] = { em: ag, v }; return v;
}
function simValor() { let v = sim.caixa; for (const p of sim.abertas) v += p.valor * (sim.px[p.par] / p.entrada); return v; }
async function simCiclo() {
  if (!sim || !sim.ativo) return;
  try {
    const g = sim.g, FE = TAXA_LADO, agora = Date.now();
    for (const par of PARES) {
      let d; try { d = FAKE ? velasFalsas(par) : await velasVivas(par); } catch (e) { sim.erro = `${par}: ${e.message}`; continue; }
      sim.erro = null; const x = preparar(d), n = x.n, forma = FAKE || d.t[n - 1] + HORA > agora, c = forma ? n - 2 : n - 1;
      sim.px[par] = d.c[n - 1]; sim.pares = sim.pares || {}; sim.pares[par] = { preco: d.c[n - 1], sinal: c >= 800 ? !!sinal(g, x)(c) : false, em: agora }; if (!sim.base[par]) sim.base[par] = d.c[n - 1];
      // saídas
      for (const p of sim.abertas.filter((q) => q.par === par)) {
        const k0 = d.t.indexOf(p.tEnt); let saiu = null;
        if (k0 < 0) saiu = { preco: d.c[n - 1], motivo: "perdi o rastro, saí a mercado" };
        else for (let k = k0; k < n && !saiu; k++) {
          if (g.s && d.l[k] <= p.entrada * (1 - g.s)) saiu = { preco: Math.min(d.o[k], p.entrada * (1 - g.s)), motivo: "stop" };
          else if (g.tp && d.h[k] >= p.entrada * (1 + g.tp)) saiu = { preco: Math.max(d.o[k], p.entrada * (1 + g.tp)), motivo: "alvo" };
          else if (k >= k0 + g.H - 1 && k <= c) saiu = { preco: d.c[k], motivo: "tempo" };
        }
        if (saiu) { const rec = p.valor * (saiu.preco / p.entrada) * (1 - FE); sim.caixa += rec; sim.abertas = sim.abertas.filter((q) => q !== p); sim.hist.unshift({ par, tEnt: p.tEnt, quando: agora, entrada: p.entrada, saida: saiu.preco, ret: rec / p.custo - 1, lucro: rec - p.custo, motivo: saiu.motivo }); sim.hist = sim.hist.slice(0, 300); sim.nOps++; if (rec > p.custo) sim.nWin++; }
      }
      // entrada
      if (c >= 800 && forma && (sim.visto[par] || 0) < d.t[c] && !sim.abertas.some((q) => q.par === par)) {
        sim.visto[par] = d.t[c];
        if (sinal(g, x)(c) && sim.abertas.length < sim.K) { const tot = simValor(), custo = Math.min(sim.caixa, sim.frac * tot); if (custo > 1) { sim.caixa -= custo; sim.abertas.push({ par, tEnt: d.t[n - 1], entrada: d.o[n - 1], custo, valor: custo * (1 - FE), quando: agora }); } }
      }
    }
    const v = simValor(); sim.ultimo = agora; if (!sim.pts.length || agora - sim.pts[sim.pts.length - 1][0] > 5 * 60e3) { sim.pts.push([agora, v]); if (sim.pts.length > 3000) sim.pts = sim.pts.filter((_, i) => i % 2 === 0); }
    simSalvar();
  } catch (e) { sim.erro = e.message; }
}
function simLigar() { clearInterval(simTimer); simTimer = setInterval(simCiclo, 20e3); simCiclo(); }
function simIniciar(valor, g, fracPct) {
  const frac = Math.min(1, Math.max(0.05, fracPct / 100));
  sim = { ativo: true, inicio: Date.now(), valor0: valor, caixa: valor, g, desc: descrever(g), frac, K: Math.max(1, Math.round(1 / frac)), abertas: [], hist: [], nOps: 0, nWin: 0, px: {}, base: {}, visto: {}, pts: [[Date.now(), valor]], erro: null };
  simSalvar(); simLigar();
}
function simResumo() {
  if (!sim) return { vazio: true };
  const v = simValor(), dias = Math.max((Date.now() - sim.inicio) / DIA, 1 / 24);
  let bh = 0, nb = 0; for (const par of PARES) if (sim.base[par] && sim.px[par]) { bh += sim.px[par] / sim.base[par]; nb++; }
  return { ...sim, valorAtual: v, retorno: v / sim.valor0 - 1, porDia: Math.pow(v / sim.valor0, 1 / dias) - 1, diasRodando: dias, segurar: nb ? bh / nb - 1 : 0, abertasVivas: sim.abertas.map((p) => ({ ...p, atual: sim.px[p.par], ret: sim.px[p.par] / p.entrada - 1 })) };
}

// ---------- atualização automática (puxa do GitHub) ----------
const RAW = "https://raw.githubusercontent.com/marcelo692/robos-cripto/main/Investigador/";
async function atualizarDoGithub() {
  const t = Date.now(), man = await (await fetch(RAW + "manifest.json?t=" + t, { signal: AbortSignal.timeout(20000) })).json();
  const nomes = (man.arquivos || []).filter((n) => /^[A-Za-z0-9 _.\-]+\.(js|html|bat)$/.test(n));
  if (!nomes.length) throw new Error("A lista de arquivos veio vazia.");
  const novos = {};
  for (const n of nomes) {
    const r = await fetch(RAW + encodeURIComponent(n) + "?t=" + t, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`Não achei ${n} (HTTP ${r.status}).`);
    const txt = await r.text(); if (txt.length < 50) throw new Error(`${n} veio vazio.`);
    if (n.endsWith(".js")) new (require("vm").Script)(txt, { filename: n }); // só confere se não está quebrado
    novos[n] = n.endsWith(".bat") ? txt.replace(/\r?\n/g, "\r\n") : txt;
  }
  let mudou = 0, precisaReiniciar = false;
  for (const [n, txt] of Object.entries(novos)) { const f = path.join(PASTA, n); let velho = ""; try { velho = fs.readFileSync(f, "utf8"); } catch {} if (velho !== txt) { fs.writeFileSync(f, txt); mudou++; if (!n.endsWith(".html")) precisaReiniciar = true; } }
  return { versao: man.versao || "?", mudou, precisaReiniciar };
}
const corpo = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });

// ---------- reiniciar ----------
function reiniciar(servidor, bat) {
  try { servidor.closeAllConnections && servidor.closeAllConnections(); } catch {}
  servidor.close(() => { exec(`start "" "${bat}"`, { cwd: PASTA, env: { ...process.env, ROBO_REINICIO: "1" } }); setTimeout(() => process.exit(75), 800); });
  setTimeout(() => process.exit(75), 6000);
}

// ---------- servidor ----------
const json = (res, o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const servidor = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(fs.readFileSync(path.join(PASTA, "investigador.html"))); }
    if (req.url === "/status") return json(res, { ...est, logs: logs.slice(-30) });
    if (req.url === "/resultado") { let r = null; try { r = JSON.parse(fs.readFileSync(ARQ_RES, "utf8")); } catch {} return json(res, r || { vazio: true }); }
    if (req.method === "POST" && req.url === "/iniciar") { if (!est.rodando) investigar(); return json(res, { ok: true }); }
    if (req.method === "POST" && req.url === "/reiniciar") { if (est.rodando) return json(res, { erro: "Ele está no meio de uma investigação. Espere terminar." }); json(res, { ok: true }); return reiniciar(servidor, path.join(PASTA, "ABRIR INVESTIGADOR.bat")); }
    if (req.method === "POST" && req.url === "/testar") { const b = await corpo(req); try { const X = await dadosMem(); return json(res, carteira(fundir(b.g || {}), X, +b.frac || 100)); } catch (e) { return json(res, { erro: e.message }); } }
    if (req.method === "POST" && req.url === "/atualizar") { try { return json(res, await atualizarDoGithub()); } catch (e) { return json(res, { erro: "Não consegui atualizar: " + e.message }); } }
    if (req.url === "/versao") return json(res, { versao: VERSAO });
    if (req.url.startsWith("/sim/velas")) { const u = new URL(req.url, "http://x"), par = u.searchParams.get("par"), tf = u.searchParams.get("tf"); try { const v = await velasGrafico(par, tf); const m = { compras: [], vendas: [], abertas: [] }; if (sim) { for (const p of sim.abertas) if (p.par === par) m.abertas.push({ t: p.tEnt, entrada: p.entrada, stop: sim.g.s ? p.entrada * (1 - sim.g.s) : 0, alvo: sim.g.tp ? p.entrada * (1 + sim.g.tp) : 0 }); for (const h of sim.hist) if (h.par === par) { m.compras.push({ t: h.tEnt, preco: h.entrada }); m.vendas.push({ t: h.quando, preco: h.saida, ret: h.ret }); } for (const p of sim.abertas) if (p.par === par) m.compras.push({ t: p.tEnt, preco: p.entrada }); } return json(res, { par, tf: tf || "1h", velas: v, ...m }); } catch (e) { return json(res, { erro: e.message }); } }
    if (req.url === "/sim/estado") return json(res, simResumo());
    if (req.method === "POST" && req.url === "/sim/iniciar") { const b = await corpo(req), v = +b.valor; if (!(v >= 10)) return json(res, { erro: "Coloque um valor de pelo menos 10." }); simIniciar(v, fundir(b.g || {}), +b.frac || 100); return json(res, { ok: true }); }
    if (req.method === "POST" && req.url === "/sim/parar") { if (sim) { sim.ativo = false; simSalvar(); } clearInterval(simTimer); return json(res, { ok: true }); }
    if (req.method === "POST" && req.url === "/sim/zerar") { clearInterval(simTimer); sim = null; try { fs.unlinkSync(SIM_ARQ); } catch {} return json(res, { ok: true }); }
    res.writeHead(404); res.end("não achei");
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
servidor.on("error", (e) => { if (e.code === "EADDRINUSE") { exec(`start "" "http://localhost:${PORTA}"`); setTimeout(() => process.exit(0), 1500); } else console.error(e); });
servidor.listen(PORTA, "127.0.0.1", () => {
  const url = `http://localhost:${PORTA}`; console.log("Investigador do Passado aberto em " + url + " (não feche esta janela)");
  if (!FAKE && !process.env.ROBO_REINICIO && process.platform === "win32") exec(`start "" "${url}"`);
  if (sim && sim.ativo) simLigar();
});
