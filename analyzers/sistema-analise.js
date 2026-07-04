// analyzers/sistema-analise.js
const ConfigAtivo = require('../config').ConfigAtivo;
const SistemaPesosAutomaticos = require('./sistema-pesos');
const SistemaConfiabilidade = require('./sistema-confiabilidade');
const SistemaDuplaTendencia = require('./sistema-dupla-tendencia');
const QuasimodoPattern = require('./quasimodo');
const ElliottWaveMaster = require('./elliott-wave');
const AdvancedMarketAnalyzer = require('./advanced-market');
const AnaliseVelocidadeIndicadores = require('./velocidade');
const ZonaDeOuroPremium = require('./zona-ouro');
const MultiTimeframeManager = require('../multi-timeframe-manager');
const { calcularRSI, calcularMACD, calcularADXCompleto, calcularVolatilidade } = require('../indicators');
const { INDICATOR_CONFIG, MARKET_STATE, CANDLE_CLOSE_TOLERANCE } = require('../config');
const { institutionalSniper } = require('../institutional-sniper');

// ========== SISTEMA DE FASES DO MACD ==========
class MacdPhaseAnalyzer {
    constructor() {
        this.phases = {
            STRONG_BULL: { 
                name: 'ALTA FORTE', 
                confidence: 0.85, 
                action: 'CALL', 
                description: 'MACD + Sinal + Histograma positivos',
                icon: '🚀',
                color: '#00ff88',
                recomendacao: '🔥 Momento forte de alta - Operar CALL com convicção'
            },
            WEAK_BULL: { 
                name: 'ALTA PERDENDO FORÇA', 
                confidence: 0.55,        // [RETIFICADO] 0.45 → 0.55 (não é tão fraco)
                action: 'CALL',         // [RETIFICADO] 'HOLD' → 'CALL' (mantém direção, alerta fraqueza)
                description: 'MACD e Sinal positivos, Histograma negativo',
                icon: '⚠️',
                color: '#ffc107',
                recomendacao: '⚠️ Alta perdendo força - Reduzir stake ou aguardar confirmação'
            },
            CROSS_BEAR: { 
                name: 'CRUZAMENTO BAIXA', 
                confidence: 0.65, 
                action: 'PUT', 
                description: 'MACD negativo, Sinal positivo, Histograma negativo',
                icon: '📉',
                color: '#ff7f7f',
                recomendacao: '🎯 Cruzamento de baixa confirmado - Iniciar operações de PUT'
            },
            STRONG_BEAR: { 
                name: 'BAIXA FORTE', 
                confidence: 0.85, 
                action: 'PUT', 
                description: 'MACD + Sinal + Histograma negativos',
                icon: '🔥',
                color: '#ff4b2b',
                recomendacao: '🔥 Momento forte de baixa - Operar PUT com convicção'
            },
            CROSS_BULL: { 
                name: 'CRUZAMENTO ALTA', 
                confidence: 0.65, 
                action: 'CALL', 
                description: 'MACD positivo, Sinal negativo, Histograma positivo',
                icon: '📈',
                color: '#90EE90',
                recomendacao: '🎯 Cruzamento de alta confirmado - Iniciar operações de CALL'
            },
            WEAK_BEAR: { 
                name: 'BAIXA PERDENDO FORÇA', 
                confidence: 0.55,        // [RETIFICADO] 0.45 → 0.55
                action: 'PUT',           // [RETIFICADO] 'HOLD' → 'PUT'
                description: 'MACD e Sinal negativos, Histograma positivo',
                icon: '⚠️',
                color: '#ffc107',
                recomendacao: '⚠️ Baixa perdendo força - Reduzir stake ou aguardar confirmação'
            },
            NEUTRAL: { 
                name: 'NEUTRO', 
                confidence: 0.35, 
                action: 'HOLD', 
                description: 'MACD próximo de zero',
                icon: '⚪',
                color: '#cccccc',
                recomendacao: '⏳ Mercado indefinido - Aguardar melhor momento'
            }
        };
    }

