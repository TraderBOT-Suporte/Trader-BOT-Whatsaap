// config.js
module.exports = {
    WS_ENDPOINT: "wss://ws.binaryws.com/websockets/v3?app_id=1089",
    API_TOKEN: process.env.API_TOKEN || "1Jd2sESxdZ24Luv",
    CANDLE_COUNT: 300,

    INDICATOR_CONFIG: {
        RSI_PERIOD: 14,
        ADX_PERIOD: 14,
        MACD_FAST: 12,
        MACD_SLOW: 26,
        MACD_SIGNAL: 9
    },

    ADX_CONFIG: {
        TREND_STRONG: 22,
        TREND_WEAK: 18,
        NO_TREND: 15,
        SPIKE_MIN: 35,
        SQUEEZE_MAX: 15,
        VOLATILE_MARKET: 28,
        CALM_MARKET: 12,
        SNIPER_MIN: 20,
        HUNTER_MIN: 18,
        FISHER_MIN: 15,
        WHALE_MIN: 12
    },

    VOLATILITY_REGIME: {
        SPIKE:   { adxMin: 35, rsiStdMin: 12, confidenceMultiplier: 0.90, momentumMultiplier: 1.35, description: "Explosão forte de preço" },
        SQUEEZE: { adxMax: 15, rsiStdMax: 6,  confidenceMultiplier: 0.75, momentumMultiplier: 1.15, description: "Compressão de volatilidade" },
        CHOP:    { adxMax: 20, confidenceMultiplier: 0.70, momentumMultiplier: 0.80, description: "Mercado lateral" },
        TREND:   { adxMin: 20, confidenceMultiplier: 1.15, momentumMultiplier: 1.00, description: "Tendência ativa" }
    },

    REGIME_MULTIPLIERS: {
        TREND: 1.15,
        CHOP: 0.7,
        SPIKE: 0.9,
        SQUEEZE: 0.85
    },

    DEFAULT_REGIME_CONFIG: {
        spikeThreshold: 35,
        squeezeThreshold: 12
    },

    TRADING_MODES: {
        SNIPER:   { name: 'SNIPER',   minConfidence: 0.55, timeframes: ['M1', 'M5', 'M15'],                      scoreMinimo: 70 },
        HUNTER:   { name: 'CAÇADOR',  minConfidence: 0.45, timeframes: ['M5', 'M15', 'H1', 'H4'],               scoreMinimo: 75 },
        FISHER:   { name: 'PESCADOR', minConfidence: 0.35, timeframes: ['M15', 'H1', 'H4', 'H24'],              scoreMinimo: 80 },
        WHALE:    { name: 'BALEEIRO', minConfidence: 0.40, timeframes: ['M5', 'M15', 'H1', 'H4', 'H24', 'W1', 'MN1'], scoreMinimo: 85 }
    },

    TRADING_MODE: "PADRÃO",

    TIMEFRAMES: {
        M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600,
        H4: 14400, H24: 86400, W1: 604800, MN1: 2592000
    },

    SMOOTHING: {
        H1:  { historySize: 3, minAgreement: 2 },
        H4:  { historySize: 3, minAgreement: 2 },
        H24: { historySize: 3, minAgreement: 2 },
        W1:  { historySize: 2, minAgreement: 2 },
        MN1: { historySize: 2, minAgreement: 2 },
        DEFAULT: { historySize: 1, minAgreement: 1 }
    },

    // ================= OBRIGATÓRIO para advanced-market.js e sistema-analise.js =================
    MARKET_STATE: {
        STRONG_BULL_TREND:   "STRONG_BULL_TREND",
        STRONG_BEAR_TREND:   "STRONG_BEAR_TREND",
        BULLISH_CORRECTION:  "BULLISH_CORRECTION",
        BEARISH_CORRECTION:  "BEARISH_CORRECTION",
        TRANSITION:          "TRANSITION",
        RANGE:               "RANGE",
        EXHAUSTION:          "EXHAUSTION",
        NO_TRADE:            "NO_TRADE"
    },

    SIGNAL_TYPE: {
        TREND_CONTINUATION: "TREND_CONTINUATION",
        PULLBACK:           "PULLBACK",
        TRANSITION:         "TRANSITION",
        RANGE_BREAKOUT:     "RANGE_BREAKOUT",
        NONE:               "NONE"
    },

    // ================= OBRIGATÓRIO para sistema-analise.js (ConfigAtivo.getConfig) =================
    ConfigAtivo: {
        getConfig(simbolo) {
            const tipo = this._detectarTipoAtivo(simbolo);
            const configs = {
                commodity: {
                    nome: 'Commodity',
                    rsi_oversold: 25, rsi_overbought: 75,
                    rsi_extreme_oversold: 15, rsi_extreme_overbought: 85,
                    prob_compra: 0.60, prob_venda: 0.40,
                    peso_tecnica: 0.65, atr_multiplier: 2.0,
                    min_probabilidade: 0.52, tendencia_peso_extra: 1.2,
                    limite_volatilidade_min: 0.05, limite_volatilidade_max: 2.0,
                    usar_adx_corrigido: true, agressividade: 1.2,
                    stop_padrao_pct: 0.8, alvo_moderado_pct: 2.0
                },
                indice_normal: {
                    nome: 'Índice Normal',
                    rsi_oversold: 25, rsi_overbought: 75,
                    rsi_extreme_oversold: 15, rsi_extreme_overbought: 85,
                    prob_compra: 0.58, prob_venda: 0.42,
                    peso_tecnica: 0.60, atr_multiplier: 1.5,
                    min_probabilidade: 0.50, tendencia_peso_extra: 1.1,
                    limite_volatilidade_min: 0.10, limite_volatilidade_max: 2.5,
                    usar_adx_corrigido: true, agressividade: 1.0,
                    stop_padrao_pct: 0.6, alvo_moderado_pct: 1.8
                },
                volatility_index: {
                    nome: 'Volatility Index',
                    rsi_oversold: 20, rsi_overbought: 80,
                    rsi_extreme_oversold: 15, rsi_extreme_overbought: 85,
                    prob_compra: 0.55, prob_venda: 0.45,
                    peso_tecnica: 0.55, atr_multiplier: 1.5,
                    min_probabilidade: 0.45, tendencia_peso_extra: 1.2,
                    limite_volatilidade_min: 0.05, limite_volatilidade_max: 1.5,
                    usar_adx_corrigido: true, agressividade: 1.3,
                    stop_padrao_pct: 0.4, alvo_moderado_pct: 1.2
                },
                criptomoeda: {
                    nome: 'Criptomoeda',
                    rsi_oversold: 20, rsi_overbought: 80,
                    rsi_extreme_oversold: 15, rsi_extreme_overbought: 85,
                    prob_compra: 0.60, prob_venda: 0.40,
                    peso_tecnica: 0.70, atr_multiplier: 2.0,
                    min_probabilidade: 0.50, tendencia_peso_extra: 1.3,
                    limite_volatilidade_min: 0.10, limite_volatilidade_max: 3.0,
                    usar_adx_corrigido: true, agressividade: 1.3,
                    stop_padrao_pct: 0.6, alvo_moderado_pct: 2.0
                }
            };
            return configs[tipo] || configs.indice_normal;
        },
        _detectarTipoAtivo(simbolo) {
            if (!simbolo) return 'indice_normal';
            simbolo = simbolo.toUpperCase();
            if (simbolo.startsWith('R_'))                                        return 'volatility_index';
            else if (simbolo.startsWith('1HZ'))                                  return 'volatility_index';
            else if (simbolo.startsWith('BOOM') || simbolo.startsWith('CRASH'))  return 'volatility_index';
            else if (simbolo.includes('XAU') || simbolo.includes('XAG') || simbolo.includes('OIL')) return 'commodity';
            else if (simbolo.includes('CRY') || simbolo.includes('BTC') || simbolo.includes('ETH')) return 'criptomoeda';
            else if (simbolo.includes('frx'))                                    return 'forex';
            else                                                                 return 'indice_normal';
        }
    },

    // ================= PRO ENGINE – 3 CAMADAS (AJUSTADO) =================
    PRO_ENGINE: {
        MODES: {
            SNIPER: {
                macroTF: 'H1',
                confirmTF: null,
                structureTF: 'M15',
                triggerTF: 'M1',
                macroMinADX: 22,            // ⬆️ 15 → 22 (força real)
                structureMinADX: 20,         // ⬆️ 15 → 20
                triggerMinADX: 18,           // Mantém (gatilho pode ser mais baixo)
                triggerMinRSI_CALL: 48,
                triggerMinRSI_PUT: 52,
                microTF: null,
                microMinADX: 12,             // Mantém
                microMinRSI_CALL: 42,
                microMinRSI_PUT: 58,
                useHistogram: true,
                requireMacroAligned: true,
                REQUIRE_ALIGNMENT: 2
            },
            CAÇADOR: {
                macroTF: 'H4',
                confirmTF: 'H1',
                structureTF: 'M5',
                triggerTF: 'M5',
                macroMinADX: 22,             // ⬆️ 18 → 22
                confirmMinADX: 20,           // ⬆️ 15 → 20
                structureMinADX: 20,         // ⬆️ 17 → 20
                triggerMinADX: 18,           // ⬇️ 20 → 18 (M5 pode ser mais solto)
                triggerMinRSI_CALL: 48,
                triggerMinRSI_PUT: 52,
                microTF: 'M1',
                microMinADX: 15,             // ⬇️ 18 → 15 (micro timing)
                microMinRSI_CALL: 38,
                microMinRSI_PUT: 62,
                useHistogram: true,
                requireMacroAligned: true,
                REQUIRE_ALIGNMENT: 2
            },
            PESCADOR: {
                macroTF: 'H24',
                confirmTF: 'H4',
                structureTF: 'H1',
                triggerTF: 'M15',
                macroMinADX: 20,             // Mantém (20 é o mínimo do mínimo)
                confirmMinADX: 20,           // ⬆️ 19 → 20
                structureMinADX: 20,         // ⬆️ 16 → 20 (crítico!)
                triggerMinADX: 18,           // ⬇️ 20 → 18
                triggerMinRSI_CALL: 48,
                triggerMinRSI_PUT: 52,
                microTF: 'M5',
                microMinADX: 18,             // ⬇️ 20 → 18
                microMinRSI_CALL: 42,
                microMinRSI_PUT: 58,
                useHistogram: true,
                requireMacroAligned: true,
                REQUIRE_ALIGNMENT: 3
            },
            BALEEIRO: {
                macroTF: 'W1',
                confirmTF: 'H24',
                structureTF: 'H1',
                triggerTF: 'M15',
                macroMinADX: 20,             // Mantém
                confirmMinADX: 20,           // ⬆️ 18 → 20
                structureMinADX: 20,         // ⬆️ 14 → 20 (ESSENCIAL!)
                triggerMinADX: 16,           // ⬆️ 14 → 16 (levemente maior)
                triggerMinRSI_CALL: 48,
                triggerMinRSI_PUT: 52,
                microTF: 'M5',
                microMinADX: 18,             // ⬇️ 20 → 18
                microMinRSI_CALL: 42,
                microMinRSI_PUT: 58,
                useHistogram: true,
                requireMacroAligned: true,
                REQUIRE_ALIGNMENT: 3
            }
        },
        SCORE_WEIGHTS: {
            MACRO_ALIGNMENT: 40,
            MOMENTUM: 30,
            TRIGGER: 20,
            REGIME_MULT: 10,
            MICRO_TIMING: 10
        }
    },

    // ================= LÓGICA MULTI-TIMEFRAME =================
    MULTI_TIMEFRAME_LOGIC: {
        H4_WEIGHT: 0.45,
        H1_WEIGHT: 0.25,
        M15_WEIGHT: 0.20,
        M5_WEIGHT: 0.10,
        TREND_PRIORITY: ["H4", "H1"],
        STRUCTURE_TIMEFRAMES: ["M15", "M5"],
        ENTRY_TIMEFRAMES: ["M1", "M5"],
        REQUIRE_ALIGNMENT: {
            SNIPER: 2,
            CAÇADOR: 2,
            PESCADOR: 3,
            BALEEIRO: 2
        },
        ALLOW_COUNTER_TREND: {
            SNIPER: false,
            CAÇADOR: false,
            PESCADOR: true,
            BALEEIRO: true
        }
    },

    // ================= BOT SHIELD CONFIG =================
    BOT_SHIELD_CONFIG: {
        MIN_CONFIDENCE: 55,
        MAX_ALLOWED_DELAY_MS: 60000,
        USE_CLOSED_CANDLES_ONLY: false,
        ELLIOTT_WEIGHT_REDUCTION: 0.8,
        BLOCK_HIGH_IMPACT_TIMES: false,
        HIGH_IMPACT_TIMES: []
    }
};
