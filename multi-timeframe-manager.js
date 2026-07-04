// multi-timeframe-manager.js
const { SMOOTHING } = require('./config');

class MultiTimeframeManager {
    constructor(simbolo = '') {
        this.timeframes = {
            M1:  { seconds: 60, label: '1m', data: null, analysis: null },
            M5:  { seconds: 300, label: '5m', data: null, analysis: null },
            M15: { seconds: 900, label: '15m', data: null, analysis: null },
            M30: { seconds: 1800, label: '30m', data: null, analysis: null },
            H1:  { seconds: 3600, label: '1h', data: null, analysis: null },
            H4:  { seconds: 14400, label: '4h', data: null, analysis: null },
            H24: { seconds: 86400, label: '24h', data: null, analysis: null },
            W1:  { seconds: 604800, label: '1w', data: null, analysis: null },
            MN1: { seconds: 2592000, label: '1M', data: null, analysis: null }
        };

        this.consolidatedSignal = { signal: 'HOLD', confidence: 0, agreement: 0, details: {} };
        this.allAnalyses = {};
        this.signalHistory = {};
        this._regimeHistory = []; // para regime estável

        this.simbolo = simbolo;
        this.tipoAtivo = this.detectarTipoAtivo(simbolo);

        this.priceHistory = {
            M1: [], M5: [], M15: [], M30: [],
            H1: [], H4: [], H24: [], W1: [], MN1: []
        };

        this.ultimosRSI = {};

        this.volatilityState = {
            regime: 'UNKNOWN',
            score: 0,
            spikeDetected: false,
            squeezeDetected: false
        };

        // ================= CONFIG =================
        this.CONFIG_ATIVO = {
            DEFAULT: {
                rsiCompra: 30,
                rsiVenda: 70,
                adxMinimo: 20,
                squeezeThreshold: 12,
                spikeThreshold: 35
            }
        };
    }

    // ================= REGIME DE MERCADO (NEW CORE) =================
    detectarRegimeMercado() {
        const adxValues = Object.values(this.allAnalyses)
            .map(a => a?.adx)
            .filter(v => typeof v === 'number');

        const rsiValues = Object.values(this.allAnalyses)
            .map(a => a?.rsi)
            .filter(v => typeof v === 'number');

        if (adxValues.length === 0) return 'UNKNOWN';

        const adxAvg = adxValues.reduce((a, b) => a + b, 0) / adxValues.length;
        const rsiStd = this.calcularDesvio(rsiValues);

        // 🔥 SPIKE = ADX MUITO ALTO + instabilidade RSI
        if (adxAvg > 35 && rsiStd > 12) {
            this.volatilityState.spikeDetected = true;
            return 'SPIKE';
        }

        // 🧊 SQUEEZE = baixa volatilidade + ADX baixo + RSI comprimido
        if (adxAvg < 15 && rsiStd < 6) {
            this.volatilityState.squeezeDetected = true;
            return 'SQUEEZE';
        }

        // 📉 CHOP = meio termo, sem direção
        if (adxAvg < 20) return 'CHOP';

        return 'TREND';
    }

    // ================= PRE-SPIKE DETECTOR =================
    detectarPreSpike() {
        const m1 = this.allAnalyses['M1'];
        const m5 = this.allAnalyses['M5'];

        if (!m1 || !m5) return null;

        const spread = Math.abs(m1.rsi - m5.rsi);
        const adx = (m1.adx + m5.adx) / 2;

        // compressão + divergência = PRE SPIKE
        if (spread > 18 && adx > 20 && adx < 35) {
            return {
                tipo: 'PRE_SPIKE',
                direcao: m1.rsi > m5.rsi ? 'CALL' : 'PUT',
                confianca: 0.65,
                motivo: 'Compressão + divergência RSI entre M1 e M5'
            };
        }

        return null;
    }

    // ================= SQUEEZE BREAKOUT PROBABILITY =================
    calcularSqueezeBreakoutProbability() {
        const adxValues = Object.values(this.allAnalyses)
            .map(a => a?.adx)
            .filter(v => typeof v === 'number');

        if (!adxValues.length) return 0;

        const avg = adxValues.reduce((a, b) => a + b, 0) / adxValues.length;
        const config = require('./config').VOLATILITY_REGIME.SQUEEZE;

        if (avg < config.adxMax) {
            const compressionScore = 1 - (avg / config.adxMax);
            return Math.min(0.95, compressionScore);
        }

        return 0;
    }