    analyzePhase(macdData, tipoAtivo = 'indice_normal') {
        if (!macdData || !macdData.valido) {
            return { 
                phase: 'NEUTRAL', 
                ...this.phases.NEUTRAL,
                status: {
                    macd: '⚪ NEUTRO',
                    sinal: '⚪ NEUTRO',
                    histograma: '⚪ NEUTRO'
                },
                multiplier: 1.0
            };
        }

        // ⭐ Tolerance dinâmico por tipo de ativo
       const toleranceMap = {
  'forex':            0.000015,
  'commodity':        0.02,
  'criptomoeda':      0.005,
  'boom_index':       0.001,
  'crash_index':      0.001,
  'jump_index':       0.0008,
  'step_index':       0.0005,
  'volatility_index': 0.0005,
  'indice_normal':    0.002,
};
        const tolerance = toleranceMap[tipoAtivo] ?? 0.002;
        const macdPos = macdData.macd > tolerance;
        const macdNeg = macdData.macd < -tolerance;
        const sinalPos = macdData.sinal > tolerance;
        const sinalNeg = macdData.sinal < -tolerance;
        const histPos = macdData.histograma > tolerance;
        const histNeg = macdData.histograma < -tolerance;

        let phase = 'NEUTRAL';
        let status = {};

        if (macdPos && sinalPos && histPos) {
            phase = 'STRONG_BULL';
            status = { macd: '✅ POSITIVO', sinal: '✅ POSITIVO', histograma: '✅ POSITIVO' };
        }
        else if (macdPos && sinalPos && histNeg) {
            phase = 'WEAK_BULL';  // [RETIFICADO] Mantém CALL, não força HOLD
            status = { macd: '✅ POSITIVO', sinal: '✅ POSITIVO', histograma: '❌ NEGATIVO' };
        }
        else if (macdNeg && sinalPos && histNeg) {
            phase = 'CROSS_BEAR';
            status = { macd: '❌ NEGATIVO', sinal: '✅ POSITIVO', histograma: '❌ NEGATIVO' };
        }
        else if (macdNeg && sinalNeg && histNeg) {
            phase = 'STRONG_BEAR';
            status = { macd: '❌ NEGATIVO', sinal: '❌ NEGATIVO', histograma: '❌ NEGATIVO' };
        }
        else if (macdPos && sinalNeg && histPos) {
            phase = 'CROSS_BULL';
            status = { macd: '✅ POSITIVO', sinal: '❌ NEGATIVO', histograma: '✅ POSITIVO' };
        }
        else if (macdNeg && sinalNeg && histPos) {
            phase = 'WEAK_BEAR';  // [RETIFICADO] Mantém PUT, não força HOLD
            status = { macd: '❌ NEGATIVO', sinal: '❌ NEGATIVO', histograma: '✅ POSITIVO' };
        }
        else {
            phase = 'NEUTRAL';
            status = { macd: '⚪ NEUTRO', sinal: '⚪ NEUTRO', histograma: '⚪ NEUTRO' };
        }

        const multiplier = this.getPhaseMultiplier(phase);
        const phaseData = this.phases[phase];

        return {
            phase,
            ...phaseData,
            status,
            multiplier,
            raw: {
                macd: macdData.macd.toFixed(4),
                sinal: macdData.sinal.toFixed(4),
                histograma: macdData.histograma.toFixed(4)
            }
        };
    }

    getPhaseMultiplier(phase) {
        const multipliers = {
            'STRONG_BULL': 1.3,
            'STRONG_BEAR': 1.3,
            'CROSS_BULL': 1.2,
            'CROSS_BEAR': 1.2,
            'WEAK_BULL': 0.85,   // [RETIFICADO] 0.7 → 0.85 (menos penalização)
            'WEAK_BEAR': 0.85,   // [RETIFICADO] 0.7 → 0.85
            'NEUTRAL': 0.5
        };
        return multipliers[phase] || 1.0;
    }

    shouldTrade(phase) {
        // [RETIFICADO] WEAK_BULL/WEAK_BEAR agora permitem trade com alerta
        const tradeAllowed = ['STRONG_BULL', 'STRONG_BEAR', 'CROSS_BULL', 'CROSS_BEAR', 'WEAK_BULL', 'WEAK_BEAR'];
        return tradeAllowed.includes(phase);
    }

    getDescription(phase) {
        return this.phases[phase]?.description || 'Fase não identificada';
    }
}

