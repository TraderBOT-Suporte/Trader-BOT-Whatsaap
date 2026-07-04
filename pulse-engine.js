// ============================================================
// pulse-engine.js
// Motor dedicado para ativos de pulso: Boom, Crash, Jump, Step
// Integra com server.js via: const pulseEngine = new PulseEngine()
// Chamada: pulseEngine.analyze(symbol, tipoAtivo, mode, candlesMap, mtfManager)
// ============================================================

// ===================== CONSTANTES ===========================

const PULSE_ASSETS = ['boom_index', 'crash_index', 'jump_index', 'step_index'];

const PULSE_LABEL = {
  boom_index:  'BOOM',
  crash_index: 'CRASH',
  jump_index:  'JUMP',
  step_index:  'STEP',
  DEFAULT:     'SPIKE'
};

// Multiplicador mínimo do corpo da vela para ser considerado spike
const SPIKE_MULTIPLIER = {
  boom_index:  3.5,
  crash_index: 3.5,
  jump_index:  3.0,
  step_index:  4.0,
  DEFAULT:     3.0
};

// TF primário (gatilho) por modo
const PRIMARY_TF_BY_MODE = {
  SNIPER:   'M1',
  CAÇADOR:  'M5',
  PESCADOR: 'M15',
  BALEEIRO: 'H1'
};

// Timeout em segundos para limpar memória de spike por modo
const SPIKE_MEMORY_TIMEOUT = {
  SNIPER:   5 * 60,   // 5 min (velas M1)
  CAÇADOR:  15 * 60,  // 15 min (velas M5)
  PESCADOR: 45 * 60,  // 45 min (velas M15)
  BALEEIRO: 3 * 3600, // 3 horas (velas H1)
  DEFAULT:  10 * 60
};

// Máximo de velas de espera após spike antes de desistir
const MAX_WAIT_CANDLES = 3;

// ===================== CLASSE PRINCIPAL =====================

class PulseEngine {
  constructor() {
    // Memória de spike por símbolo: { [symbol]: SpikeMemory }
    this._memory = new Map();
  }

