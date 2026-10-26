/**
 * App de Treino — back-end em Google Apps Script, vinculado à planilha.
 *
 * Publicação (RT-10): Implantar > Nova implantação > App da Web
 *   Executar como: Eu (dono) · Quem pode acessar: Qualquer pessoa
 *
 * Primeira vez: rode setup() no editor. Ele cria as abas, os valores padrão
 * da aba Config e gera o TOKEN nas Script Properties (veja em Execuções > Log).
 *
 * API
 *   GET  ?token=…&acao=ping        → { ok, versao, planilha, agora }
 *   GET  ?token=…&acao=bootstrap   → { ok, dados: { exercicios, planos, itens, config, historico, recordes } }
 *   POST (Content-Type text/plain) { token, ops: [{ op: 'upsert'|'delete', aba, id, dados }] } → { ok, aplicados }
 *
 * upsert por ID é idempotente: reenviar a mesma operação não duplica linhas (RT-08).
 */

const VERSAO = '1.0.0';

const ABAS = {
  Exercicios: ['exercicio_id', 'nome', 'grupo_muscular', 'equipamento', 'incremento_kg', 'carga_inicial_kg', 'ativo'],
  Planos: ['plano_id', 'nome', 'ordem', 'ativo'],
  PlanoItens: ['item_id', 'plano_id', 'ordem', 'exercicio_id', 'series', 'reps_min', 'reps_max', 'descanso_s', 'obs'],
  Sessoes: ['sessao_id', 'plano_id', 'plano_nome', 'inicio', 'fim', 'duracao_s', 'encerramento',
    'series_planejadas', 'series_feitas', 'volume_kg', 'obs'],
  Series: ['serie_id', 'sessao_id', 'exercicio_id', 'ordem_exercicio', 'n_serie', 'aquecimento', 'peso_kg', 'reps', 'rir',
    'sugerido_peso_kg', 'sugerido_reps', 'descanso_real_s', 'registrado_em'],
  Config: ['chave', 'valor'],
};

// Guardadas como texto para o Sheets não converter datas ISO nem IDs.
const COLUNAS_TEXTO = ['inicio', 'fim', 'registrado_em'];

const CONFIG_PADRAO = [
  ['descanso_padrao_s', 90],
  ['aviso_antecipado_s', 10],
  ['series_padrao', 3],
  ['reps_min_padrao', 8],
  ['reps_max_padrao', 12],
  ['historico_sessoes', 5],
];

// ---------------------------------------------------------------- HTTP

function doGet(e) {
  return responder_(function () {
    const p = (e && e.parameter) || {};
    verificarToken_(p.token);
    const acao = p.acao || 'bootstrap';
    if (acao === 'ping') {
      return { versao: VERSAO, planilha: SpreadsheetApp.getActive().getName(), agora: agoraIso_() };
    }
    if (acao === 'bootstrap') return { dados: bootstrap_() };
    throw new Error('Ação desconhecida: ' + acao);
  });
}

function doPost(e) {
  return responder_(function () {
    let corpo;
    try {
      corpo = JSON.parse(e.postData.contents);
    } catch (err) {
      throw new Error('Corpo JSON inválido');
    }
    verificarToken_(corpo.token);
    const ops = Array.isArray(corpo.ops) ? corpo.ops : [];
    const lock = LockService.getScriptLock(); // RT-13
    if (!lock.tryLock(30000)) throw new Error('Planilha ocupada, tente de novo');
    try {
      return { aplicados: aplicarOps_(ops) };
    } finally {
      lock.releaseLock();
    }
  });
}