class AutomatedElliottTradingSystem {
    constructor() {
        this.analyzer = new ElliottWaveMaster();
        this.dataHistory = [];
        this.positions = [];
        this.accountBalance = 10;
    }
    
    async onNewCandle(candle) {
        this.dataHistory.push(candle);
        if (this.dataHistory.length > 200) this.dataHistory = this.dataHistory.slice(-200);
        const analysis = this.analyzer.analyzeFull(this.dataHistory);
        const signals = analysis.tradingSignals;
        return { analysis, signals, positions: this.positions, accountBalance: this.accountBalance };
    }
}

class SistemaAnaliseInteligente {
    constructor(simbolo) {
        this.simbolo = simbolo;
        this.config = ConfigAtivo.getConfig(simbolo);
        this.tipoAtivo = ConfigAtivo._detectarTipoAtivo(simbolo);
        
        this.sistemaPesos = new SistemaPesosAutomaticos();
        this.sistemaConfiabilidade = new SistemaConfiabilidade();
        this.sistemaDuplaTendencia = new SistemaDuplaTendencia();
        this.quasimodoAnalyzer = new QuasimodoPattern([]);
        this.elliottWaveSystem = new AutomatedElliottTradingSystem();
        this.advancedAnalyzer = new AdvancedMarketAnalyzer();
        this.velocidadeAnalyzer = new AnaliseVelocidadeIndicadores();
        this.zonaDeOuroPremium = new ZonaDeOuroPremium();
        this.macdPhaseAnalyzer = new MacdPhaseAnalyzer();
        
        // [OTIMIZAÇÃO] Elliott analyzer reutilizado (não recriado a cada chamada)
        this.elliottAnalyzer = new ElliottWaveMaster();
        
        this.multiTimeframeManager = new MultiTimeframeManager();
        this.timeframesData = {};
    }

    getTimeframeSeconds(tf) {
        const map = {
            M1: 60, M5: 300, M15: 900, M30: 1800,
            H1: 3600, H4: 14400, H24: 86400,
            W1: 604800, MN1: 2592000
        };
        return map[tf] || 300;
    }

    isCandleClosed(candle, tfSeconds) {
        if (!candle || !candle.epoch) return true;
        const now = Math.floor(Date.now() / 1000);
        const candleEnd = candle.epoch + tfSeconds;
        return now >= candleEnd - CANDLE_CLOSE_TOLERANCE;
    }

    // ========== Helper: Calcular média genérica ==========
    calcularMedia(precos, periodo, isExponencial = false) {
        if (!precos || precos.length === 0) return 0;
        if (precos.length < periodo) return precos.reduce((a, b) => a + b, 0) / precos.length;
        
        if (!isExponencial) {
            const slice = precos.slice(-periodo);
            return slice.reduce((a, b) => a + b, 0) / periodo;
        }
        
        const k = 2 / (periodo + 1);
        let ema = precos[0];
        for (let i = 1; i < precos.length; i++) {
            ema = precos[i] * k + ema * (1 - k);
        }
        return ema;
    }