  // ============================================================
  // MÉTODO PRINCIPAL — chamado pelo server.js
  // Retorna null se não for ativo de pulso
  // Retorna PulseResult com { action, signal, reasons, block }
  // ============================================================
  analyze(symbol, tipoAtivo, mode, candlesMap, mtfManager) {
    if (!PULSE_ASSETS.includes(tipoAtivo)) return null;

    const triggerTF  = PRIMARY_TF_BY_MODE[mode] || 'M1';
    const candles    = candlesMap[triggerTF];
    const analysis   = mtfManager?.timeframes?.[triggerTF]?.analysis;
    const label      = PULSE_LABEL[tipoAtivo] || 'SPIKE';

    if (!candles || candles.length < 15) return null;

    // --- 1. Verificar se há spike na vela anterior ---
    const spike = this._detectSpike(candles, tipoAtivo);

    // --- 2. Verificar memória de spike anterior ---
    const memoria = this._getMemory(symbol);

    // --- 3. Se spike acabou de acontecer → guarda memória e bloqueia ---
    if (spike) {
      this._setMemory(symbol, {
        direcao:       spike.direcao,
        label:         label,
        magnitude:     spike.magnitude_num,
        velasEsperadas: 0,
        timestamp:     Date.now(),
        mode:          mode,
        triggerTF:     triggerTF
      });
      console.log(`⚡ [PULSE ENGINE] ${label} ${spike.direcao} detetado (${spike.magnitude}× média) — aguarda 1 vela`);
      return this._buildResult('SPIKE_DETECTED', spike.direcao, label, spike, null, mode);
    }

    // --- 4. Se há memória ativa → modo pós-spike ---
    if (memoria) {
      // Verificar timeout
      const timeout = SPIKE_MEMORY_TIMEOUT[mode] || SPIKE_MEMORY_TIMEOUT.DEFAULT;
      if ((Date.now() - memoria.timestamp) > timeout * 1000) {
        this._clearMemory(symbol);
        console.log(`⏱️ [PULSE ENGINE] Memória de ${label} expirou (timeout ${timeout}s) — motor normal`);
        return null;
      }

      // Incrementar velas esperadas
      memoria.velasEsperadas++;
      this._setMemory(symbol, memoria);

      // Verificar se M1/trigger confirmou a direção
      const confirmacao = this._verificarConfirmacao(analysis, candles, memoria.direcao, tipoAtivo);

      if (confirmacao.confirmado) {
        this._clearMemory(symbol);
        console.log(`✅ [PULSE ENGINE] Pulo de gato ${label} confirmado! Vela ${memoria.velasEsperadas}/${MAX_WAIT_CANDLES}`);
        return this._buildResult('ENTRY_CONFIRMED', memoria.direcao, label, null, confirmacao, mode, memoria);
      }

      // Timeout de velas
      if (memoria.velasEsperadas >= MAX_WAIT_CANDLES) {
        this._clearMemory(symbol);
        console.log(`⏱️ [PULSE ENGINE] ${MAX_WAIT_CANDLES} velas sem confirmação — memória limpa, motor normal`);
        return this._buildResult('TIMEOUT', memoria.direcao, label, null, confirmacao, mode, memoria);
      }

      // Ainda a aguardar confirmação
      console.log(`⏳ [PULSE ENGINE] Aguardando confirmação ${label} — vela ${memoria.velasEsperadas}/${MAX_WAIT_CANDLES}`);
      return this._buildResult('WAITING', memoria.direcao, label, null, confirmacao, mode, memoria);
    }

    // --- 5. Sem spike e sem memória → verificar exaustão pré-pulso ---
    const exaustao = this._detectExhaustionPreSpike(candles, analysis, tipoAtivo);
    if (exaustao && exaustao.detectado) {
      console.log(`⚠️ [PULSE ENGINE] Exaustão ${label} (${exaustao.nivel} ${exaustao.probabilidade}%)`);
      return this._buildResult('EXHAUSTION', exaustao.direcaoEsperada, label, null, null, mode, null, exaustao);
    }

    return null; // Nenhuma situação especial — motor normal continua
  }

  // ============================================================
  // DETETOR DE SPIKE (vela anterior)
  // ============================================================
  _detectSpike(candles, tipoAtivo) {
    const anterior   = candles[candles.length - 2];
    if (!anterior) return null;

    const body       = Math.abs(parseFloat(anterior.close) - parseFloat(anterior.open));
    const mediaBody  = candles.slice(-10, -1).reduce((s, c) =>
      s + Math.abs(parseFloat(c.close) - parseFloat(c.open)), 0) / 9;

    if (mediaBody === 0) return null;

    const mult = SPIKE_MULTIPLIER[tipoAtivo] || SPIKE_MULTIPLIER.DEFAULT;
    if (body <= mediaBody * mult) return null;

    const direcao   = parseFloat(anterior.close) > parseFloat(anterior.open) ? 'CALL' : 'PUT';
    const magnitude = (body / mediaBody).toFixed(1);

    return {
      detectado:     true,
      direcao,
      magnitude:     magnitude + 'x',
      magnitude_num: parseFloat(magnitude),
      bodySize:      body,
      mediaBody
    };
  }