    // ================= REGIME ESTÁVEL (ANTI-OSCILAÇÃO) =================
    calcularRegimeEstavel() {
        const regimeAtual = this.detectarRegimeMercado();
        this._regimeHistory.push(regimeAtual);
        if (this._regimeHistory.length > 5) {
            this._regimeHistory.shift();
        }

        const counts = this._regimeHistory.reduce((acc, r) => {
            acc[r] = (acc[r] || 0) + 1;
            return acc;
        }, {});

        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }

    calcularDesvio(arr) {
        if (!arr || arr.length < 2) return 0;
        const mean = arr.reduce((a, b) => a + b) / arr.length;
        const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length;
        return Math.sqrt(variance);
    }

    // ================= SPIKE DETECTOR =================
    detectarSpike(timeframeKey, analysis) {
        if (!analysis) return false;

        const history = this.priceHistory[timeframeKey] || [];
        if (history.length < 10) return false;

        const recent = history.slice(-5).map(p => p.close);
        const older  = history.slice(-15, -5).map(p => p.close);

        if (!older.length) return false;

        const avgOld = older.reduce((a, b) => a + b, 0) / older.length;
        const avgNew = recent.reduce((a, b) => a + b, 0) / recent.length;

        const move = Math.abs((avgNew - avgOld) / avgOld) * 100;

        return move > this.CONFIG_ATIVO.DEFAULT.spikeThreshold;
    }

    // ================= SQUEEZE DETECTOR =================
    detectarSqueeze() {
        const adxValues = Object.values(this.allAnalyses)
            .map(a => a?.adx)
            .filter(v => typeof v === 'number');

        if (!adxValues.length) return false;

        const avg = adxValues.reduce((a, b) => a + b, 0) / adxValues.length;

        return avg < this.CONFIG_ATIVO.DEFAULT.squeezeThreshold;
    }

    // ================= MOMENTUM BONUS (UPGRADED) =================
    calcularMomentumBonus(timeframeKey, analysis) {
        const history = this.signalHistory[timeframeKey] || [];
        if (history.length < 3) return 1.0;

        const last = history.slice(-3);

        let score = 1.0;

        if (last.every(s => s === 'CALL')) score += 0.25;
        if (last.every(s => s === 'PUT'))  score += 0.25;

        if (last[2] === last[1] && last[1] !== last[0]) {
            score += 0.15; // aceleração
        }

        return Math.min(1.5, score);
    }

    // ================= ADAPTIVE THRESHOLDS =================
    ajustarThresholdsPorRegime(baseConfig, regime) {
        const config = { ...baseConfig };

        switch (regime) {
            case 'SPIKE':
                config.rsiCompra += 5;
                config.rsiVenda -= 5;
                config.adxMinimo -= 5;
                break;

            case 'SQUEEZE':
                config.adxMinimo -= 8;
                config.rsiCompra -= 3;
                config.rsiVenda += 3;
                break;

            case 'CHOP':
                config.adxMinimo += 5;
                break;
        }

        return config;
    }