    // ========== [RETIFICADO] DETECTAR DIVERGÊNCIAS MACD REAIS ==========
    detectarDivergenciaMACD(macdData, candles, adxAtual) {
        if (!macdData || !macdData.valido) return { divergencia: false, motivo: '' };
        
        const { macd, sinal, histograma } = macdData;
        
        if (adxAtual && adxAtual > 25) {
            return { 
                divergencia: false, 
                motivo: `ADX forte (${adxAtual.toFixed(1)}) - tendência dominante, ignorando divergências` 
            };
        }
        
        const isWeakPhase = (macd > 0 && sinal > 0 && histograma < 0) || 
                           (macd < 0 && sinal < 0 && histograma > 0);
        
        if (isWeakPhase) {
            return { 
                divergencia: false, 
                motivo: 'Fase WEAK - perda de força normal, não divergência de reversão',
                tipo: 'PERDA_FORCA',
                acao: 'MANTER_SINAL'
            };
        }
        
        if (macd > 0 && sinal < 0 && histograma > 0) {
            return {
                divergencia: true,
                tipo: 'CRUZAMENTO_ALTA_RECENTE',
                motivo: 'MACD cruzou para cima - aguardar confirmação do sinal',
                acao: 'HOLD',
                probabilidadeReducao: 0.8
            };
        }
        
        if (macd < 0 && sinal > 0 && histograma < 0) {
            return {
                divergencia: true,
                tipo: 'CRUZAMENTO_BAIXA_RECENTE',
                motivo: 'MACD cruzou para baixo - aguardar confirmação do sinal',
                acao: 'HOLD',
                probabilidadeReducao: 0.8
            };
        }
        
        if (Math.abs(macd) < 0.001 && Math.abs(histograma) < 0.001) {
            if (candles && candles.length >= 3) {
                const ultimos = candles.slice(-3);
                const tendenciaClara = ultimos.every(c => parseFloat(c.close) > parseFloat(c.open)) ||
                                      ultimos.every(c => parseFloat(c.close) < parseFloat(c.open));
                if (!tendenciaClara) {
                    return {
                        divergencia: true,
                        tipo: 'MACD_NEUTRO_INDEFINIDO',
                        motivo: 'MACD neutro e mercado indefinido',
                        acao: 'HOLD',
                        probabilidadeReducao: 0.7
                    };
                }
            }
            return { divergencia: false, motivo: 'MACD neutro mas mercado com direção' };
        }
        
        if (candles && candles.length >= 10) {
            const precos = candles.map(c => parseFloat(c.close));
            const macdLine = macd;
            
            const precoMax1 = Math.max(...precos.slice(-10, -5));
            const precoMax2 = Math.max(...precos.slice(-5));
            const macdTrend = macdLine > 0 ? 'alta' : 'baixa';
            
            if (precoMax2 > precoMax1 * 1.01 && macdTrend === 'baixa') {
                return {
                    divergencia: true,
                    tipo: 'DIVERGENCIA_BEARISH_REAL',
                    motivo: 'Preço fez topo mais alto mas MACD em baixa - reversão provável',
                    acao: 'HOLD',
                    probabilidadeReducao: 0.6
                };
            }
            
            const precoMin1 = Math.min(...precos.slice(-10, -5));
            const precoMin2 = Math.min(...precos.slice(-5));
            
            if (precoMin2 < precoMin1 * 0.99 && macdTrend === 'alta') {
                return {
                    divergencia: true,
                    tipo: 'DIVERGENCIA_BULLISH_REAL',
                    motivo: 'Preço fez fundo mais baixo mas MACD em alta - reversão provável',
                    acao: 'HOLD',
                    probabilidadeReducao: 0.6
                };
            }
        }
        
        return { divergencia: false, motivo: 'Sem divergência significativa' };
    }

    calcularMediaSimples(precos, periodo) {
        return this.calcularMedia(precos, periodo, false);
    }

    calcularMediaExponencial(precos, periodo) {
        return this.calcularMedia(precos, periodo, true);
    }

    calcularRSI(precos, periodo = INDICATOR_CONFIG.RSI_PERIOD) {
        return calcularRSI(precos, periodo);
    }

    calcularMACD(precos, periodoRapido = INDICATOR_CONFIG.MACD_FAST, periodoLento = INDICATOR_CONFIG.MACD_SLOW, periodoSinal = INDICATOR_CONFIG.MACD_SIGNAL) {
        return calcularMACD(precos, periodoRapido, periodoLento, periodoSinal);
    }

    verificarTendenciaMACD(macdData) {
        if (!macdData || !macdData.valido) return "NEUTRO";
        const histograma = macdData.histograma, linhaMACD = macdData.macd, linhaSinal = macdData.sinal;
        if (histograma > 0.001 && linhaMACD > linhaSinal) return "FORTE_ALTA";
        if (histograma < -0.001 && linhaMACD < linhaSinal) return "FORTE_BAIXA";
        if (histograma > 0) return "MODERADA_ALTA";
        if (histograma < 0) return "MODERADA_BAIXA";
        return "NEUTRO";
    }

    calcularADXCompleto(candles, periodo = INDICATOR_CONFIG.ADX_PERIOD) {
        return calcularADXCompleto(candles, periodo);
    }

    calcularVolatilidade(candles, precoAtual) {
        return calcularVolatilidade(candles, precoAtual);
    }