  // ============================================================
  // VERIFICAÇÃO DE CONFIRMAÇÃO PÓS-SPIKE (pulo de gato)
  // ============================================================
  _verificarConfirmacao(analysis, candles, direcaoSpike, tipoAtivo) {
    if (!analysis || !candles || candles.length < 3) {
      return { confirmado: false, motivo: 'Dados insuficientes' };
    }

    const rsi  = analysis.rsi ?? 50;
    const adx  = analysis.adx ?? 0;
    const hist = analysis.macd_phase?.histogram ?? null;
    const macd = analysis.macd_phase?.macd ??
                 analysis.macd_phase?.macd_line ??
                 analysis.macd_phase?.raw?.macd ??
                 analysis.macd ?? null;

    // Verificar direção da vela atual
    const ultimaVela = candles[candles.length - 1];
    const velaCALL   = parseFloat(ultimaVela.close) > parseFloat(ultimaVela.open);
    const velaPUT    = parseFloat(ultimaVela.close) < parseFloat(ultimaVela.open);

    const sinaisConfirmacao = [];
    let pontos = 0;

    if (direcaoSpike === 'CALL') {
      // Confirma CALL após spike de alta
      if (velaCALL) {
        sinaisConfirmacao.push('Vela atual a subir ✅');
        pontos += 30;
      }
      if (rsi < 50) {
        sinaisConfirmacao.push(`RSI ${rsi.toFixed(0)} em zona baixa — espaço para subir`);
        pontos += 25;
      }
      if (hist !== null && hist > 0) {
        sinaisConfirmacao.push('Histograma MACD positivo');
        pontos += 25;
      } else if (hist !== null && hist < 0 && macd !== null && macd > 0) {
        // MACD positivo mas hist negativo — aceitável (WEAK_BULL)
        sinaisConfirmacao.push('MACD positivo (perdendo força mas ainda CALL)');
        pontos += 10;
      }
      if (adx >= 10) {
        sinaisConfirmacao.push(`ADX ${adx.toFixed(0)} com alguma força`);
        pontos += 20;
      }
      // Critério específico por ativo
      if (tipoAtivo === 'boom_index' && rsi < 45) pontos += 10; // Boom precisa RSI baixo para confirmar
      if (tipoAtivo === 'jump_index') pontos += 10; // Jump: menos exigente

    } else if (direcaoSpike === 'PUT') {
      // Confirma PUT após spike de baixa
      if (velaPUT) {
        sinaisConfirmacao.push('Vela atual a cair ✅');
        pontos += 30;
      }
      if (rsi > 50) {
        sinaisConfirmacao.push(`RSI ${rsi.toFixed(0)} em zona alta — espaço para cair`);
        pontos += 25;
      }
      if (hist !== null && hist < 0) {
        sinaisConfirmacao.push('Histograma MACD negativo');
        pontos += 25;
      } else if (hist !== null && hist > 0 && macd !== null && macd < 0) {
        sinaisConfirmacao.push('MACD negativo (perdendo força mas ainda PUT)');
        pontos += 10;
      }
      if (adx >= 10) {
        sinaisConfirmacao.push(`ADX ${adx.toFixed(0)} com alguma força`);
        pontos += 20;
      }
      if (tipoAtivo === 'crash_index' && rsi > 55) pontos += 10;
      if (tipoAtivo === 'jump_index') pontos += 10;
    }

    // Threshold de confirmação: 50 pontos mínimo
    const confirmado = pontos >= 50;

    return {
      confirmado,
      pontos,
      sinais: sinaisConfirmacao,
      rsi,
      adx,
      hist
    };
  }