function responder_(fn) {
  let out;
  try {
    out = Object.assign({ ok: true }, fn());
  } catch (err) {
    out = { ok: false, erro: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function verificarToken_(t) {
  const tok = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!tok) throw new Error('TOKEN não configurado nas Script Properties (rode setup())');
  if (!t || String(t) !== tok) throw new Error('Token inválido');
}

// ---------------------------------------------------------------- gravação

function aplicarOps_(ops) {
  const porAba = {};
  const ordem = [];
  ops.forEach(function (op, i) {
    if (!op || !ABAS[op.aba]) throw new Error('Operação ' + i + ': aba inválida');
    if (op.op !== 'upsert' && op.op !== 'delete') throw new Error('Operação ' + i + ': op inválida');
    if (op.id === undefined || op.id === null || op.id === '') throw new Error('Operação ' + i + ': id vazio');
    if (!porAba[op.aba]) { porAba[op.aba] = []; ordem.push(op.aba); }
    porAba[op.aba].push(op);
  });
  ordem.forEach(function (aba) { aplicarAba_(aba, porAba[aba]); });
  return ops.length;
}

/** Aplica as operações de uma aba em memória e grava só o que mudou. */
function aplicarAba_(nome, ops) {
  const sh = aba_(nome);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const colId = header.indexOf(ABAS[nome][0]);
  if (colId < 0) throw new Error('Aba ' + nome + ' sem coluna ' + ABAS[nome][0] + ' (rode setup())');
  const dados = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];

  const indice = {}; // id → { nova: bool, i }
  dados.forEach(function (r, i) { if (r[colId] !== '') indice[String(r[colId])] = { nova: false, i: i }; });
  const modificadas = {};
  const apagadas = {};
  const novas = [];

  ops.forEach(function (op) {
    const id = String(op.id);
    const ref = indice[id];
    if (op.op === 'delete') {
      if (ref) {
        if (ref.nova) novas[ref.i] = null;
        else { apagadas[ref.i] = true; delete modificadas[ref.i]; }
        delete indice[id];
      }
      return;
    }
    let linha;
    if (ref) {
      linha = ref.nova ? novas[ref.i] : dados[ref.i];
      if (!ref.nova) modificadas[ref.i] = true;
    } else {
      linha = header.map(function () { return ''; });
      novas.push(linha);
      indice[id] = { nova: true, i: novas.length - 1 };
    }
    linha[colId] = id;
    const d = op.dados || {};
    Object.keys(d).forEach(function (k) {
      const c = header.indexOf(k);
      if (c >= 0 && c !== colId) linha[c] = valorCelula_(d[k]);
    });
  });

  Object.keys(modificadas).forEach(function (i) {
    sh.getRange(Number(i) + 2, 1, 1, lastCol).setValues([dados[i]]);
  });
  const add = novas.filter(Boolean);
  if (add.length) sh.getRange(lastRow + 1, 1, add.length, lastCol).setValues(add);
  Object.keys(apagadas).map(Number).sort(function (a, b) { return b - a; })
    .forEach(function (i) { sh.deleteRow(i + 2); });
}

function valorCelula_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v) && isNaN(Number(v))) return "'" + v; // evita fórmula injetada
  return v;
}

// ---------------------------------------------------------------- leitura

function aba_(nome) {
  const sh = SpreadsheetApp.getActive().getSheetByName(nome);
  if (!sh) throw new Error('Aba ' + nome + ' não existe (rode setup())');
  return sh;
}

function lerAba_(nome) {
  const sh = aba_(nome);
  const v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  const header = v[0].map(String);
  const colId = header.indexOf(ABAS[nome][0]);
  const tz = Session.getScriptTimeZone();
  const out = [];
  for (let r = 1; r < v.length; r++) {
    if (colId >= 0 && v[r][colId] === '') continue;
    const o = {};
    header.forEach(function (h, c) {
      if (!h) return;
      const x = v[r][c];
      o[h] = x instanceof Date ? Utilities.formatDate(x, tz, "yyyy-MM-dd'T'HH:mm:ssXXX") : x;
    });
    out.push(o);
  }
  return out;
}