    gerarSinalRapidoMACD(candles) {
        if (!candles || candles.length < 30) return null;
        const fechamentos = candles.map(c => parseFloat(c.close));
        const macdResult = this.calcularMACD(fechamentos);
        if (!macdResult.valido) return null;

        if (macdResult.histograma > 0.002) return { sinal: "CALL", forca: "FORTE", motivo: `MACD positivo forte (${macdResult.histograma.toFixed(4)})`, probabilidade: 0.68 };
        else if (macdResult.histograma > 0.001) return { sinal: "CALL", forca: "MODERADA", motivo: `MACD positivo moderado (${macdResult.histograma.toFixed(4)})`, probabilidade: 0.62 };
        else if (macdResult.histograma < -0.002) return { sinal: "PUT", forca: "FORTE", motivo: `MACD negativo forte (${macdResult.histograma.toFixed(4)})`, probabilidade: 0.68 };
        else if (macdResult.histograma < -0.001) return { sinal: "PUT", forca: "MODERADA", motivo: `MACD negativo moderado (${macdResult.histograma.toFixed(4)})`, probabilidade: 0.62 };
        return null;
    }

    updateTimeframeData(timeframeKey, analysis) {
        if (analysis && analysis.sinal) {
            this.timeframesData[timeframeKey] = {
                trend: analysis.sinal,
                adx: analysis.adx,
                rsi: analysis.rsi,
                preco: analysis.preco_atual,
                probabilidade: analysis.probabilidade
            };
        }
    }

    analyzeInstitutionalSniper(m15Data, agreementScore) {
        if (!m15Data || !m15Data.candles || m15Data.candles.length < 5) return null;

        const sniperResult = institutionalSniper({
            trendH1: this.timeframesData['H1']?.trend || 'NEUTRAL',
            candlesM15: m15Data.candles,
            rsiM15: m15Data.rsi,
            adxM15: m15Data.adx,
            agreementScore: agreementScore,
            serverTime: Date.now(),
            timeframes: this.timeframesData
        });

        return sniperResult;
    }

    coletarAnalisesVelocidade(analisesPorTF) {
        const velocidades = {};
        
        for (const [tf, analise] of Object.entries(analisesPorTF)) {
            if (analise && analise.velocidade_analysis) {
                velocidades[tf] = analise.velocidade_analysis;
            }
        }
        
        return velocidades;
    }

    // [OTIMIZAÇÃO] Logger condicional para produção
    logAnalysis(message) {
        if (process.env.NODE_ENV === 'development') {
            console.log(message);
        }
    }