  // ============================================================
  // DETETOR DE EXAUSTÃO PRÉ-SPIKE
  // ============================================================
  _detectExhaustionPreSpike(candles, analysis, tipoAtivo) {
    if (!analysis) return null;

    const rsi  = analysis.rsi ?? 50;
    const adx  = analysis.adx ?? 0;
    const hist = analysis.macd_phase?.histogram ?? null;
    const macd = analysis.macd_phase?.macd ??
                 analysis.macd_phase?.macd_line ??
                 analysis.macd_phase?.raw?.macd ??
                 analysis.macd ?? null;

    // Aceleração do preço (últimas 3 vs 3 anteriores)
    const closes     = candles.slice(-6).map(c => parseFloat(c.close));
    const bodies     = candles.slice(-10).map(c => Math.abs(parseFloat(c.close) - parseFloat(c.open)));
    const atrMedio   = bodies.reduce((a, b) => a + b, 0) / bodies.length;
    const moveRecente   = Math.abs(closes[5] - closes[2]);
    const moveAnterior  = Math.abs(closes[2] - closes[0]);
    const aceleracao    = moveAnterior > 0 ? moveRecente / moveAnterior : 1;

    const sinais = [];
    let prob = 0;
    let direcaoEsperada = null;

    if (tipoAtivo === 'boom_index') {
      if (rsi > 75)      { sinais.push(`RSI ${rsi.toFixed(0)} em sobrecompra`); prob += 35; }
      else if (rsi > 65) { sinais.push(`RSI ${rsi.toFixed(0)} em zona alta`);   prob += 15; }
      if (macd !== null && macd > 0 && hist !== null && hist < 0) {
        sinais.push('MACD positivo + histograma negativo (perdendo força)'); prob += 30;
      }
      if (aceleracao < 0.6 && moveAnterior > atrMedio) {
        sinais.push('Preço a abrandar após movimento forte'); prob += 20;
      }
      direcaoEsperada = 'CALL';

    } else if (tipoAtivo === 'crash_index') {
      if (rsi < 25)      { sinais.push(`RSI ${rsi.toFixed(0)} em sobrevenda`); prob += 35; }
      else if (rsi < 35) { sinais.push(`RSI ${rsi.toFixed(0)} em zona baixa`); prob += 15; }
      if (macd !== null && macd < 0 && hist !== null && hist > 0) {
        sinais.push('MACD negativo + histograma positivo (perdendo força de baixa)'); prob += 30;
      }
      if (aceleracao < 0.6 && moveAnterior > atrMedio) {
        sinais.push('Preço a abrandar após queda forte'); prob += 20;
      }
      direcaoEsperada = 'PUT';

    } else if (tipoAtivo === 'jump_index') {
      if (adx < 15) { sinais.push(`ADX ${adx.toFixed(0)} muito baixo — comprimido`); prob += 25; }
      if (aceleracao < 0.5) { sinais.push('Movimento muito lento — energia a acumular'); prob += 25; }
      if (rsi > 65)      { sinais.push(`RSI ${rsi.toFixed(0)} alto — Jump CALL provável`);  prob += 20; direcaoEsperada = 'CALL'; }
      else if (rsi < 35) { sinais.push(`RSI ${rsi.toFixed(0)} baixo — Jump PUT provável`);  prob += 20; direcaoEsperada = 'PUT'; }
      if (hist !== null && Math.abs(hist) < 0.001) { sinais.push('Histograma perto de zero — acumulação'); prob += 15; }

    } else if (tipoAtivo === 'step_index') {
      if (adx < 12) { sinais.push(`ADX ${adx.toFixed(0)} muito baixo — degrau a terminar`); prob += 20; }
      if (rsi > 70)      { sinais.push(`RSI ${rsi.toFixed(0)} alto`);  prob += 20; direcaoEsperada = 'CALL'; }
      else if (rsi < 30) { sinais.push(`RSI ${rsi.toFixed(0)} baixo`); prob += 20; direcaoEsperada = 'PUT'; }
    }

    if (prob === 0 || sinais.length === 0) return null;

    const nivel = prob >= 60 ? 'ALTO' : prob >= 35 ? 'MÉDIO' : 'BAIXO';

    return {
      detectado: true,
      probabilidade: prob,
      nivel,
      direcaoEsperada,
      sinais
    };
  }