function bootstrap_() {
  const config = {};
  lerAba_('Config').forEach(function (r) { config[r.chave] = r.valor; });
  const nHist = Number(config.historico_sessoes) || 5;

  const inicioSessao = {};
  lerAba_('Sessoes').forEach(function (s) { inicioSessao[s.sessao_id] = String(s.inicio || ''); });

  const porEx = {};   // exercicio_id → { sessao_id → { sessao_id, data, series } }
  const recordes = {};
  lerAba_('Series').forEach(function (s) {
    const ex = String(s.exercicio_id);
    const sid = String(s.sessao_id);
    const aq = s.aquecimento === true || /^(true|sim|1)$/i.test(String(s.aquecimento));
    const peso = Number(s.peso_kg) || 0;
    const reps = Number(s.reps) || 0;
    const data = inicioSessao[sid] || String(s.registrado_em || '');
    if (!porEx[ex]) porEx[ex] = {};
    if (!porEx[ex][sid]) porEx[ex][sid] = { sessao_id: sid, data: data, series: [] };
    porEx[ex][sid].series.push({
      n_serie: Number(s.n_serie) || 0, aquecimento: aq, peso_kg: peso, reps: reps,
      rir: s.rir === '' ? null : Number(s.rir),
    });
    if (aq || reps <= 0) return;
    const rec = recordes[ex] || (recordes[ex] = {});
    const e1 = peso * (1 + reps / 30);
    if (peso > 0 && (!rec.e1rm || e1 > rec.e1rm.valor)) rec.e1rm = { valor: e1, peso: peso, reps: reps, data: data };
    if (!rec.peso || peso > rec.peso.valor || (peso === rec.peso.valor && reps > rec.peso.reps)) {
      rec.peso = { valor: peso, reps: reps, data: data };
    }
  });

  const historico = {};
  Object.keys(porEx).forEach(function (ex) {
    historico[ex] = Object.keys(porEx[ex]).map(function (k) { return porEx[ex][k]; })
      .sort(function (a, b) { return a.data < b.data ? 1 : a.data > b.data ? -1 : 0; })
      .slice(0, nHist)
      .map(function (s) {
        s.series.sort(function (a, b) { return a.n_serie - b.n_serie; });
        return s;
      });
  });

  return {
    exercicios: lerAba_('Exercicios'),
    planos: lerAba_('Planos'),
    itens: lerAba_('PlanoItens'),
    config: config,
    historico: historico,
    recordes: recordes,
    servidor: agoraIso_(),
  };
}

function agoraIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX");
}

// ---------------------------------------------------------------- manutenção (rodar no editor)

/** Cria/atualiza abas, cabeçalhos, formatos, Config padrão e TOKEN. Pode rodar várias vezes. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(ABAS).forEach(function (nome) {
    const sh = ss.getSheetByName(nome) || ss.insertSheet(nome);
    const cols = ABAS[nome];
    const lastCol = sh.getLastColumn();
    const atuais = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    if (!atuais.filter(String).length) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    } else {
      const faltam = cols.filter(function (c) { return atuais.indexOf(c) < 0; });
      if (faltam.length) sh.getRange(1, lastCol + 1, 1, faltam.length).setValues([faltam]);
    }
    const n = sh.getLastColumn();
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, n).setFontWeight('bold');
    const header = sh.getRange(1, 1, 1, n).getValues()[0].map(String);
    header.forEach(function (h, i) {
      if (COLUNAS_TEXTO.indexOf(h) >= 0 || /_id$/.test(h)) {
        sh.getRange(2, i + 1, Math.max(1, sh.getMaxRows() - 1), 1).setNumberFormat('@');
      }
    });
  });

  const existentes = lerAba_('Config').map(function (r) { return r.chave; });
  const faltam = CONFIG_PADRAO.filter(function (c) { return existentes.indexOf(c[0]) < 0; });
  if (faltam.length) {
    aplicarOps_(faltam.map(function (c) { return { op: 'upsert', aba: 'Config', id: c[0], dados: { valor: c[1] } }; }));
  }

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  Logger.log('TOKEN (cole no app): ' + props.getProperty('TOKEN'));
}

/** Gera um novo TOKEN (o app precisará ser reconfigurado). */
function trocarToken() {
  const t = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('TOKEN', t);
  Logger.log('Novo TOKEN: ' + t);
}