    async analisar(candles, timeframeKey = 'M5') {
        if (!candles || candles.length < 20) {
            return { erro: "Dados insuficientes (mínimo 20 candles)" };
        }

        const fechamentos = candles.map(c => parseFloat(c.close));
        const precoAtual = fechamentos[fechamentos.length - 1];
        const precoAnterior = fechamentos[fechamentos.length - 2];
        
        const pesosAutomaticos = this.sistemaPesos.analisarMercado(candles, precoAtual);
        const estadoMercado = this.sistemaPesos.getEstadoMercado();
        const tendenciaForca = this.sistemaPesos.getTendenciaForca();
        const volatilidade = this.sistemaPesos.getVolatilidade();
        const rsi = this.calcularRSI(fechamentos);
        const adxData = this.calcularADXCompleto(candles);
        const adxAtual = adxData.adx;
        
        const macdResult = this.calcularMACD(fechamentos);
        if (!macdResult || typeof macdResult !== 'object') {
            return { erro: 'MACD calculation falhou' };
        }
        
        const volatilidadeAtual = this.calcularVolatilidade(candles, precoAtual);
        const tendenciaMACD = this.verificarTendenciaMACD(macdResult);

        // Calcular prev_histogram: histograma da vela anterior (necessário para hasHistogramShift)
        const fechamentosSemUltimo = fechamentos.slice(0, -1);
        const macdResultPrev = fechamentosSemUltimo.length >= 26
            ? this.calcularMACD(fechamentosSemUltimo)
            : null;
        const prevHistogram = macdResultPrev?.valido ? macdResultPrev.histograma : null;
        
        const macdPhase = this.macdPhaseAnalyzer.analyzePhase(macdResult, this.tipoAtivo);
        
        this.logAnalysis(`\n📊 ANÁLISE DE FASE MACD:`);
        this.logAnalysis(`   Fase: ${macdPhase.phase} - ${macdPhase.name}`);
        this.logAnalysis(`   MACD: ${macdPhase.status.macd} | Sinal: ${macdPhase.status.sinal} | Hist: ${macdPhase.status.histograma}`);
        this.logAnalysis(`   Recomendação: ${macdPhase.recomendacao}`);
        this.logAnalysis(`   Multiplicador: ${macdPhase.multiplier.toFixed(2)}x`);

        const divergenciaMACD = this.detectarDivergenciaMACD(macdResult, candles, adxAtual);

        const analiseDupla = this.sistemaDuplaTendencia.analisarTendenciasDuplas(
            candles, macdResult, rsi, adxData
        );
        const sinalDupla = this.sistemaDuplaTendencia.calcularSinalFinal(analiseDupla);

        // [OTIMIZAÇÃO] Evitar mutação - criar novo objeto
        let sinalFinal = { ...sinalDupla };
        
        if (divergenciaMACD.divergencia && divergenciaMACD.acao === 'HOLD') {
            this.logAnalysis(`   ⛔ Divergência MACD REAL detectada (${divergenciaMACD.tipo}): forçando HOLD para ${timeframeKey}`);
            sinalFinal = {
                ...sinalDupla,
                sinal: 'HOLD',
                probabilidade: sinalDupla.probabilidade * (divergenciaMACD.probabilidadeReducao || 0.5)
            };
        } else if (divergenciaMACD.tipo === 'PERDA_FORCA') {
            this.logAnalysis(`   ⚠️ Perda de força detectada (${timeframeKey}): mantendo sinal ${sinalDupla.sinal} com alerta`);
            sinalFinal = {
                ...sinalDupla,
                probabilidade: sinalDupla.probabilidade * 0.85
            };
        }
        
        const sinalCombinado = this.quasimodoAnalyzer.generateCombinedSignal(
            candles, macdResult.histograma, rsi
        );
        
        const confirmacaoQM = this.quasimodoAnalyzer.confirmSignalWithQM(
            sinalFinal.sinal, precoAtual, candles.slice(-50)
        );

        // [OTIMIZAÇÃO] Reutilizar Elliott analyzer
        const elliottAnalysis = this.elliottAnalyzer.analyzeFull(candles.slice(-100));
        
        const advancedIndicators = {
            macdLine: macdResult.macd,
            macdSignal: macdResult.sinal,
            macdHist: macdResult.histograma,
            adx: adxData.adx,
            rsi: rsi,
            h4ADX: adxData.adx,
            h4RSI: rsi,
            totalScore: sinalFinal.probabilidade * 100
        };
        
        const advancedAnalysis = this.advancedAnalyzer.analyze(candles, advancedIndicators);
        
        const velocidadeAnalysis = this.velocidadeAnalyzer.analisarVelocidade(
            rsi, adxData.adx, precoAtual, timeframeKey, candles.slice(-10)
        );

        const analiseAtual = {
            sinal: sinalFinal.sinal,
            probabilidade: sinalFinal.probabilidade,
            adx: adxData.adx,
            rsi,
            preco_atual: precoAtual,
            tendencia: tendenciaMACD,
            velocidade_analysis: velocidadeAnalysis,
            macd: macdResult,
            macd_phase: macdPhase,
            elliott: elliottAnalysis.structure,
            quasimodo: confirmacaoQM,
            dupla_tendencia: {
                sinal: sinalFinal.sinal,
                probabilidade: sinalFinal.probabilidade,
                convergencia: analiseDupla.convergencia
            },
            divergencia_macd: divergenciaMACD
        };
        
        const resultado = {
            sinal: sinalFinal.sinal,
            direcao: sinalFinal.sinal === "CALL" ? "ALTA" : sinalFinal.sinal === "PUT" ? "BAIXA" : "NEUTRA",
            probabilidade: sinalFinal.probabilidade,
            tendencia: tendenciaMACD,
            rsi,
            adx: adxData.adx,
            preco_atual: precoAtual,
            variacao_recente: ((precoAtual - precoAnterior) / precoAnterior * 100),
            regra_aplicada: `Análise individual ${timeframeKey}`,
            volatilidade: volatilidadeAtual,
            tipo_ativo: this.tipoAtivo,
            simbolo: this.simbolo,
            decisao_rapida: this.sistemaConfiabilidade.tabelaDecisaoRapida(macdResult.histograma, rsi),
            
            tendencias_duplas: analiseDupla,
            confiabilidade: {
                confiavel: true,
                categoria: "ANALISE_INDIVIDUAL",
                acao_recomendada: sinalFinal.sinal === 'HOLD' ? 'AGUARDAR' : `${sinalFinal.sinal}`,
                motivo: `Análise individual do ${timeframeKey}`
            },
            quasimodo_confirmation: {
                confirmed: confirmacaoQM.confirmed,
                confirmation_type: confirmacaoQM.confirmationType,
                distance_percent: confirmacaoQM.distancePercent,
                pattern_type: confirmacaoQM.pattern ? confirmacaoQM.pattern.type : null,
                pattern_price: confirmacaoQM.pattern ? confirmacaoQM.pattern.price : null
            },
            elliott_wave: {
                pattern: elliottAnalysis.structure.pattern,
                phase: elliottAnalysis.structure.phase,
                trend: elliottAnalysis.trend,
                confidence: elliottAnalysis.confidence,
                suggests_signal: elliottAnalysis.tradingSignals.length > 0 ? 
                    (elliottAnalysis.tradingSignals[0].type === 'BUY' ? 'CALL' : 'PUT') : null
            },
            sinal_combinado: {
                signal: sinalCombinado.signal,
                confidence: sinalCombinado.confidence,
                reason: sinalCombinado.reason
            },
            pesos_automaticos: {
                estado_mercado: estadoMercado,
                tendencia_forca: tendenciaForca,
                volatilidade_nivel: volatilidade
            },
            advanced_analysis: advancedAnalysis,
            velocidade_analysis: velocidadeAnalysis,
            divergencia_macd: divergenciaMACD,
            
            macd_phase: {
                phase: macdPhase.phase,
                name: macdPhase.name,
                icon: macdPhase.icon,
                color: macdPhase.color,
                confidence: macdPhase.confidence,
                recomendacao: macdPhase.recomendacao,
                multiplier: macdPhase.multiplier,
                status: macdPhase.status,
                raw: macdPhase.raw,
                // Campos em inglês requeridos pelo motor de 3 camadas (getTFData no server.js)
                histogram: macdResult.histograma ?? null,
                prev_histogram: prevHistogram
            },
            
            indicator_config: {
                rsi_period: INDICATOR_CONFIG.RSI_PERIOD,
                adx_period: INDICATOR_CONFIG.ADX_PERIOD,
                macd_fast: INDICATOR_CONFIG.MACD_FAST,
                macd_slow: INDICATOR_CONFIG.MACD_SLOW,
                macd_signal: INDICATOR_CONFIG.MACD_SIGNAL
            },
            macd_data: {
                macd: macdResult.macd,
                sinal: macdResult.sinal,
                histograma: macdResult.histograma,
                direcao: macdResult.direcao
            },
            timeframe_key: timeframeKey
        };

        if (timeframeKey === 'M15') {
            const sniperResult = this.analyzeInstitutionalSniper({
                candles: candles,
                rsi: rsi,
                adx: adxData.adx
            }, sinalFinal.probabilidade * 100);

            if (sniperResult) {
                resultado.institutional_sniper = sniperResult;
            }
        }

        return resultado;
    }

    obterTimeframeKey(candles) {
        if (candles.length < 2) return "M5";
        const diff = (candles[1].epoch || candles[1].time) - (candles[0].epoch || candles[0].time);
        if (diff <= 300) return "M5";
        if (diff <= 900) return "M15";
        if (diff <= 1800) return "M30";
        if (diff <= 3600) return "H1";
        if (diff <= 14400) return "H4";
        return "H24";
    }

    clearTimeframeCache() {
        this.timeframesData = {};
        this.multiTimeframeManager = new MultiTimeframeManager();
    }
}

module.exports = { SistemaAnaliseInteligente };