  // ============================================================
  // CONSTRUTOR DE RESULTADO
  // ============================================================
  _buildResult(action, direcao, label, spike, confirmacao, mode, memoria, exaustao) {
    const dirTexto = direcao === 'CALL' ? 'ALTA 🚀' : direcao === 'PUT' ? 'BAIXA 🔻' : 'indefinida';
    const triggerTF = PRIMARY_TF_BY_MODE[mode] || 'M1';

    switch (action) {

      case 'SPIKE_DETECTED':
        return {
          action,
          block: true,
          signal: 'HOLD',
          direcaoSpike: direcao,
          reasons: [
            `⚡ ${label} de ${dirTexto} detetado (${spike.magnitude}× a média)`,
            `⏳ Aguarda 1 vela completa para o preço estabilizar`,
            `💡 Após a vela de espera, o motor verifica a confirmação automaticamente`,
            `🎯 Entrada esperada: ${direcao === 'CALL' ? '🚀 CALL' : '🔻 PUT'} a favor do ${label}`
          ]
        };

      case 'WAITING':
        return {
          action,
          block: true,
          signal: 'HOLD',
          direcaoSpike: direcao,
          velasEsperadas: memoria?.velasEsperadas,
          reasons: [
            `⏳ Pós-${label}: aguardando confirmação (vela ${memoria?.velasEsperadas}/${MAX_WAIT_CANDLES})`,
            `🎯 Direção do ${label}: ${dirTexto}`,
            confirmacao?.sinais?.length
              ? `📊 ${triggerTF}: ${confirmacao.sinais.join(' | ')}`
              : `📊 ${triggerTF} ainda não confirmou a entrada`,
            `💡 Entra quando ${triggerTF} confirmar ${direcao === 'CALL' ? 'CALL' : 'PUT'}`
          ]
        };

      case 'ENTRY_CONFIRMED':
        return {
          action,
          block: false,         // NÃO bloqueia — força entrada
          signal: direcao,      // CALL ou PUT
          direcaoSpike: direcao,
          forceSignal: true,    // server.js usa isto para forçar o sinal
          velasEsperadas: memoria?.velasEsperadas,
          reasons: [
            `🎯 Pulo de gato ${label} confirmado! (vela ${memoria?.velasEsperadas}/${MAX_WAIT_CANDLES})`,
            `${direcao === 'CALL' ? '🚀' : '🔻'} ENTRA ${direcao} a favor do ${label}`,
            confirmacao?.sinais?.length
              ? `✅ Confirmação: ${confirmacao.sinais.join(' | ')}`
              : `✅ ${triggerTF} confirmou a direção`,
            `💡 STOP abaixo do mínimo do spike | Gestão de risco obrigatória`
          ]
        };

      case 'TIMEOUT':
        return {
          action,
          block: false,   // timeout — motor normal retoma
          signal: null,
          reasons: [
            `⏱️ ${label}: ${MAX_WAIT_CANDLES} velas sem confirmação — motor normal retoma`,
            `💡 O ${label} não gerou momentum suficiente — aguarda nova oportunidade`
          ]
        };

      case 'EXHAUSTION':
        const nivel = exaustao?.nivel || 'MÉDIO';
        const bloq  = nivel === 'ALTO';
        return {
          action,
          block: bloq,
          signal: bloq ? 'HOLD' : null,
          direcaoEsperada: direcao,
          nivel,
          reasons: bloq ? [
            `⚠️ Exaustão ${label} detetada (nível ${nivel} — ${exaustao?.probabilidade}%)`,
            ...( exaustao?.sinais || []).map(s => `   • ${s}`),
            `⏳ Mercado a acumular energia antes do próximo ${label}`,
            direcao
              ? `💡 Quando o spike acontecer: entra ${direcao === 'CALL' ? '🚀 CALL' : '🔻 PUT'} após 1 vela`
              : `💡 Quando o spike acontecer: observa a direção e aguarda 1 vela`
          ] : [
            `⚠️ Sinais de exaustão ${label} (nível MÉDIO ${exaustao?.probabilidade}%)`,
            ...( exaustao?.sinais || []).map(s => `   • ${s}`)
          ]
        };

      default:
        return null;
    }
  }

  // ============================================================
  // GESTÃO DE MEMÓRIA
  // ============================================================
  _getMemory(symbol) {
    return this._memory.get(symbol) || null;
  }

  _setMemory(symbol, data) {
    this._memory.set(symbol, data);
  }

  _clearMemory(symbol) {
    this._memory.delete(symbol);
  }

  // Limpa memórias expiradas (chama periodicamente se quiseres)
  clearExpiredMemories() {
    const now = Date.now();
    for (const [symbol, mem] of this._memory.entries()) {
      const timeout = SPIKE_MEMORY_TIMEOUT[mem.mode] || SPIKE_MEMORY_TIMEOUT.DEFAULT;
      if ((now - mem.timestamp) > timeout * 1000) {
        this._memory.delete(symbol);
        console.log(`🧹 [PULSE ENGINE] Memória expirada limpa: ${symbol}`);
      }
    }
  }
}

module.exports = PulseEngine;