/** Opcional: carrega um catálogo e três planos de exemplo, se o catálogo estiver vazio. */
function seedExemplo() {
  if (lerAba_('Exercicios').length) { Logger.log('Catálogo não está vazio; nada feito.'); return; }
  const ex = [
    ['supino', 'Supino reto com barra', 'Peito', 'barra', 2.5, 40],
    ['supino_incl', 'Supino inclinado com halteres', 'Peito', 'halter', 2, 16],
    ['crucifixo', 'Crucifixo no cabo', 'Peito', 'cabo', 2.5, 10],
    ['desenv', 'Desenvolvimento com halteres', 'Ombros', 'halter', 2, 14],
    ['elev_lat', 'Elevação lateral', 'Ombros', 'halter', 1, 6],
    ['triceps', 'Tríceps na polia', 'Tríceps', 'cabo', 2.5, 20],
    ['barra_fixa', 'Barra fixa', 'Costas', 'peso_corporal', 2.5, 0],
    ['puxada', 'Puxada frontal', 'Costas', 'maquina', 5, 45],
    ['remada', 'Remada curvada', 'Costas', 'barra', 2.5, 40],
    ['rosca', 'Rosca direta', 'Bíceps', 'barra', 2, 20],
    ['agacha', 'Agachamento livre', 'Pernas', 'barra', 2.5, 60],
    ['legpress', 'Leg press 45°', 'Pernas', 'maquina', 10, 120],
    ['mesa_flex', 'Mesa flexora', 'Pernas', 'maquina', 5, 30],
  ];
  const ids = {};
  const ops = ex.map(function (e) {
    ids[e[0]] = Utilities.getUuid();
    return { op: 'upsert', aba: 'Exercicios', id: ids[e[0]], dados: {
      nome: e[1], grupo_muscular: e[2], equipamento: e[3], incremento_kg: e[4], carga_inicial_kg: e[5], ativo: true } };
  });
  const planos = [
    ['Treino A – Peito, Ombros e Tríceps', [['supino', 4, 6, 10, 150], ['supino_incl', 3, 8, 12, 120], ['crucifixo', 3, 10, 15, 90], ['desenv', 3, 8, 12, 120], ['elev_lat', 3, 12, 15, 60], ['triceps', 3, 10, 15, 60]]],
    ['Treino B – Costas e Bíceps', [['barra_fixa', 3, 6, 10, 150], ['puxada', 3, 8, 12, 120], ['remada', 3, 8, 12, 120], ['rosca', 3, 8, 12, 90]]],
    ['Treino C – Pernas', [['agacha', 4, 6, 10, 180], ['legpress', 3, 10, 15, 120], ['mesa_flex', 3, 10, 15, 90]]],
  ];
  planos.forEach(function (p, i) {
    const pid = Utilities.getUuid();
    ops.push({ op: 'upsert', aba: 'Planos', id: pid, dados: { nome: p[0], ordem: i + 1, ativo: true } });
    p[1].forEach(function (it, j) {
      ops.push({ op: 'upsert', aba: 'PlanoItens', id: Utilities.getUuid(), dados: {
        plano_id: pid, ordem: j + 1, exercicio_id: ids[it[0]], series: it[1], reps_min: it[2], reps_max: it[3], descanso_s: it[4], obs: '' } });
    });
  });
  aplicarOps_(ops);
  Logger.log('Exemplo carregado: ' + ops.length + ' linhas.');
}

/** Teste de fumaça da gravação: upsert idempotente, merge, delete e bootstrap. */
function testarApi() {
  const id = '__teste_' + Date.now();
  const linhas = function () { return lerAba_('Config').filter(function (r) { return r.chave === id; }); };
  const ok = function (cond, msg) { if (!cond) throw new Error('FALHOU: ' + msg); Logger.log('ok — ' + msg); };

  aplicarOps_([{ op: 'upsert', aba: 'Config', id: id, dados: { valor: 1 } }]);
  ok(linhas().length === 1 && linhas()[0].valor === 1, 'upsert cria linha');
  aplicarOps_([{ op: 'upsert', aba: 'Config', id: id, dados: { valor: 2 } }, { op: 'upsert', aba: 'Config', id: id, dados: { valor: 3 } }]);
  ok(linhas().length === 1 && linhas()[0].valor === 3, 'upsert repetido não duplica');
  aplicarOps_([{ op: 'delete', aba: 'Config', id: id }, { op: 'delete', aba: 'Config', id: id }]);
  ok(linhas().length === 0, 'delete remove (e repetir é seguro)');
  aplicarOps_([{ op: 'upsert', aba: 'Config', id: id, dados: { valor: '=1+1' } }]);
  ok(linhas()[0].valor === '=1+1', 'fórmula é gravada como texto, não calculada');
  aplicarOps_([{ op: 'delete', aba: 'Config', id: id }]);
  const b = bootstrap_();
  ok(Array.isArray(b.exercicios) && typeof b.historico === 'object', 'bootstrap responde');
  Logger.log('Todos os testes passaram.');
}