    // ================= CONSOLIDATE (UPGRADED CORE) =================
    consolidateSignals() {
        const preSpike = this.detectarPreSpike();
        const squeezeProb = this.calcularSqueezeBreakoutProbability();
        const regime = this.calcularRegimeEstavel(); // usa regime estável para evitar oscilações

        const baseConfig = this.CONFIG_ATIVO.DEFAULT;
        const config = this.ajustarThresholdsPorRegime(baseConfig, regime);

        let callWeight = 0;
        let putWeight = 0;
        let totalWeight = 0;

        let callCount = 0;
        let putCount = 0;

        const details = {};

        for (const [tf, analysis] of Object.entries(this.allAnalyses)) {
            if (!analysis) continue;

            let weight = analysis.adx || 1;

            // 🔥 spike penalty/boost
            if (regime === 'SPIKE') weight *= 1.2;
            if (regime === 'SQUEEZE') weight *= 0.7;

            // ⚡ spike detection local
            if (this.detectarSpike(tf, analysis)) {
                weight *= 1.5;
            }

            // 🚀 momentum upgrade
            const momentum = this.calcularMomentumBonus(tf, analysis);
            weight *= momentum;

            totalWeight += weight;

            if (analysis.sinal === 'CALL') {
                callWeight += weight;
                callCount++;
            } else if (analysis.sinal === 'PUT') {
                putWeight += weight;
                putCount++;
            }

            details[tf] = {
                sinal: analysis.sinal,
                adx: analysis.adx,
                weight: weight.toFixed(2),
                momentum: momentum.toFixed(2)
            };
        }

        let signal = 'HOLD';
        if (callWeight > putWeight) signal = 'CALL';
        if (putWeight > callWeight) signal = 'PUT';

        let confidence = totalWeight > 0
            ? Math.max(callWeight, putWeight) / totalWeight
            : 0;

        // 🧠 regime modifier via config (REGRAS DO REGIME MULTIPLIERS)
        const regimeCfg = require('./config').REGIME_MULTIPLIERS;
        confidence *= regimeCfg[regime] || 1.0;

        // ⚡ pre-spike boost
        if (preSpike) {
            confidence *= 1.15;
            signal = preSpike.direcao;
        }

        // 🧊 squeeze breakout adicional
        if (squeezeProb > 0.7) {
            confidence *= 1.10;
        }

        // clamp
        confidence = Math.min(0.95, Math.max(0, confidence));

        this.consolidatedSignal = {
            signal,
            confidence,
            regime,
            spike: this.volatilityState.spikeDetected,
            squeeze: this.volatilityState.squeezeDetected,
            details,
            callWeight,
            putWeight,
            preSpike: preSpike || null,
            squeezeProb
        };

        return this.consolidatedSignal;
    }

    // ================= MÉTODOS AUXILIARES (já existentes) =================
    addAnalysis(tfKey, analysis) {
        this.allAnalyses[tfKey] = analysis;

        // Garante que timeframes[tf].analysis está sempre sincronizado
        // (necessário para getTFData() no motor de 3 camadas do server.js)
        if (this.timeframes[tfKey]) {
            this.timeframes[tfKey].analysis = analysis;
        } else {
            // TF dinâmico (ex: sintético) — cria entrada no mapa
            this.timeframes[tfKey] = { data: null, analysis };
        }

        if (analysis && analysis.sinal) {
            if (!this.signalHistory[tfKey]) this.signalHistory[tfKey] = [];
            this.signalHistory[tfKey].push(analysis.sinal);
            if (this.signalHistory[tfKey].length > 20) {
                this.signalHistory[tfKey].shift();
            }
        }
        if (analysis && analysis.preco_atual) {
            if (!this.priceHistory[tfKey]) this.priceHistory[tfKey] = [];
            this.priceHistory[tfKey].push({ close: analysis.preco_atual });
            if (this.priceHistory[tfKey].length > 100) {
                this.priceHistory[tfKey].shift();
            }
        }
    }

    detectarTipoAtivo(symbol) {
        // Mantém o teu detector original, ou podes importar do server.js se preferires
        if (/^WLD/i.test(symbol)) return 'forex';
        if (symbol.startsWith('R_') || symbol.startsWith('1HZ')) return 'volatility_index';
        if (/^BOOM/i.test(symbol))   return 'boom_index';
        if (/^CRASH/i.test(symbol))  return 'crash_index';
        if (/^JD/i.test(symbol))     return 'jump_index';
        if (/^stpRNG/i.test(symbol)) return 'step_index';
        if (/^RB\d+$/i.test(symbol) || /^RDBEAR$/i.test(symbol) || /^RDBULL$/i.test(symbol)) {
            return 'volatility_index';
        }
        if (/XAU|XAG|XPD|XPT/i.test(symbol)) return 'commodity';
        if (/^cry/i.test(symbol)) return 'criptomoeda';
        if (/^frx/i.test(symbol)) return 'forex';
        if (/^OTC_/i.test(symbol)) return 'indice_normal';
        return 'indice_normal';
    }

    setTipoAtivo(tipo) {
        this.tipoAtivo = tipo;
    }

    calculateAgreement() {
        const signals = Object.values(this.allAnalyses).map(a => a?.sinal).filter(Boolean);
        const total = signals.length;
        const callCount = signals.filter(s => s === 'CALL').length;
        const putCount = signals.filter(s => s === 'PUT').length;
        return {
            totalTimeframes: total,
            callCount,
            putCount,
            agreement: total > 0 ? Math.max(callCount, putCount) / total : 0,
            primarySignal: callCount > putCount ? 'CALL' : putCount > callCount ? 'PUT' : 'HOLD'
        };
    }
}

module.exports = MultiTimeframeManager;
