const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { createClient } = require('redis');
const { randomUUID } = require('crypto');
const DerivClient = require('./deriv-client');
const { SistemaAnaliseInteligente } = require('./analyzers/sistema-analise');
const MultiTimeframeManager = require('./multi-timeframe-manager');
const BotExecutionCore = require('./bot-execution-core');
const TraderBotAnalise = require('./analyzers/trader-bot-analyzer');
const CandleTradeAnalyzer = require('./trade-analyzer');
const { API_TOKEN, CANDLE_CLOSE_TOLERANCE } = require('./config');
const { detectLiquiditySweepRobusto, calculateATR: calcularATRLiquidity } = require('./analyzers/liquidity-hunter-robusto');
const { getOrCreateDeMarker, destroyAllDeMarkers, demarkerInstances, TF_SECONDS, calcularDeMarkerComHistorico } = require('./demarker');
const { calcularMACD } = require('./indicators');
const PulseEngine = require('./pulse-engine'); // ⭐ Motor de ativos de pulso

// ⭐ Instância global — mantém memória de spikes entre requests
const pulseEngine = new PulseEngine();

const app = express();

// ========== INDICADORES AUXILIARES (EMA, RSI, etc.) ==========
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function trendDirection(candles) {
  if (!candles || candles.length < 21) return 'FLAT';
  const closes = candles.map(c => parseFloat(c.close));
  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  const last9  = e9[e9.length - 1];
  const last21 = e21[e21.length - 1];
  if (last9 > last21 * 1.0005) return 'UP';
  if (last9 < last21 * 0.9995) return 'DOWN';
  return 'FLAT';
}

function trendDirectionShort(candles) {
  if (!candles || candles.length < 9) return 'FLAT';
  const closes = candles.map(c => parseFloat(c.close));
  const e5 = ema(closes, 5);
  const e9 = ema(closes, 9);
  const last5 = e5[e5.length - 1];
  const last9 = e9[e9.length - 1];
  if (last5 > last9 * 1.001) return 'UP';
  if (last5 < last9 * 0.999) return 'DOWN';
  return 'FLAT';
}

function rsiLeaving(rsiValues, threshold, direction) {
  if (!rsiValues || rsiValues.length < 2) return false;
  const current  = rsiValues[rsiValues.length - 1];
  const previous = rsiValues[rsiValues.length - 2];
  if (direction === 'UP')   return previous <= threshold && current > threshold;
  if (direction === 'DOWN') return previous >= threshold && current < threshold;
  return false;
}

function calcularRSIArray(candles, period, window) {
  if (!candles || candles.length < period + window) return [];
  const closes = candles.map(c => parseFloat(c.close));
  const deltas = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i] - closes[i - 1]);
  }
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (deltas[i] > 0) avgGain += deltas[i];
    else avgLoss += Math.abs(deltas[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  const rsiArr = [];
  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  rsiArr.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0));
  for (let i = period; i < deltas.length; i++) {
    const gain = deltas[i] > 0 ? deltas[i] : 0;
    const loss = deltas[i] < 0 ? Math.abs(deltas[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsiArr.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  }
  return rsiArr.slice(-window);
}

// [RETIFICADO] Encerramento gracioso
let isShuttingDown = false;
function gracefulShutdown(signal, err) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`❌ ${signal}:`, err?.message || err);
  if (err?.stack) console.error(err.stack);
  setTimeout(() => process.exit(1), 2000);
}
process.on('uncaughtException', (err) => gracefulShutdown('uncaughtException', err));
process.on('unhandledRejection', (reason) => gracefulShutdown('unhandledRejection', reason));

// ========== CONFIGURAÇÕES DE SEGURANÇA ==========
const SECRETS = {
  '7': process.env.SECRET_KEY_7_DAYS,
  '30': process.env.SECRET_KEY_30_DAYS,
  '90': process.env.SECRET_KEY_90_DAYS,
  '180': process.env.SECRET_KEY_180_DAYS,
  '365': process.env.SECRET_KEY_365_DAYS
};
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Origem não permitida pelo CORS'));
    }
  },
  optionsSuccessStatus: 200
}));

app.use(express.json());
app.set('trust proxy', 1);

// ========== CACHE EM MEMÓRIA COM LIMITE ANTI-OOM ==========
const memoryCache = new Map();
const MAX_MEMORY_CACHE_SIZE = 500;

function getFromMemoryCache(key) {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        memoryCache.delete(key);
        return null;
    }
    return entry.data;
}

function setToMemoryCache(key, data, ttlSeconds) {
    if (memoryCache.size >= MAX_MEMORY_CACHE_SIZE && !memoryCache.has(key)) {
        const firstKey = memoryCache.keys().next().value;
        memoryCache.delete(firstKey);
    }
    memoryCache.set(key, {
        data,
        expiresAt: Date.now() + ttlSeconds * 1000
    });
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryCache) {
        if (now > entry.expiresAt) memoryCache.delete(key);
    }
}, 60000);

// ⭐ Limpeza periódica de memórias de spike expiradas no PulseEngine (a cada 5 min)
setInterval(() => pulseEngine.clearExpiredMemories(), 5 * 60 * 1000);

// ========== CONFIGURAÇÃO DO REDIS (OPCIONAL) ==========
let redisClient = null;
const CANDLE_CLOSE_MARGIN = 5;

function getTTLAlignedToCandle(timeframeSeconds) {
  const nowSec = Math.floor(Date.now() / 1000);
  const elapsedInCandle = nowSec % timeframeSeconds;
  const secondsUntilClose = timeframeSeconds - elapsedInCandle;
  const ttl = Math.max(secondsUntilClose - CANDLE_CLOSE_MARGIN, 3);
  return ttl;
}

const ALL_TIMEFRAMES_CONFIG_STATIC = {
  'M1':  { seconds: 60 },    'M5':  { seconds: 300 },
  'M15': { seconds: 900 },   'M30': { seconds: 1800 },
  'H1':  { seconds: 3600 },  'H4':  { seconds: 14400 },
  'H24': { seconds: 86400 }
};

if (process.env.REDIS_URL) {
  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => console.error('❌ Redis error:', err));
    (async () => {
      await redisClient.connect();
      console.log('✅ Conectado ao Redis');
    })();
  } catch (err) {
    console.error('❌ Falha ao conectar Redis:', err);
    redisClient = null;
  }
} else {
  console.log('⚠️ Redis não configurado - cache em memória ativo');
}

// ========== TRADING MODES ==========

const TRADING_MODES = {
  'SNIPER': {
    timeframes:     ['M1', 'M5', 'M15', 'H1'],       // ✅ Já tem M1
    entryTfs:       ['M1', 'M5', 'M15'],
    primaryTrendTf: 'H1',
    infoTfs:        [],
    description:    'Entradas cirúrgicas de 1-15 minutos'
  },
  'CAÇADOR': {
    timeframes:     ['M1', 'M5', 'M15', 'H1', 'H4'],  // ⭐ Adicionar M1
    entryTfs:       ['M1', 'M5', 'M15', 'H1'],        // ⭐ Adicionar M1
    primaryTrendTf: 'H4',
    infoTfs:        [],
    description:    'Ondas médias de 15-60 minutos'
  },
  'PESCADOR': {
    timeframes:     ['M5', 'M15', 'H1', 'H4', 'H24'], // ⭐ Adicionar M5
    entryTfs:       ['M5', 'M15', 'H1'],              // ⭐ Adicionar M5
    primaryTrendTf: 'H4',
    infoTfs:        ['H24'],
    description:    'Grandes movimentos de horas a dias'
  },
  'BALEEIRO': {
    timeframes:     ['M5', 'M15', 'H1', 'H4', 'H24', 'W1', 'MN1'], // ⭐ Adicionar M5
    entryTfs:       ['M5', 'M15', 'H1'],              // ⭐ Adicionar M5
    primaryTrendTf: 'H4',
    infoTfs:        ['W1', 'MN1'],
    description:    'Posicionamento de dias a meses'
  }
};

function getATRTimeframeByMode(mode) {
  const map = { 'SNIPER': 'M1', 'CAÇADOR': 'M5', 'PESCADOR': 'M15', 'BALEEIRO': 'H4' };
  return map[mode] || 'M5';
}

// ========== ALL TIMEFRAMES CONFIG ==========
const ALL_TIMEFRAMES_CONFIG = {
  'M1':  { key: 'M1',  seconds: 60,    candleCount: 100, minRequired: 50 },
  'M5':  { key: 'M5',  seconds: 300,   candleCount: 120, minRequired: 50 },
  'M15': { key: 'M15', seconds: 900,   candleCount: 100, minRequired: 50 },
  'M30': { key: 'M30', seconds: 1800,  candleCount: 80,  minRequired: 40 },
  'H1':  { key: 'H1',  seconds: 3600,  candleCount: 100, minRequired: 30 },
  'H4':  { key: 'H4',  seconds: 14400, candleCount: 60,  minRequired: 20 },
  'H24': { key: 'H24', seconds: 86400, candleCount: 40,  minRequired: 15 },
  'W1':  { key: 'W1',  seconds: 604800, candleCount: 0,   minRequired: 15 },
  'MN1': { key: 'MN1', seconds: 2592000,candleCount: 0,   minRequired: 8  }
};

function isCandleClosed(candle, timeframeSeconds) {
  if (!candle || !candle.epoch) return true;
  const now = Math.floor(Date.now() / 1000);
  return now >= candle.epoch + timeframeSeconds - CANDLE_CLOSE_TOLERANCE;
}

const inFlightRequests = new Map();

function detectTipoAtivo(symbol) {
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

// ========== DETEÇÃO DE ACELERAÇÃO DE SPREAD (Todos os TFs) ==========
function detectarAceleracaoSpread(candlesMap, modeTimeframes, tipoAtivo) {
  if (!candlesMap || modeTimeframes.length === 0) return null;

  const thresholds = {
    'commodity':        { rangeRatio: 1.8, velocidadeRatio: 2.5 },
    'forex':            { rangeRatio: 2.5, velocidadeRatio: 3.0 },
    'volatility_index': { rangeRatio: 1.5, velocidadeRatio: 2.0 },
    'boom_index':       { rangeRatio: 1.8, velocidadeRatio: 2.0 },
    'crash_index':      { rangeRatio: 1.8, velocidadeRatio: 2.0 },
    'jump_index':       { rangeRatio: 2.0, velocidadeRatio: 2.5 },
    'step_index':       { rangeRatio: 1.5, velocidadeRatio: 2.0 },
    'criptomoeda':      { rangeRatio: 2.0, velocidadeRatio: 2.5 },
    'indice_normal':    { rangeRatio: 2.0, velocidadeRatio: 2.5 },
  };

  const th = thresholds[tipoAtivo] || thresholds['indice_normal'];
  const tfAnalises = [];
  let nivelMaximo = 'NORMAL';
  const niveisRank = { 'NORMAL': 0, 'INICIAL': 1, 'MÉDIA': 2, 'ALTA': 3, 'EXTREMA': 4 };

  for (const tfKey of modeTimeframes) {
    const candles = candlesMap[tfKey];
    if (!candles || candles.length < 10) continue;

    const n = Math.min(10, candles.length);
    const ultimos = candles.slice(-n);

    const ranges = ultimos.map(c => Math.abs(parseFloat(c.high) - parseFloat(c.low)));
    const rangeAtual = ranges[ranges.length - 1];
    const rangeMedio = ranges.slice(0, -1).reduce((a, b) => a + b, 0) / (ranges.length - 1);
    const rangeRatio = rangeMedio > 0 ? rangeAtual / rangeMedio : 1;

    const precos = ultimos.map(c => parseFloat(c.close));
    const velocidades = [];
    for (let i = 1; i < precos.length; i++) {
      velocidades.push(Math.abs(precos[i] - precos[i - 1]));
    }
    const velocidadeAtual = velocidades[velocidades.length - 1];
    const velocidadeMedia = velocidades.slice(0, -1).reduce((a, b) => a + b, 0) / (velocidades.length - 1);
    const velocidadeRatio = velocidadeMedia > 0 ? velocidadeAtual / velocidadeMedia : 1;

    const aceleracao = velocidades.length >= 3
      ? velocidades[velocidades.length - 1] - velocidades[velocidades.length - 2]
      : 0;

    const direcao = precos[precos.length - 1] > precos[precos.length - 2] ? 'UP' : 'DOWN';

    let nivelTF = 'NORMAL';
    if (rangeRatio >= th.rangeRatio * 1.5 && velocidadeRatio >= th.velocidadeRatio * 1.5) {
      nivelTF = 'EXTREMA';
    } else if (rangeRatio >= th.rangeRatio && velocidadeRatio >= th.velocidadeRatio) {
      nivelTF = 'ALTA';
    } else if (rangeRatio >= th.rangeRatio || velocidadeRatio >= th.velocidadeRatio) {
      if (rangeRatio >= th.rangeRatio * 0.8 && velocidadeRatio >= th.velocidadeRatio * 0.8) {
        nivelTF = 'MÉDIA';
      } else {
        nivelTF = 'INICIAL';
      }
    }

    if (nivelTF !== 'NORMAL') {
      tfAnalises.push({
        tf: tfKey,
        nivel: nivelTF,
        rangeRatio: parseFloat(rangeRatio.toFixed(2)),
        velocidadeRatio: parseFloat(velocidadeRatio.toFixed(2)),
        aceleracao: parseFloat(aceleracao.toFixed(4)),
        rangeAtual: parseFloat(rangeAtual.toFixed(5)),
        rangeMedio: parseFloat(rangeMedio.toFixed(5)),
        velocidadeAtual: parseFloat(velocidadeAtual.toFixed(5)),
        velocidadeMedia: parseFloat(velocidadeMedia.toFixed(5)),
        direcao
      });
      if (niveisRank[nivelTF] > niveisRank[nivelMaximo]) {
        nivelMaximo = nivelTF;
      }
    }
  }

  if (nivelMaximo === 'NORMAL') return null;

  const labels = {
    'EXTREMA': '🚨 ACELERAÇÃO EXTREMA',
    'ALTA':    '⚡ ACELERAÇÃO ALTA',
    'MÉDIA':   '📈 ACELERAÇÃO MÉDIA',
    'INICIAL': '👀 INÍCIO DE ACELERAÇÃO'
  };

  const impactoScore = {
    'EXTREMA': 0.70,
    'ALTA':    0.80,
    'MÉDIA':   0.90,
    'INICIAL': 0.95,
  };

  const tfOrdem = ['MN1', 'W1', 'H24', 'H4', 'H1', 'M15', 'M5', 'M1'];
  tfAnalises.sort((a, b) => {
    if (niveisRank[b.nivel] !== niveisRank[a.nivel]) {
      return niveisRank[b.nivel] - niveisRank[a.nivel];
    }
    return tfOrdem.indexOf(a.tf) - tfOrdem.indexOf(b.tf);
  });

  return {
    detectado: true,
    nivel: nivelMaximo,
    label: labels[nivelMaximo],
    tfsAcelerados: tfAnalises,
    totalTfsAcelerados: tfAnalises.length,
    totalTfs: modeTimeframes.length,
    fatorImpacto: impactoScore[nivelMaximo]
  };
}

async function getCandlesWithCache(client, symbol, tf, mode, forceFresh = false, ttlOverride = null) {
  const cacheKey = `candles:${symbol}:${tf.key}`;
  let ttl = ttlOverride !== null ? ttlOverride : getTTLAlignedToCandle(tf.seconds);
  const tipoAtivo = detectTipoAtivo(symbol);
  const isAtivoPulso = ['boom_index','crash_index','jump_index','step_index'].includes(tipoAtivo);
  if (isAtivoPulso && mode === 'SNIPER' && tf.key === 'M1') {
    ttl = Math.min(ttl, 10);
    console.log(`⚡ TTL reduzido para ${ttl}s (ativo de pulso + SNIPER)`);
  }
  if (!forceFresh) {
    const memCached = getFromMemoryCache(cacheKey);
    if (memCached) {
      const entry = memoryCache.get(cacheKey);
      const remaining = entry ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : ttl;
      console.log(`💾 Cache memória: ${cacheKey} (TTL: ${remaining}s)`);
      return memCached;
    }
  }
  if (redisClient && redisClient.isReady && !forceFresh) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const remainingTTL = await redisClient.ttl(cacheKey);
        console.log(`✅ Cache Redis: ${cacheKey} (TTL: ${remainingTTL}s)`);
        let candles;
        try {
          candles = JSON.parse(cached);
        } catch (e) {
          console.error(`❌ Cache corrompido Redis ${cacheKey}:`, e.message);
          await redisClient.del(cacheKey);
          return null;
        }
        setToMemoryCache(cacheKey, candles, remainingTTL > 0 ? remainingTTL : ttl);
        if (remainingTTL <= CANDLE_CLOSE_MARGIN) {
          setImmediate(async () => {
            try {
              const freshCandles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
              if (Array.isArray(freshCandles)) {
                const newTtl = getTTLAlignedToCandle(tf.seconds);
                await redisClient.setEx(cacheKey, newTtl, JSON.stringify(freshCandles));
                setToMemoryCache(cacheKey, freshCandles, newTtl);
              }
            } catch (err) { console.error(`❌ Erro pré-cache: ${err.message}`); }
          });
        }
        return candles;
      }
    } catch (err) { console.error(`❌ Erro Redis ${cacheKey}:`, err.message); }
  }
  if (inFlightRequests.has(cacheKey)) return inFlightRequests.get(cacheKey);
  const fetchPromise = (async () => {
    try {
      console.log(`🔄 Buscando ${tf.key} (${tf.candleCount} candles)`);
      const candles = await client.getCandles(symbol, tf.candleCount, tf.seconds);
      if (!Array.isArray(candles)) return candles;
      console.log(`📊 ${tf.key}: ${candles.length} candles`);
      setToMemoryCache(cacheKey, candles, ttl);
      if (redisClient && redisClient.isReady) {
        redisClient.setEx(cacheKey, ttl, JSON.stringify(candles))
          .catch(err => console.error(`❌ Erro salvando Redis: ${err.message}`));
      }
      return candles;
    } finally { inFlightRequests.delete(cacheKey); }
  })();
  inFlightRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user?.userId || req.ip,
  message: { error: 'Limite de requisições por minuto excedido. Aguarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip,
  message: { error: 'Limite de geração de tokens excedido.' }
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  if (!token && req.body && req.body.token) token = req.body.token;
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  const secretsToTry = [
    { period: 365, key: SECRETS['365'] }, { period: 180, key: SECRETS['180'] },
    { period: 90,  key: SECRETS['90'] },  { period: 30,  key: SECRETS['30'] },
    { period: 7,   key: SECRETS['7'] }
  ];
  for (const { period, key } of secretsToTry) {
    if (!key) continue;
    try {
      const decoded = jwt.verify(token, key);
      req.user = decoded; req.tokenPeriod = period; return next();
    } catch (err) {}
  }
  return res.status(403).json({ error: 'Token inválido ou expirado' });
}

let derivClient = null;
let derivConnectionPromise = null;
let isDerivConnecting = false;
const derivWaiters = [];

async function getDerivClient() {
  if (derivClient && derivClient.ws?.readyState === 1) return derivClient;
  if (isDerivConnecting) {
    return new Promise((resolve, reject) => {
      derivWaiters.push({ resolve, reject });
    });
  }
  isDerivConnecting = true;
  try {
    if (derivClient) {
      try { derivClient.disconnect(); } catch (e) { console.error('⚠️ Erro ao desligar cliente Deriv antigo:', e.message); }
      derivClient = null;
    }
    derivConnectionPromise = null;
    derivClient = new DerivClient(API_TOKEN);
    derivConnectionPromise = derivClient.connect()
      .then(() => { console.log('✅ Cliente Deriv pronto'); return derivClient; })
      .catch(err => {
        console.error('❌ Falha conexão Deriv:', err.message);
        derivConnectionPromise = null;
        derivClient = null;
        throw err;
      });
    const result = await derivConnectionPromise;
    derivWaiters.forEach(w => w.resolve(result));
    return result;
  } catch (err) {
    derivWaiters.forEach(w => w.reject(err));
    throw err;
  } finally {
    isDerivConnecting = false;
    derivWaiters.length = 0;
  }
}

setInterval(async () => {
  try {
    const ws = derivClient?.ws;
    const needsReconnect = !ws || (ws.readyState !== 1 && ws.readyState !== 0);
    if (needsReconnect && !isDerivConnecting) {
      console.log('🔄 [Watchdog] Reconectando Deriv...');
      derivConnectionPromise = null;
      if (derivClient) { try { derivClient.disconnect(); } catch (e) {} derivClient = null; }
      await getDerivClient();
      console.log('✅ [Watchdog] Deriv reconectado com sucesso');
    }
  } catch (err) {
    console.error('❌ [Watchdog] Reconexão Deriv falhou:', err.message);
  }
}, 4 * 60 * 1000);

let tickRequestCounter = 0;

async function getCurrentPrice(client, symbol) {
  return new Promise((resolve) => {
    if (typeof client.addListener !== 'function' || typeof client.removeListener !== 'function') {
      resolve(null); return;
    }
    if (!client.ws || client.ws.readyState !== client.ws.OPEN) {
      resolve(null); return;
    }
    const reqId = `price_${Date.now()}_${++tickRequestCounter}`;
    const handler = (response) => {
      if (response.error) {
        clearTimeout(timeout);
        client.removeListener(reqId, handler);
        resolve(null);
      } else if (response.tick && response.tick.symbol === symbol) {
        clearTimeout(timeout);
        client.removeListener(reqId, handler);
        resolve(response.tick.quote);
      }
    };
    const timeout = setTimeout(() => {
      client.removeListener(reqId, handler);
      resolve(null);
    }, 350);
    client.addListener(reqId, handler);
    client.ws.send(JSON.stringify({ tick: symbol, req_id: reqId }));
  });
}

app.get('/health', (req, res) => {
  const ws = derivClient?.ws;
  const derivStatus = ws?.readyState === 1 ? 'connected' : ws?.readyState === 0 ? 'connecting' : 'disconnected';
  res.status(200).json({
    status: 'OK',
    uptime: Math.floor(process.uptime()),
    deriv: derivStatus,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    cacheKeys: memoryCache.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/trading-modes', (req, res) => {
  res.json({
    success: true,
    modes: Object.keys(TRADING_MODES).map(key => ({
      id: key, name: key,
      description: TRADING_MODES[key].description,
      timeframes: TRADING_MODES[key].timeframes
    }))
  });
});

app.post('/api/validate-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false, message: 'Token não fornecido' });
  const secretsToTry = [
    { period: 365, key: SECRETS['365'] }, { period: 180, key: SECRETS['180'] },
    { period: 90,  key: SECRETS['90'] },  { period: 30,  key: SECRETS['30'] },
    { period: 7,   key: SECRETS['7'] }
  ];
  for (const { period, key } of secretsToTry) {
    if (!key) continue;
    try {
      const decoded = jwt.verify(token, key);
      return res.json({ valid: true, periodDays: period, expiresAt: decoded.exp, userId: decoded.userId || null });
    } catch (err) {}
  }
  return res.status(401).json({ valid: false, message: 'Token inválido ou expirado' });
});

app.post('/api/admin/generate-token', adminLimiter, (req, res) => {
  const { adminKey, periodDays, userId } = req.body;
  if (!adminKey || adminKey !== ADMIN_SECRET) return res.status(403).json({ error: 'Chave de administrador inválida' });
  const period = parseInt(periodDays);
  if (![7, 30, 90, 180, 365].includes(period)) return res.status(400).json({ error: 'Período inválido.' });
  const secret = SECRETS[period.toString()];
  if (!secret) return res.status(500).json({ error: 'Chave não configurada' });
  const finalUserId = userId || randomUUID();
  const token = jwt.sign({ userId: finalUserId, period, jti: randomUUID() }, secret, { expiresIn: period * 86400 });
  res.json({ success: true, token, periodDays: period, expiresIn: period * 86400, userId: finalUserId });
});

app.post('/api/admin/restart-render', adminLimiter, async (req, res) => {
  try {
    if (typeof fetch !== 'function') {
      return res.status(500).json({ success: false, error: 'fetch não disponível (requer Node.js 18+)' });
    }
    const { adminKey } = req.body;
    if (!adminKey || adminKey !== ADMIN_SECRET) return res.status(403).json({ success: false, error: 'Chave inválida' });
    const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;
    const RENDER_API_KEY = process.env.RENDER_API_KEY;
    if (!RENDER_SERVICE_ID || !RENDER_API_KEY) return res.status(500).json({ success: false, error: 'Variáveis Render não configuradas' });
    const response = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/restart`, {
      method: 'POST', headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${RENDER_API_KEY}` }
    });
    if (response.ok) res.json({ success: true, message: 'Serviço reiniciado!' });
    else { const txt = await response.text(); res.status(response.status).json({ success: false, error: txt }); }
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/connection-status', authenticateToken, (req, res) => {
  if (!derivClient) return res.json({ status: 'not_initialized' });
  res.json(derivClient.getConnectionStatus());
});

app.get('/api/demarker/:symbol', authenticateToken, (req, res) => {
  const candleSeconds = parseInt(req.query.tf) || 300;
  const dem = demarkerInstances.get(`${req.params.symbol}:${candleSeconds}`);
  if (!dem) return res.status(404).json({ error: 'Instância não encontrada. Chama /api/analyze primeiro.' });
  const state = dem.getSignalState();
  if (!state) return res.json({
    status: 'aguardando_dados',
    candles_completas: dem.candles.filter(c => c.completed).length,
    necessarias: dem.period + 1
  });
  res.json({ symbol: req.params.symbol, candleSeconds, ...state, timestamp: new Date().toISOString() });
});

// ========== RSI LIMITS POR TIPO DE ATIVO ==========
const RSI_LIMITS_BY_ASSET = {
  'forex':            { pullback: 40, extremo: 25, sobrecompra: 70, sobrevenda: 35 },
  'volatility_index': { pullback: 40, extremo: 30, sobrecompra: 80, sobrevenda: 42 },
  'commodity':        { pullback: 40, extremo: 28, sobrecompra: 72, sobrevenda: 30 },
  'criptomoeda':      { pullback: 35, extremo: 25, sobrecompra: 80, sobrevenda: 25 },
  'indice_normal':    { pullback: 40, extremo: 30, sobrecompra: 72, sobrevenda: 30 },
  'boom_index':       { pullback: 30, extremo: 25, sobrecompra: 80, sobrevenda: 22 },
  'crash_index':      { pullback: 20, extremo: 15, sobrecompra: 78, sobrevenda: 18 },
  'jump_index':       { pullback: 22, extremo: 18, sobrecompra: 78, sobrevenda: 20 },
  'step_index':       { pullback: 35, extremo: 28, sobrecompra: 72, sobrevenda: 30 }
};

// ========== ADX MÍNIMO POR TIPO DE ATIVO ==========
const ADX_MIN_BY_ASSET = {
  'forex':            { h1_pescador: 18, h1_cacador: 14, h4_pescador: 20, m15_sniper: 15, m5_cacador: 16 },
  'volatility_index': { h1_pescador: 12, h1_cacador: 10, h4_pescador: 12, m15_sniper: 12, m5_cacador: 12 },
  'commodity':        { h1_pescador: 18, h1_cacador: 14, h4_pescador: 20, m15_sniper: 15, m5_cacador: 16 },
  'criptomoeda':      { h1_pescador: 14, h1_cacador: 12, h4_pescador: 16, m15_sniper: 13, m5_cacador: 13 },
  'indice_normal':    { h1_pescador: 18, h1_cacador: 14, h4_pescador: 20, m15_sniper: 15, m5_cacador: 16 },
  'boom_index':       { h1_pescador: 18, h1_cacador: 14, h4_pescador: 20, m15_sniper: 15, m5_cacador: 16 },
  'crash_index':      { h1_pescador: 18, h1_cacador: 14, h4_pescador: 20, m15_sniper: 15, m5_cacador: 16 },
  'jump_index':       { h1_pescador: 18, h1_cacador: 14, h4_pescador: 20, m15_sniper: 15, m5_cacador: 16 },
  'step_index':       { h1_pescador: 16, h1_cacador: 12, h4_pescador: 16, m15_sniper: 13, m5_cacador: 13 }
};

// ========== RSI LIMITS DINÂMICOS POR ATIVO + MODO ==========
const RSI_PULSO_LIMITS = {
  'boom_index': {
    'SNIPER':   { callMax: 55, callMin: 35, putOSell: 35, putOBuy: 68 },
    'CAÇADOR':  { callMax: 60, callMin: 40, putOSell: 35, putOBuy: 68 },
    'PESCADOR': { callMax: 65, callMin: 45, putOSell: 35, putOBuy: 68 },
    'BALEEIRO': { callMax: 68, callMin: 48, putOSell: 35, putOBuy: 68 }
  },
  'crash_index': {
    'SNIPER':   { callMax: 65, callMin: 45, putOSell: 32, putOBuy: 62 },
    'CAÇADOR':  { callMax: 60, callMin: 40, putOSell: 32, putOBuy: 62 },
    'PESCADOR': { callMax: 55, callMin: 35, putOSell: 32, putOBuy: 62 },
    'BALEEIRO': { callMax: 58, callMin: 38, putOSell: 32, putOBuy: 62 }
  },
  'jump_index': {
    'SNIPER':   { callMax: 60, callMin: 40, putOSell: 40, putOBuy: 60 },
    'CAÇADOR':  { callMax: 55, callMin: 45, putOSell: 40, putOBuy: 60 },
    'PESCADOR': { callMax: 60, callMin: 40, putOSell: 40, putOBuy: 60 },
    'BALEEIRO': { callMax: 65, callMin: 42, putOSell: 40, putOBuy: 60 }
  },
  'step_index': {
    'SNIPER':   { callMax: 58, callMin: 38, putOSell: 40, putOBuy: 58 },
    'CAÇADOR':  { callMax: 60, callMin: 40, putOSell: 40, putOBuy: 58 },
    'PESCADOR': { callMax: 62, callMin: 42, putOSell: 40, putOBuy: 58 },
    'BALEEIRO': { callMax: 65, callMin: 45, putOSell: 40, putOBuy: 58 }
  }
};

// ========== FUNÇÕES AUXILIARES DO MOTOR ==========

// ⭐⭐⭐ NOVA FUNÇÃO: Detectar Divergência no Macro Layer ⭐⭐⭐
function detectarDivergenciaMacro(mtfManager, PRO_CONFIG, regime) {
  const macroTF = PRO_CONFIG?.macroTF;
  const confirmTF = PRO_CONFIG?.confirmTF;
  
  // Só aplica se tiver confirmTF definido (CAÇADOR, PESCADOR, BALEEIRO)
  if (!confirmTF) return null;
  
  const macro = getTFData(macroTF, mtfManager, true);
  const confirm = getTFData(confirmTF, mtfManager, true);
  
  if (!macro || !confirm) return null;
  
  const macroHistPos = macro.histPositive;
  const confirmHistPos = confirm.histPositive;
  
  // Divergência: histogramas em direções opostas
  if (macroHistPos !== null && confirmHistPos !== null && macroHistPos !== confirmHistPos) {
    
    // Em CHOP: divergência = ruído = HOLD
    if (regime === 'CHOP') {
      return {
        bloqueia: true,
        motivo: `CHOP + Divergência Macro: ${macroTF} ${macroHistPos ? '↑' : '↓'} vs ${confirmTF} ${confirmHistPos ? '↑' : '↓'} — ruído, aguardar alinhamento`,
        zona: 'C'
      };
    }
    
    // Em TREND: divergência = tendência fraca, reduz confiança mas não bloqueia
    if (regime === 'TREND') {
      return {
        bloqueia: false,
        reduzConfianca: 0.30,
        motivo: `Divergência Macro: ${macroTF} ${macroHistPos ? '↑' : '↓'} vs ${confirmTF} ${confirmHistPos ? '↑' : '↓'} — tendência frágil`,
        zona: null
      };
    }
    
    // Outros regimes: bloqueia
    return {
      bloqueia: true,
      motivo: `Divergência Macro: ${macroTF} ${macroHistPos ? '↑' : '↓'} vs ${confirmTF} ${confirmHistPos ? '↑' : '↓'} — sem consenso macro`,
      zona: 'C'
    };
  }
  
  return null;
}

// ========== FUNÇÕES AUXILIARES DO MOTOR ==========
function hasHistogramShift(current, previous, direction) {
  if (current == null || previous == null) return false;
  const up = previous <= 0 && current > 0;
  const down = previous >= 0 && current < 0;
  return direction === 'CALL' ? up : down;
}

function adxWeight(adx) {
  if (adx == null) return 0.3;
  if (adx < 10) return 0.3;
  if (adx < 15) return 0.6;
  if (adx < 20) return 0.8;
  if (adx < 25) return 1.0;
  return 1.2;
}

function rsiConfidenceScore(rsi, signal, tipoAtivo, mode) {
  if (rsi == null) return 0;
  let score = 0;
  if (RSI_PULSO_LIMITS[tipoAtivo] && RSI_PULSO_LIMITS[tipoAtivo][mode]) {
    const lim = RSI_PULSO_LIMITS[tipoAtivo][mode];
    if (signal === 'CALL') {
      if (rsi < lim.callMin) score -= 5;
      else if (rsi > lim.callMax) score -= 3;
      else score += 8;
    } else if (signal === 'PUT') {
      if (rsi > lim.putOBuy) score -= 5;
      else if (rsi < lim.putOSell) score -= 3;
      else score += 8;
    }
  } else {
    const limits = RSI_LIMITS_BY_ASSET[tipoAtivo] || RSI_LIMITS_BY_ASSET.indice_normal;
    if (signal === 'CALL') {
      if (rsi < limits.pullback) score += 6;
      else if (rsi > limits.sobrecompra) score -= 4;
      else score += 3;
    } else if (signal === 'PUT') {
      if (rsi > limits.sobrecompra) score += 6;
      else if (rsi < limits.sobrevenda) score -= 4;
      else score += 3;
    }
  }
  return score;
}
function momentumAfterShiftBonus(currentHist, prevHist) {
  if (currentHist == null || prevHist == null) return 0;
  const currentStrength = Math.abs(currentHist);
  const previousStrength = Math.abs(prevHist);
  if (currentStrength > previousStrength) return 8;
  if (currentStrength < previousStrength * 0.5) return -4;
  return 0;
}

function regimeScoreMultiplier(regime) {
  switch (regime) {
    case 'TREND':   return 1.15;
    case 'CHOP':    return 0.7;
    case 'SPIKE':   return 0.9;
    case 'SQUEEZE': return 0.85;
    default:        return 1.0;
  }
}

// ⭐ NOVA FUNÇÃO getTFData com useLineDirection
function getTFData(tfKey, mtfManager, useLineDirection = false) {
  const analysis = mtfManager?.timeframes?.[tfKey]?.analysis;
  if (!analysis) return null;
  
  const hist = analysis.macd_phase?.histogram ?? null;
  const prevHist = analysis.macd_phase?.prev_histogram ?? null;
  
  // ⭐ CORREÇÃO DEFINITIVA: busca em todos os locais, incluindo raw.macd
  const macdLineRaw = 
    analysis.macd_phase?.macd ?? 
    analysis.macd_phase?.macd_line ?? 
    analysis.macd_phase?.macdLine ?? 
    analysis.macd_phase?.raw?.macd ??
    analysis.macd ?? 
    analysis.macd_line ?? 
    analysis.macdLine ?? 
    null;
  
  const macdLine = macdLineRaw !== null ? parseFloat(macdLineRaw) : null;
  const macdSignal = analysis.macd_phase?.signal ?? null;
  
  let realDirection = 'NEUTRAL';
  let realBias = 'HOLD';
  let conflictReason = null;
  
  // ⭐ CORREÇÃO: calcular histPositive e macdPositive SEMPRE
  let histPositive = (hist !== null) ? (hist > 0) : null;
  let macdPositive = (macdLine !== null && !isNaN(macdLine)) ? (macdLine > 0) : null;

  if (useLineDirection) {
    if (macdLine !== null && !isNaN(macdLine)) {
      if (macdLine > 0) {
        realDirection = 'UP';
        realBias = 'CALL';
        if (hist !== null && hist < 0) {
          conflictReason = `⚠️ ${tfKey}: CALL mas histograma negativo (perdendo força)`;
        }
      } else if (macdLine < 0) {
        realDirection = 'DOWN';
        realBias = 'PUT';
        if (hist !== null && hist > 0) {
          conflictReason = `⚠️ ${tfKey}: PUT mas histograma positivo (perdendo força)`;
        }
      }
    } else if (hist !== null) {
      if (hist > 0) { realDirection = 'UP'; realBias = 'CALL'; }
      else if (hist < 0) { realDirection = 'DOWN'; realBias = 'PUT'; }
    } else {
      realDirection = analysis.sinal === 'CALL' ? 'UP' : analysis.sinal === 'PUT' ? 'DOWN' : 'NEUTRAL';
      realBias = analysis.sinal;
    }
  } else {
    if (hist !== null && macdLine !== null && !isNaN(macdLine)) {
      if (macdPositive === histPositive) {
        realDirection = histPositive ? 'UP' : 'DOWN';
        realBias = histPositive ? 'CALL' : 'PUT';
      } else {
        realDirection = 'NEUTRAL';
        realBias = 'HOLD';
        if (macdPositive && !histPositive) {
          conflictReason = `⚠️ ${tfKey}: MACD positivo mas histograma negativo — conflito interno, direção NEUTRAL`;
        } else if (!macdPositive && histPositive) {
          conflictReason = `⚠️ ${tfKey}: MACD negativo mas histograma positivo — conflito interno, direção NEUTRAL`;
        }
      }
    } else if (hist !== null) {
      if (hist > 0) { realDirection = 'UP'; realBias = 'CALL'; }
      else if (hist < 0) { realDirection = 'DOWN'; realBias = 'PUT'; }
    } else {
      realDirection = analysis.sinal === 'CALL' ? 'UP' : analysis.sinal === 'PUT' ? 'DOWN' : 'NEUTRAL';
      realBias = analysis.sinal;
    }
  }

  return {
    sinal: analysis.sinal,
    direction: realDirection,
    adx: analysis.adx ?? 0,
    rsi: analysis.rsi ?? 50,
    ema: analysis.tendencia ?? 'FLAT',
    hist: hist,
    prevHist: prevHist,
    bias: realBias,
    conflictReason: conflictReason,
    histPositive: histPositive,
    macdPositive: macdPositive
  };
}

function getTrendState(mtfManager, PRO_CONFIG) {
  const macroTF       = PRO_CONFIG?.macroTF       || 'H4';
  const confirmTF     = PRO_CONFIG?.confirmTF     || PRO_CONFIG?.structureTF || 'M15';
  const macroMinADX   = PRO_CONFIG?.macroMinADX   ?? 20;
  const confirmMinADX = PRO_CONFIG?.confirmMinADX ?? PRO_CONFIG?.structureMinADX ?? 18;

  const macro   = getTFData(macroTF, mtfManager, true);
  const confirm = getTFData(confirmTF, mtfManager, true);

  if (!macro) {
    return { direction: 'NEUTRAL', strength: 0, aligned: false,
             reason: `Sem dados ${macroTF}`, macroTF, momentumTF: confirmTF };
  }

  const macroDir = macro.direction;
  if (macroDir === 'NEUTRAL') {
    const neutralReason = macro.conflictReason 
      ? `${macroTF} NEUTRAL: ${macro.conflictReason}`
      : `${macroTF} neutro`;
    return { direction: 'NEUTRAL', strength: 0, aligned: false,
             reason: neutralReason, macroTF, momentumTF: confirmTF };
  }

  if (!confirm || confirm.direction === 'NEUTRAL' || confirm.direction === 'HOLD') {
    const strength = macro.adx >= macroMinADX ? 2 : 1;
    const aligned  = macro.adx >= macroMinADX;
    const confirmStatus = !confirm ? 'indisponível' : 
                          confirm.conflictReason ? `NEUTRAL (conflito MACD/Hist)` : 
                          'NEUTRAL';
    return {
      direction: macroDir, strength, aligned,
      reason: aligned
        ? `Tendência definida apenas por ${macroTF} (${confirmTF} ${confirmStatus})`
        : `${macroTF} sem força suficiente e ${confirmTF} ${confirmStatus}`,
      macroTF, momentumTF: confirmTF || confirmTF,
      conflictReason: confirm?.conflictReason || null
    };
  }
	
  const confirmDir = confirm.direction;
  const aligned = macroDir === confirmDir;

  const strength =
    (macro.adx   >= macroMinADX   ? 1 : 0) +
    (confirm.adx >= confirmMinADX ? 1 : 0) +
    (aligned ? 2 : 0);

  let direction = aligned ? macroDir : 'NEUTRAL';

  let reason = aligned
    ? `Trend definido por ${macroTF}+${confirmTF}`
    : `${macroTF}/${confirmTF} desalinhados ou neutros`;
  
   if (macro.conflictReason) reason += ` | ${macro.conflictReason}`;
  if (confirm.conflictReason) reason += ` | ${confirm.conflictReason}`;

  // ⭐⭐⭐ NOVO: Bloqueio por histogramas desalinhados (CAÇADOR, PESCADOR, BALEEIRO)
  if (aligned && macro.histPositive !== null && confirm.histPositive !== null) {
    if (macro.histPositive !== confirm.histPositive) {
      // Histogramas em direções opostas — tendência frágil
      direction = 'NEUTRAL';
      reason = `Tendência NEUTRAL (histogramas desalinhados: ${macroTF} ${macro.histPositive ? '↑' : '↓'} vs ${confirmTF} ${confirm.histPositive ? '↑' : '↓'} — aguarda alinhamento)`;
    }
  }

  // ⭐⭐⭐ NOVO: Ambos alinhados mas com conflito + histogramas na mesma direção → reversão em curso
  if (aligned && macro.conflictReason && confirm.conflictReason) {
    if (macro.histPositive === true && confirm.histPositive === true) {
      direction = 'UP';
      reason = `Tendência assumida UP (ambos ${macroTF} e ${confirmTF} com histograma positivo — reversão em curso)`;
    } else if (macro.histPositive === false && confirm.histPositive === false) {
      direction = 'DOWN';
      reason = `Tendência assumida DOWN (ambos ${macroTF} e ${confirmTF} com histograma negativo — reversão em curso)`;
    }
  }

  // ⭐⭐⭐ NOVO: MacroTF em sobrevenda/sobrecompra extrema + histograma a virar → reversão provável
  if (aligned && macro.rsi < 30 && macro.histPositive === true) {
    direction = 'UP';
    reason = `Tendência assumida UP (${macroTF} em sobrevenda RSI ${macro.rsi.toFixed(0)} + histograma positivo — reversão provável)`;
  } else if (aligned && macro.rsi > 70 && macro.histPositive === false) {
    direction = 'DOWN';
    reason = `Tendência assumida DOWN (${macroTF} em sobrecompra RSI ${macro.rsi.toFixed(0)} + histograma negativo — reversão provável)`;
  }

  // ⭐⭐⭐ FALLBACK: Histograma do macroTF decide quando há conflito e desalinhados
  // ⭐ CORREÇÃO: só assume direção se o histograma do confirmTF concordar também.
  // Se macro E confirm estiverem cada um com conflito interno (MACD-line vs histograma)
  // E os histogramas discordarem entre si, o conflito é genuíno — não é seguro "chutar".
  if (!aligned && macro.conflictReason) {
    const macroHistPositive = macro.histPositive;
    const confirmHistPositive = confirm?.histPositive ?? null;

    const semDadosConfirm = confirmHistPositive === null;
    const histogramasConcordam = semDadosConfirm ? true : (macroHistPositive === confirmHistPositive);

    if (histogramasConcordam) {
      if (macroHistPositive === true) {
        direction = 'UP';
        reason = `Tendência assumida UP (histograma ${macroTF} positivo — correção em curso)`;
      } else if (macroHistPositive === false) {
        direction = 'DOWN';
        reason = `Tendência assumida DOWN (histograma ${macroTF} negativo — correção em curso)`;
      }
    } else {
      direction = 'NEUTRAL';
      reason = `Tendência NEUTRAL (histogramas de ${macroTF} e ${confirmTF} discordam — conflito genuíno entre TFs, aguarda alinhamento)`;
    }
  }
  return {
    direction, strength, aligned,
    reason, macroTF, momentumTF: confirmTF
  };
}

function getStructureState(trendDirection, mtfManager, PRO_CONFIG) {
  const structureTF    = PRO_CONFIG?.structureTF    || 'M15';
  const structureMinADX = PRO_CONFIG?.structureMinADX ?? 20;

  const tf = getTFData(structureTF, mtfManager, true);
  if (!tf) return { type: 'NEUTRAL', active: false, reason: `Sem dados ${structureTF}`, structureTF };

  const rsi  = tf.rsi;
  const adx  = tf.adx;
  const bias = tf.bias;

  if (trendDirection === 'NEUTRAL') {
    if (bias === 'PUT' && adx > structureMinADX) {
      return {
        type: 'TREND_NEUTRAL_BUT_PUT',
        active: true,
        reason: `${structureTF}: PUT (🔥 BAIXA) mas Trend NEUTRAL — ${structureTF} está em baixa, mas TFs maiores não alinham`,
        structureTF
      };
    }
    if (bias === 'CALL' && adx > structureMinADX) {
      return {
        type: 'TREND_NEUTRAL_BUT_CALL',
        active: true,
        reason: `${structureTF}: CALL (🚀 ALTA) mas Trend NEUTRAL — ${structureTF} está em alta, mas TFs maiores não alinham`,
        structureTF
      };
    }
    return { type: 'NEUTRAL', active: false, reason: `${structureTF}: NEUTRO — sem direção definida`, structureTF };
  }

  let type = 'NEUTRAL';
  if (trendDirection === 'UP') {
    if (bias === 'PUT' && rsi < 45)  type = 'PULLBACK';
    else if (bias === 'CALL' && rsi > 50) type = 'CONTINUATION';
    else if (bias === 'CALL' && rsi < 50) type = 'WEAK_CONTINUATION';
  } else if (trendDirection === 'DOWN') {
    if (bias === 'CALL' && rsi > 55) type = 'PULLBACK';
    else if (bias === 'PUT' && rsi < 50)  type = 'CONTINUATION';
    else if (bias === 'PUT' && rsi > 50)  type = 'WEAK_CONTINUATION';
  }

  const active = adx > structureMinADX || type !== 'NEUTRAL';
  return {
    type, active,
    reason: `${structureTF}: ${type} (ADX ${adx.toFixed(1)}, RSI ${rsi.toFixed(1)})`,
    structureTF
  };
}

// ⭐⭐⭐ getEntryTrigger ATUALIZADO com CONDIÇÃO 2-B + CONDIÇÃO 4 + DeMarker ⭐⭐⭐
function getEntryTrigger(trendDirection, mtfManager, PRO_CONFIG, demarkerInfo = null, tipoAtivo = 'indice_normal') {
	const triggerTF      = PRO_CONFIG?.triggerTF      || 'M5';
  const triggerMinADX  = PRO_CONFIG?.triggerMinADX  ?? 25;
  const rsiMinCall     = PRO_CONFIG?.triggerMinRSI_CALL ?? 50;
  const rsiMinPut      = PRO_CONFIG?.triggerMinRSI_PUT  ?? 50;
	const ADX_MINIMO_CRUZAMENTO = 18; // ⭐ NOVO: piso de força mínima para aceitar cruzamento (CONDIÇÃO 1)

  const tf = getTFData(triggerTF, mtfManager);
  if (!tf) return { ok: false, reason: `Sem dados ${triggerTF}`, triggerTF };

  const adx      = tf.adx;
  const rsi      = tf.rsi;
  const hist     = tf.hist;
  const prevHist = tf.prevHist;
  const bias     = tf.bias;

  // ⭐ Flat zone check
 const flatZoneThresholds = {
  'forex':            { flat: 0.00003,  micro: 0.000008 },
  'commodity':        { flat: 0.05,     micro: 0.01     },
  'criptomoeda':      { flat: 0.01,     micro: 0.002    },
  'boom_index':       { flat: 0.0005,   micro: 0.0001   },
  'crash_index':      { flat: 0.0005,   micro: 0.0001   },
  'jump_index':       { flat: 0.0003,   micro: 0.00008  },
  'step_index':       { flat: 0.0002,   micro: 0.00005  },
  'volatility_index': { flat: 0.0002,   micro: 0.00005  },
  'indice_normal':    { flat: 0.0002,   micro: 0.00005  },
};
const fzTh = flatZoneThresholds[tipoAtivo] || flatZoneThresholds['indice_normal'];
if (hist != null && prevHist != null) {
  const flatZone = Math.abs(hist) < fzTh.flat && Math.abs(prevHist) < fzTh.flat;
  const microVar = Math.abs(hist - prevHist) < fzTh.micro;
  if (flatZone && microVar) return { ok: false, reason: `${triggerTF} em zona morta (flat real)`, triggerTF };
}

  // ⭐ ADX mínimo reduzido para 60% (permite entradas mais cedo)
  const minADXEffective = triggerMinADX * 0.6;
  if (adx < minADXEffective) {
    return { ok: false, reason: `ADX ${triggerTF} baixo (${adx.toFixed(1)} < ${minADXEffective.toFixed(1)}) — sem força`, triggerTF };
  }

  // ⭐⭐⭐ Validação de histograma entre trigger e micro (CAÇADOR, PESCADOR, BALEEIRO)
  // SNIPER fica de fora — entradas rápidas não precisam desta confirmação
  const microTFKey = PRO_CONFIG?.microTF || null;
  
  if (microTFKey) {
    const microCheck = getTFData(microTFKey, mtfManager);
    if (microCheck && microCheck.hist !== null && hist !== null) {
      const microHistPos = microCheck.hist > 0;
      const trigHistPos = hist > 0;
      if (trigHistPos !== microHistPos) {
        return { 
          ok: false, 
          reason: `${triggerTF} hist ${trigHistPos ? '↑' : '↓'} mas ${microTFKey} hist ${microHistPos ? '↑' : '↓'} — aguarda histograma ${microTFKey} alinhar`, 
          triggerTF 
        };
      }
    }
  }

  // ⭐ Obter dados do micro timing para validação cruzada (ADX, RSI, bias)
  const microData = microTFKey ? getTFData(microTFKey, mtfManager) : null;
  const microBias = microData?.bias || 'HOLD';
  const microRSI  = microData?.rsi || 50;
  const microADX  = microData?.adx || 0;

  // ⭐ DeMarker protection
  const demSignal = demarkerInfo?.signal || 'AGUARDAR';
  const demSaysBuy  = demSignal === 'COMPRA';   // DeMarker diz SUBIR
  const demSaysSell = demSignal === 'VENDA';    // DeMarker diz DESCER

  // ⭐ Obter dados do structure TF (M15, H1, etc.) para confirmação extra
  // ⭐⭐⭐ CORREÇÃO: Se structureTF = triggerTF, usar o confirmTF como referência
let structureRefTF = PRO_CONFIG?.structureTF || 'M15';
if (structureRefTF === triggerTF && PRO_CONFIG?.confirmTF) {
  structureRefTF = PRO_CONFIG.confirmTF; // usa H1 ou H4 como referência
}
const structureData = getTFData(structureRefTF, mtfManager, true);
const structureBias = structureData?.bias || 'HOLD';

 if (trendDirection === 'UP') {
    // CONDIÇÃO 1: Cruzamento recente (shift) — agora exige ADX mínimo real
    if (rsi > rsiMinCall && hist > 0 && hasHistogramShift(hist, prevHist, 'CALL') && adx >= ADX_MINIMO_CRUZAMENTO) {
      return { ok: true, reason: `${triggerTF} CALL trigger (cruzamento, ADX ${adx.toFixed(1)})`, triggerTF };
    }
    // CONDIÇÃO 2: Tendência já estabelecida
    if (bias === 'CALL' && hist > 0 && prevHist > 0 && adx >= triggerMinADX) {
      return { ok: true, reason: `${triggerTF} CALL trigger (tendência estabelecida)`, triggerTF };
    }
    // ⭐⭐⭐ CONDIÇÃO 2-B (NOVA): Tendência estabelecida com ADX reduzido + structure CALL + micro CALL
    if (bias === 'CALL' && hist > 0 && prevHist > 0 && 
        adx >= minADXEffective &&
        microTFKey && microBias === 'CALL' &&
        microADX >= 10 &&
        !demSaysSell &&
        structureBias === 'CALL') {
		return { ok: true, reason: `${triggerTF} CALL trigger (tendência estabelecida, ADX reduzido com ${structureRefTF} CALL e ${microTFKey} CALL)`, triggerTF };
    }
    // CONDIÇÃO 3: Reversão por exaustão
    if (rsi < 35 && hasHistogramShift(hist, prevHist, 'CALL')) {
      return { ok: true, reason: `${triggerTF} CALL trigger (reversão por exaustão)`, triggerTF };
    }
    // ⭐⭐⭐ CONDIÇÃO 4 (NOVA): Gatilho atrasado — TF menor já em CALL + DeMarker
    if (bias === 'PUT' && 
        adx >= minADXEffective &&
        rsi > 45 &&
        microTFKey && microBias === 'CALL' &&
        microRSI >= 40 &&
        microADX >= 10 &&
        !demSaysSell) {
      return { ok: true, reason: `${triggerTF} CALL trigger (PUT a perder força — ${microTFKey} já em CALL, reversão iminente a favor da tendência UP)` };
    }
 } else if (trendDirection === 'DOWN') {
    // CONDIÇÃO 1: Cruzamento recente (shift) — agora exige ADX mínimo real
    if (rsi < rsiMinPut && hist < 0 && hasHistogramShift(hist, prevHist, 'PUT') && adx >= ADX_MINIMO_CRUZAMENTO) {
      return { ok: true, reason: `${triggerTF} PUT trigger (cruzamento, ADX ${adx.toFixed(1)})`, triggerTF };
    }
    // CONDIÇÃO 2: Tendência já estabelecida
    if (bias === 'PUT' && hist < 0 && prevHist < 0 && adx >= triggerMinADX) {
      return { ok: true, reason: `${triggerTF} PUT trigger (tendência estabelecida)`, triggerTF };
    }
    // ⭐⭐⭐ CONDIÇÃO 2-B (NOVA): Tendência estabelecida com ADX reduzido + structure PUT + micro PUT
    if (bias === 'PUT' && hist < 0 && prevHist < 0 && 
        adx >= minADXEffective &&
        microTFKey && microBias === 'PUT' &&
        microADX >= 10 &&
        !demSaysBuy &&
        structureBias === 'PUT') {
		return { ok: true, reason: `${triggerTF} PUT trigger (tendência estabelecida, ADX reduzido com ${structureRefTF} PUT e ${microTFKey} PUT)`, triggerTF };
    }
    // CONDIÇÃO 3: Reversão por exaustão
    if (rsi > 65 && hasHistogramShift(hist, prevHist, 'PUT')) {
      return { ok: true, reason: `${triggerTF} PUT trigger (reversão por exaustão)`, triggerTF };
    }
    // ⭐⭐⭐ CONDIÇÃO 4 (NOVA): Gatilho atrasado — TF menor já em PUT + DeMarker
    if (bias === 'CALL' && 
        adx >= minADXEffective &&
        rsi < 55 &&
        microTFKey && microBias === 'PUT' &&
        microRSI <= 60 &&
        microADX >= 10 &&
        !demSaysBuy) {
      return { ok: true, reason: `${triggerTF} PUT trigger (CALL a perder força — ${microTFKey} já em PUT, reversão iminente a favor da tendência DOWN)` };
    }
  }

  return { ok: false, reason: `${triggerTF} sem condições de entrada`, triggerTF };
}

function resolveSignal(trendState, structureState, entryState, mode) {
  const PRO_CONFIG = require('./config').PRO_ENGINE.MODES[mode];
  const reqAlign = PRO_CONFIG?.REQUIRE_ALIGNMENT 
    || { 'SNIPER': 2, 'CAÇADOR': 2, 'PESCADOR': 3, 'BALEEIRO': 3 }[mode] 
    || 3;

  let alignCount = 0;
  if (trendState.aligned) alignCount += 2;
  if (structureState.active && structureState.type !== 'NEUTRAL') alignCount += 1;
  if (entryState.ok) alignCount += 1;

  if (alignCount >= reqAlign && entryState.ok) {
    return { signal: trendState.direction === 'UP' ? 'CALL' : 'PUT', strength: 'STRONG' };
  }
  if (entryState.ok && structureState.type === 'PULLBACK') {
    return { signal: trendState.direction === 'UP' ? 'CALL' : 'PUT', strength: 'WEAK' };
  }
  return { signal: 'HOLD', strength: 'NONE' };
}

// ⭐⭐⭐ Função getMicroTiming (OBRIGATÓRIA) ⭐⭐⭐
function getMicroTiming(trendDirection, mtfManager, microTF, minADX, minRSI_CALL, minRSI_PUT) {
  const tf = getTFData(microTF, mtfManager);
  if (!tf) return { ok: false, reason: `Sem dados ${microTF}`, bonus: 0 };

  const adx = tf.adx;
  const rsi = tf.rsi;
  const hist = tf.hist;
  const prevHist = tf.prevHist;
  const bias = tf.bias;

  if (adx < minADX) {
    return { ok: false, reason: `${microTF} ADX insuficiente (${adx.toFixed(1)} < ${minADX})`, bonus: 0 };
  }

  if (trendDirection === 'UP') {
    if (bias === 'CALL' && hist > 0) {
      return { ok: true, reason: `${microTF} CALL confirma tendência UP`, bonus: 10 };
    }
    if (bias === 'PUT') {
      return { ok: false, reason: `${microTF} PUT — contra tendência UP`, bonus: 0 };
    }
    if (rsi < 35 && hasHistogramShift(hist, prevHist, 'CALL')) {
      return { ok: true, reason: `${microTF} reversão CALL por exaustão`, bonus: 5 };
    }
    return { ok: false, reason: `${microTF} não confirma UP (bias=${bias}, RSI=${rsi.toFixed(0)})`, bonus: 0 };
  } else if (trendDirection === 'DOWN') {
    if (bias === 'PUT' && hist < 0) {
      return { ok: true, reason: `${microTF} PUT confirma tendência DOWN`, bonus: 10 };
    }
    if (bias === 'CALL') {
      return { ok: false, reason: `${microTF} CALL — contra tendência DOWN`, bonus: 0 };
    }
    if (rsi > 65 && hasHistogramShift(hist, prevHist, 'PUT')) {
      return { ok: true, reason: `${microTF} reversão PUT por exaustão`, bonus: 5 };
    }
    return { ok: false, reason: `${microTF} não confirma DOWN (bias=${bias}, RSI=${rsi.toFixed(0)})`, bonus: 0 };
  }

  return { ok: false, reason: `${microTF} sem direção definida`, bonus: 0 };
}

// ========== DETETOR DE PULSO RECENTE + EXAUSTÃO PRÉ-PULSO ==========

function calcularStopTakePorModo(candlesMap, mode, timing, tipoAtivo) {
  const PRIMARY_TF_BY_MODE = { 'SNIPER': 'M1', 'CAÇADOR': 'M5', 'PESCADOR': 'M15', 'BALEEIRO': 'H1' };
  const primaryTf = PRIMARY_TF_BY_MODE[mode] || 'M5';
  
  if (!primaryTf || !timing) {
    console.log(`⚠️ calcularStopTakePorModo: sem timing para ${mode}`);
    return null;
  }
  
  // ⭐⭐⭐ CORREÇÃO: Para ativos de pulso com score alto, calcula TP/SL mesmo sem timing OK
  const isPulso = ['boom_index','crash_index','jump_index','step_index'].includes(tipoAtivo);
  if (!timing.permitido) {
    if (!isPulso) {
      console.log(`⚠️ TP/SL não calculado: timing não permite`);
      return null;
    }
    // Para ativos de pulso, continuamos — o motor já decidiu que o score justifica a entrada
    console.log(`⚠️ TP/SL calculado mesmo sem timing OK (ativo de pulso com score elevado)`);
  }

  const candles = candlesMap[primaryTf];
  if (!candles || candles.length === 0) {
    console.log(`⚠️ calcularStopTakePorModo: sem candles para ${primaryTf}`);
    return null;
  }

  const ultimoCandle = candles[candles.length - 1];
  if (!ultimoCandle) {
    console.log(`⚠️ calcularStopTakePorModo: último candle inválido`);
    return null;
  }
  
  ultimoCandle.open  = parseFloat(ultimoCandle.open) || 0;
  ultimoCandle.high  = parseFloat(ultimoCandle.high) || 0;
  ultimoCandle.low   = parseFloat(ultimoCandle.low) || 0;
  ultimoCandle.close = parseFloat(ultimoCandle.close) || 0;

  if (ultimoCandle.close <= 0) {
    console.log(`⚠️ calcularStopTakePorModo: preço inválido (${ultimoCandle.close})`);
    return null;
  }

  const sinalTiming = timing.sinal;
  if (!sinalTiming || (sinalTiming !== 'CALL' && sinalTiming !== 'PUT')) {
    console.log(`⚠️ calcularStopTakePorModo: sinal inválido (${sinalTiming})`);
    return null;
  }
  
  const margem    = isPulso ? 0.02 : 0.002;
  const riscoMult = isPulso ? 2 : 3;
  
  if (!margem || !riscoMult || riscoMult <= 0) {
    console.log(`⚠️ calcularStopTakePorModo: margem/riscoMult inválidos`);
    return null;
  }
  
  const tradeAnalyzer = new CandleTradeAnalyzer(margem, riscoMult);

  if (sinalTiming === 'CALL') {
    const result = tradeAnalyzer.calcularNiveisLong(ultimoCandle);
    if (!result || isNaN(result.takeProfit) || isNaN(result.stopLoss)) {
      console.log(`⚠️ calcularStopTakePorModo: resultado CALL inválido`);
      return null;
    }
    return result;
  }
  
  if (sinalTiming === 'PUT') {
    const result = tradeAnalyzer.calcularNiveisShort(ultimoCandle);
    if (!result || isNaN(result.takeProfit) || isNaN(result.stopLoss)) {
      console.log(`⚠️ calcularStopTakePorModo: resultado PUT inválido`);
      return null;
    }
    return result;
  }
  
  return null;
}

function calcularPontoFranco(mtfManager, tipoAtivo) {
  if (!['boom_index','crash_index'].includes(tipoAtivo)) return null;
  const h4  = mtfManager.timeframes['H4']?.analysis;
  const m1  = mtfManager.timeframes['M1']?.analysis;
  const m5  = mtfManager.timeframes['M5']?.analysis;
  const m15 = mtfManager.timeframes['M15']?.analysis;
  if (!h4 || !m1 || !m5 || !m15) return null;
  const alinhado = h4.sinal === m1.sinal && m1.sinal === m5.sinal && m5.sinal === m15.sinal;
  const h4Forte  = h4.adx > 30;
  const m1Forte  = m1.adx > 35;
  if (alinhado && h4Forte && m1Forte && h4.sinal !== 'HOLD') {
    return {
      tipo: `PONTO_FRANCO_${h4.sinal}`,
      confianca: 0.95,
      detalhes: { h4_adx: h4.adx, m1_adx: m1.adx, direcao: h4.sinal, timeframes_alinhados: ['H4','M15','M5','M1'] }
    };
  }
  return null;
}

function buildTimingResult(analysis, signal, tf, label, mode) {
  if (!analysis) return { permitido: false, motivo: `${label} não disponível`, rsi: null, sinal: null, adx: null, alerta_pullback: null };
  const adx       = analysis.adx || 0;
  const rsi       = analysis.rsi || 50;
  const tipoAtivo = analysis.tipo_ativo || 'indice_normal';
  
  if (signal === 'HOLD') return { permitido: false, motivo: 'Sinal HOLD - aguardar', rsi, sinal: analysis.sinal, adx, alerta_pullback: null };

  let rsiMax, rsiMin, rsiOSell, rsiOBuy;
  const limite = RSI_PULSO_LIMITS[tipoAtivo]?.[mode];
  if (limite) {
    rsiMax = limite.callMax;
    rsiMin = limite.callMin;
    rsiOSell = limite.putOSell;
    rsiOBuy = limite.putOBuy;
  } else {
    if (label === 'M15') {
      rsiMax = 72; rsiMin = 28; rsiOSell = 36; rsiOBuy = 65;
    } else {
      rsiMax = 75; rsiMin = 25; rsiOSell = 38; rsiOBuy = 62;
    }
  }

  // ⭐ Usa o histograma para determinar a direção real (como o getTFData)
  const hist = analysis.macd_phase?.histogram ?? null;
  const macdLine = analysis.macd_phase?.macd ?? null;
  
  // Determina a direção real baseada no MACD + Histograma
  let realBias = analysis.sinal;
  if (hist !== null && macdLine !== null) {
    const histPositive = hist > 0;
    const macdPositive = macdLine > 0;
    if (macdPositive === histPositive) {
      realBias = histPositive ? 'CALL' : 'PUT';
    }
  }
  
  // ⭐ Mensagem que mostra a direção real (histograma)
  const histDir = hist > 0 ? '↑' : hist < 0 ? '↓' : '→';

  if (signal === 'CALL') {
    if (realBias === 'CALL' && rsi < rsiMax) return { permitido: true, motivo: `${label} confirmando CALL (RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: realBias, adx, alerta_pullback: null };
    if (realBias === 'PUT'  && rsi < rsiOSell) return { permitido: true, motivo: `${label} oversold - reversão CALL (RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: realBias, adx, alerta_pullback: null };
    // ⭐ Mensagem corrigida: mostra que ainda não virou
    if (realBias === 'PUT') {
      return { permitido: false, motivo: `${label} ainda não virou para CALL (hist ${histDir}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: realBias, adx, alerta_pullback: null };
    }
    return { permitido: false, motivo: `${label} ainda não confirma CALL (hist ${histDir}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: realBias, adx, alerta_pullback: null };
  }
  if (signal === 'PUT') {
    if (realBias === 'PUT'  && rsi > rsiMin) return { permitido: true, motivo: `${label} confirmando PUT (RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: realBias, adx, alerta_pullback: null };
    if (realBias === 'CALL' && rsi > rsiOBuy) return { permitido: true, motivo: `${label} overbought - reversão PUT (RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: realBias, adx, alerta_pullback: null };
    // ⭐ Mensagem corrigida: mostra que ainda não virou
    if (realBias === 'CALL') {
      return { permitido: false, motivo: `${label} ainda não virou para PUT (hist ${histDir}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: realBias, adx, alerta_pullback: null };
    }
    return { permitido: false, motivo: `${label} ainda não confirma PUT (hist ${histDir}, RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: realBias, adx, alerta_pullback: null };
  }
  return { permitido: false, motivo: `${label} sinal indeterminado (RSI ${rsi.toFixed(0)}, ADX ${adx.toFixed(0)})`, rsi, sinal: realBias, adx, alerta_pullback: null };
}

function calcularTimingM1(a, s, mode)  { return buildTimingResult(a, s, 'M1',  'M1', mode); }
function calcularTimingM5(a, s, mode)  { return buildTimingResult(a, s, 'M5',  'M5', mode); }
function calcularTimingM15(a, s, mode) { return buildTimingResult(a, s, 'M15', 'M15', mode); }
function calcularTimingH1(a, s, mode) {
  if (!a) return { permitido: false, motivo: 'H1 não disponível', rsi: null, sinal: null, adx: null, alerta_pullback: null };
  if (mode === 'BALEEIRO') return buildTimingResult(a, s, 'H1', 'H1', mode);
  return { permitido: false, motivo: 'H1 é TF de tendência', rsi: a.rsi || 50, sinal: a.sinal, adx: a.adx || 0, alerta_pullback: null };
}
function calcularTimingH4(a, s) {
  if (!a) return { permitido: false, motivo: 'H4 não disponível', rsi: null, sinal: null, adx: null, alerta_pullback: null };
  return { permitido: false, motivo: 'H4 é TF de tendência', rsi: a.rsi || 50, sinal: a.sinal, adx: a.adx || 0, alerta_pullback: null };
}
function calcularAnaliseManualMN1(candles, tipoAtivo) {
  const closes = candles.map(c => parseFloat(c.close));
  const n = closes.length;

  const emaFn = (arr, p) => {
    const period = Math.min(p, arr.length);
    const k = 2 / (period + 1);
    let v = arr[0];
    for (let i = 1; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
    return v;
  };

  const e5 = emaFn(closes, Math.min(5, n));
  const e9 = emaFn(closes, Math.min(9, n));

  let dir = 'HOLD';
  if (e5 > e9 * 1.001)      dir = 'CALL';
  else if (e5 < e9 * 0.999) dir = 'PUT';

  let rsi = 50;
  if (n >= 3) {
    const deltas = closes.slice(1).map((c, i) => c - closes[i]);
    const gains  = deltas.filter(d => d > 0);
    const losses = deltas.filter(d => d < 0).map(Math.abs);
    const avgG   = gains.length  ? gains.reduce((a, b)  => a + b, 0)  / deltas.length : 0;
    const avgL   = losses.length ? losses.reduce((a, b) => a + b, 0) / deltas.length : 0;
    rsi = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
    rsi = Math.max(0, Math.min(100, rsi));
  }

  let adx = 0;
  if (n >= 3) {
    const ranges   = candles.map(c => Math.abs(parseFloat(c.high) - parseFloat(c.low)));
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const avgClose = closes.reduce((a, b) => a + b, 0) / closes.length;
    adx = Math.min(50, (avgRange / avgClose) * 1000);

    let reversals = 0;
    for (let i = 2; i < closes.length; i++) {
      const prev = closes[i-1] - closes[i-2];
      const curr = closes[i]   - closes[i-1];
      if (prev !== 0 && curr !== 0 && prev * curr < 0) reversals++;
    }
    const reversalRate = reversals / Math.max(1, closes.length - 2);
    adx = Math.max(0, adx * (1 - reversalRate * 0.5));
  }

  const macdValue = (e5 - e9) / Math.max(e9, 1);
  const fase = dir === 'PUT'
    ? (adx > 20 ? { name: 'BAIXA FORTE', phase: 'STRONG_BEAR' } : { name: 'BAIXA', phase: 'BEAR' })
    : dir === 'CALL'
    ? (adx > 20 ? { name: 'ALTA FORTE',  phase: 'STRONG_BULL' } : { name: 'ALTA',  phase: 'BULL' })
    : { name: 'NEUTRO', phase: 'NEUTRAL' };

  console.log(`📐 MN1 manual: dir=${dir} adx=${adx.toFixed(1)} rsi=${rsi.toFixed(1)} candles=${n} e5=${e5.toFixed(2)} e9=${e9.toFixed(2)}`);

  return {
    sinal:        dir,
    probabilidade: dir !== 'HOLD' ? Math.min(0.85, 0.5 + (adx / 100)) : 0.5,
    adx,
    rsi,
    preco_atual:  closes[closes.length - 1],
    macd_phase:   fase,
    divergencia_macd: { divergencia: false },
    tipo_ativo:   tipoAtivo,
    tendencia:    dir === 'CALL' ? 'UP' : dir === 'PUT' ? 'DOWN' : 'FLAT',
    volatilidade: 1.0,
    _fonte:       'manual_mn1'
  };
}

function calcularFallbackBasico(candles, tipoAtivo) {
  const closes = candles ? candles.map(c => parseFloat(c.close)) : [];
  const lastClose = closes.length ? closes[closes.length - 1] : 0;
  return {
    sinal:        'HOLD',
    probabilidade: 0.5,
    adx:          0,
    rsi:          50,
    preco_atual:  lastClose,
    macd_phase:   { name: 'NEUTRO', phase: 'NEUTRAL' },
    divergencia_macd: { divergencia: false },
    tipo_ativo:   tipoAtivo,
    tendencia:    'FLAT',
    volatilidade: 1.0,
    _fonte:       'fallback'
  };
}

// ========== ROTA PRINCIPAL — /api/analyze ==========
app.post('/api/analyze', authenticateToken, analyzeLimiter, async (req, res) => {
  const startTime = Date.now();

  try {
    const { symbol, mode } = req.body;

    if (!symbol || typeof symbol !== 'string' || symbol.length > 20 || !/^[A-Za-z0-9_]+$/.test(symbol)) {
      return res.status(400).json({ error: 'Símbolo inválido ou não permitido' });
    }
    if (!mode || !TRADING_MODES[mode]) return res.status(400).json({ error: 'Modo inválido. Use: SNIPER, CAÇADOR, PESCADOR ou BALEEIRO', availableModes: Object.keys(TRADING_MODES) });

    console.log(`\n🎯 ${mode} | ${symbol}`);
    const client = await getDerivClient();
    const tipoAtivo = detectTipoAtivo(symbol);
    console.log(`🏷️  ${tipoAtivo}`);
	
	const PRIMARY_TF_MAP_DEM = { 'SNIPER': 'M1', 'CAÇADOR': 'M5', 'PESCADOR': 'M15', 'BALEEIRO': 'H1' };
    const primaryTfForDem  = PRIMARY_TF_MAP_DEM[mode] || 'M1';
    const primaryTfSeconds = TF_SECONDS[primaryTfForDem] || 300;
    const demarker = getOrCreateDeMarker(client, symbol, primaryTfSeconds);
    let demState     = null;
    let demarkerInfo = { value: null, signal: 'SEM_DADOS', locked: false };
    let demSource    = 'aguardando';

    const modeTimeframes = TRADING_MODES[mode].timeframes;
    const primaryTrendTf = TRADING_MODES[mode].primaryTrendTf;
    const entryTfs       = TRADING_MODES[mode].entryTfs || modeTimeframes;
    const atrTfKey = getATRTimeframeByMode(mode);
    const allTfKeys = Array.from(new Set([atrTfKey, primaryTrendTf, ...modeTimeframes]));

    const SYNTHETIC_TFS = new Set(mode === 'BALEEIRO' ? ['W1', 'MN1'] : []);
    const candlesMap = {};

    const h24BigPromise = (mode === 'BALEEIRO')
      ? (async () => {
          try {
            console.log(`🔄 Buscando H24_BIG diretamente (1500 candles)...`);
            const data = await client.getCandles(symbol, 1500, 86400);
            console.log(`📊 H24_BIG: ${data?.length || 0} candles recebidos`);
            return data;
          } catch (err) {
            console.error(`❌ Erro ao buscar H24_BIG:`, err.message);
            try {
              const fallback = await client.getCandles(symbol, 400, 86400);
              console.log(`📊 H24_BIG (fallback): ${fallback?.length || 0} candles`);
              return fallback;
            } catch (err2) {
              console.error(`❌ Fallback H24_BIG falhou:`, err2.message);
              return null;
            }
          }
        })()
      : Promise.resolve(null);

    const tickPromise = getCurrentPrice(client, symbol);

    const timeframesToAnalyze = modeTimeframes
      .filter(tfKey => !SYNTHETIC_TFS.has(tfKey))
      .map(tfKey => {
        const tf = { ...ALL_TIMEFRAMES_CONFIG[tfKey] };
        if (tipoAtivo === 'criptomoeda') tf.candleCount = 60;
        return tf;
      });

    await Promise.all(
      allTfKeys.map(async (tfKey) => {
        if (SYNTHETIC_TFS.has(tfKey)) return;
        const tf = timeframesToAnalyze.find(t => t.key === tfKey) || ALL_TIMEFRAMES_CONFIG[tfKey];
        if (!tf) return;
        try {
          const isModeTimeframe = modeTimeframes.includes(tfKey);
          const candles = await getCandlesWithCache(client, symbol, tf, mode, isModeTimeframe);
          if (Array.isArray(candles) && candles.length > 0) candlesMap[tfKey] = candles;
        } catch (err) { console.error(`❌ ${tfKey}:`, err.message); }
      })
    );

    if (mode === 'BALEEIRO') {
      const h24Big = await h24BigPromise;

      if (Array.isArray(h24Big) && h24Big.length >= 60) {
        const agregarCandles = (candles, dias) => {
          const sorted = [...candles].sort((a, b) => a.epoch - b.epoch);
          const aggregated = [];
          for (let i = 0; i < sorted.length; i += dias) {
            const slice = sorted.slice(i, i + dias);
            if (slice.length === 0) continue;
            const open  = parseFloat(slice[0].open);
            const close = parseFloat(slice[slice.length - 1].close);
            const high  = Math.max(...slice.map(c => parseFloat(c.high)));
            const low   = Math.min(...slice.map(c => parseFloat(c.low)));
            const epoch = slice[0].epoch;
            aggregated.push({ open: open.toString(), close: close.toString(), high: high.toString(), low: low.toString(), epoch });
          }
          return aggregated;
        };

        candlesMap['W1']  = agregarCandles(h24Big, 7);
        candlesMap['MN1'] = agregarCandles(h24Big, 30);
        if (!candlesMap['H24']) candlesMap['H24'] = h24Big.slice(-200);
        console.log(`🐋 Sintéticos: W1=${candlesMap['W1'].length} MN1=${candlesMap['MN1'].length}`);
      } else {
        console.warn(`⚠️ H24_BIG não tem dados suficientes (${h24Big?.length || 0} candles)`);
      }
    }

    let historicalCandles = candlesMap[atrTfKey] || null;
    if (!historicalCandles) {
      for (const fbKey of ['M5', 'M15', 'M1', 'H4']) {
        if (candlesMap[fbKey]) { historicalCandles = candlesMap[fbKey]; break; }
      }
    }

    const mtfManager = new MultiTimeframeManager(symbol);
    if (typeof mtfManager.setTipoAtivo === 'function') mtfManager.setTipoAtivo(tipoAtivo);
    else if (mtfManager.tipoAtivo !== undefined) mtfManager.tipoAtivo = tipoAtivo;

    const sistemaBase = new SistemaAnaliseInteligente(symbol);
    if (sistemaBase.sistemaPesos?.setTipoAtivo) sistemaBase.sistemaPesos.setTipoAtivo(tipoAtivo);

    let currentPrice = null;
    let priceSource  = 'tick';
    try { currentPrice = await tickPromise; } catch (e) { currentPrice = null; }

    await Promise.all(
      timeframesToAnalyze.map(async (tf) => {
        try {
          const candles = candlesMap[tf.key];
          if (!candles || candles.length < tf.minRequired) return;

          const last = candles[candles.length - 1];
          const candleAberto = last && !isCandleClosed(last, tf.seconds);

          // ⭐ FIX JOJO: o SINAL (MACD/histograma/RSI/ADX) usa só candles FECHADOS.
          // O candle em formação NÃO entra no cálculo do sinal — evita oscilar a cada tick.
          let candlesParaSinal = candles;
          if (candleAberto) {
            const fechados = candles.slice(0, -1);
            candlesParaSinal = fechados.length >= tf.minRequired ? fechados : candles;
          }

          const analysis = await sistemaBase.analisar(candlesParaSinal, tf.key);

          // ⭐ O tick ao vivo só é aplicado DEPOIS de calcular o sinal —
          // serve para candleOpenPrice/priceMovedFromOpen/TP-SL, nunca para o histograma.
          if (currentPrice && candleAberto) {
            const price = parseFloat(currentPrice);
            last.close = price.toString();
            if (price > parseFloat(last.high)) last.high = price.toString();
            if (price < parseFloat(last.low))  last.low  = price.toString();
          }

          if (analysis && !analysis.erro) {
            mtfManager.addAnalysis(tf.key, analysis);
            console.log(`✅ ${tf.key} OK`);
          }
        } catch (err) { console.error(`❌ análise ${tf.key}:`, err.message); }
      })
    );

    for (const tfKey of SYNTHETIC_TFS) {
      const candles = candlesMap[tfKey];
      if (!candles || candles.length < 5) {
        console.log(`⚠️ ${tfKey} tem apenas ${candles?.length || 0} candles (mínimo 5)`);
        continue;
      }

      try {
        console.log(`🔄 Analisando ${tfKey} com ${candles.length} candles...`);

        let analysis = null;

        if (tfKey === 'MN1' && candles.length < 26) {
          analysis = calcularAnaliseManualMN1(candles, tipoAtivo);
          console.log(`✅ ${tfKey} (sintético) OK com análise manual (${candles.length} candles) → sinal: ${analysis.sinal} adx: ${analysis.adx.toFixed(1)}`);
        } else {
          analysis = await sistemaBase.analisar(candles, tfKey);

          if (!analysis || analysis.erro) {
            console.warn(`⚠️ ${tfKey} análise avançada falhou, usando análise manual`);
            analysis = (tfKey === 'MN1')
              ? calcularAnaliseManualMN1(candles, tipoAtivo)
              : calcularFallbackBasico(candles, tipoAtivo);
            console.log(`✅ ${tfKey} (sintético) OK com fallback`);
          } else {
            console.log(`✅ ${tfKey} (sintético) OK`);
          }
        }

        mtfManager.addAnalysis(tfKey, analysis);

      } catch (err) {
        console.error(`❌ Erro crítico ao analisar ${tfKey}:`, err.message);
        try {
          const emergencyAnalysis = (tfKey === 'MN1' && candles?.length >= 5)
            ? calcularAnaliseManualMN1(candles, tipoAtivo)
            : calcularFallbackBasico(candles, tipoAtivo);
          mtfManager.addAnalysis(tfKey, emergencyAnalysis);
          console.log(`✅ ${tfKey} adicionado com análise de emergência (${emergencyAnalysis._fonte})`);
        } catch (err2) {
          mtfManager.addAnalysis(tfKey, calcularFallbackBasico(candles, tipoAtivo));
          console.log(`✅ ${tfKey} adicionado com fallback de último recurso`);
        }
      }
    }

    let consolidated = mtfManager.consolidateSignals();
    const pontoFranco = calcularPontoFranco(mtfManager, tipoAtivo);
    if (pontoFranco) {
      consolidated.ponto_franco = pontoFranco;
      console.log(`⚡ ${pontoFranco.tipo} detectado!`);
    }
    const agreement = mtfManager.calculateAgreement();
    consolidated.tipo_ativo = tipoAtivo;

    const regimeAtual = consolidated.regime || 'UNKNOWN';
    const spikeAtivo = consolidated.spike || false;
    const squeezeAtivo = consolidated.squeeze || false;
    const confiancaRegime = consolidated.confidence;
    const preSpike = consolidated.preSpike;
    const squeezeProb = consolidated.squeezeProb;

    const demHistCandles = candlesMap[primaryTfForDem];
    if (demHistCandles && demHistCandles.length > 0) {
      demarker.seedFromHistory(demHistCandles);
    }

    const ticksState = demarker.getSignalState();
    if (ticksState && ticksState.signal !== 'SEM_DADOS') {
      demState  = ticksState;
      demSource = 'ticks';
    } else if (demHistCandles && demHistCandles.length >= 16) {
      demState  = calcularDeMarkerComHistorico(demHistCandles);
      demSource = 'historico';
    }

    if (demState) {
      demarkerInfo = {
        value:        demState.dem,
        signal:       demState.signal,
        reason:       demState.reason,
        locked:       demState.locked,
        persistCount: demState.persistCount,
        adxProxy:     demState.adxProxy,
        isTrending:   demState.isTrending,
        ema:          demState.ema,
        prevDem:      demState.prevDem
      };
      const icones = { COMPRA:'🟢', VENDA:'🔴', SOBRECOMPRA:'🟡', SOBREVENDA:'🔵', IGNORAR:'🔒', AGUARDAR:'⏳', SEM_DADOS:'⚪' };
      console.log(`${icones[demState.signal]??'❓'} DeMarker[${demSource}] ${symbol} | DeM=${demState.dem?.toFixed(4)} | Sinal=${demState.signal} | Razão=${demState.reason} | Lock=${demState.locked} | ADX≈${demState.adxProxy?.toFixed(1)}`);
    }

 // ========== FILTROS GLOBAIS (PRÉ-MOTOR) ==========
// ⭐⭐⭐ DECLARAR PRO_CONFIG AQUI (antes de ser usado nas validações)
const PRO_CONFIG = require('./config').PRO_ENGINE.MODES[mode];

let bloqueioGlobal = false;

// ⭐ PULSE ENGINE — motor dedicado para ativos de pulso (Boom, Crash, Jump, Step)
const pulseResult = pulseEngine.analyze(symbol, tipoAtivo, mode, candlesMap, mtfManager);

// Variáveis de compatibilidade (usadas mais abaixo na resposta)
// ⭐ FIX: recentPulse agora reflete SPIKE_DETECTED do pulseEngine (antes estava hardcoded null)
const recentPulse = pulseResult?.action === 'SPIKE_DETECTED' ? {
  detectado:  true,
  direcao:    pulseResult.direcaoSpike,
  label:      pulseResult.label ?? null,
  magnitude:  pulseResult.magnitude ?? null
} : null;
const exaustaoPrePulso = pulseResult?.action === 'EXHAUSTION' ? { detectado: true, nivel: pulseResult.nivel, sinais: [], mensagemCurta: pulseResult.reasons?.[0] } : null;

if (pulseResult) {
  if (pulseResult.block) {
    // BLOQUEIA: spike recente, aguardando confirmação, exaustão ALTO
    consolidated.signal     = 'HOLD';
    consolidated.confidence = 0;
    consolidated.score      = 0;
    consolidated.reasons    = pulseResult.reasons || [];
    consolidated.zona       = 'C';
    bloqueioGlobal          = true;
    console.log(`⛔ [PULSE ENGINE] Bloqueio: ${pulseResult.action}`);
  } else if (pulseResult.forceSignal && pulseResult.signal) {
    // FORÇA ENTRADA: pulo de gato confirmado
    consolidated.signal     = pulseResult.signal;
    consolidated.confidence = 0.80;
    consolidated.score      = 85;
    consolidated.reasons    = pulseResult.reasons || [];
    consolidated.zona       = 'A';
    bloqueioGlobal          = true; // salta o motor normal — sinal já está definido
    console.log(`✅ [PULSE ENGINE] Entrada forçada: ${pulseResult.signal} (pulo de gato confirmado)`);
  } else if (pulseResult.action === 'TIMEOUT') {
    // TIMEOUT: motor normal retoma, apenas adiciona nota
    console.log(`⏱️ [PULSE ENGINE] Timeout — motor normal retoma`);
  }
}
	    // EXHAUSTION MÉDIO: não bloqueia, aviso será injetado nas reasons do motor

// ⭐ NOVO: Detetar aceleração de spread
const aceleracaoSpread = detectarAceleracaoSpread(candlesMap, modeTimeframes, tipoAtivo);
if (aceleracaoSpread) {
  console.log(`${aceleracaoSpread.label}: ${aceleracaoSpread.totalTfsAcelerados}/${aceleracaoSpread.totalTfs} TFs | Impacto score: -${Math.round((1 - aceleracaoSpread.fatorImpacto) * 100)}%`);
}

const h1ADXFiltro  = getTFData('H1', mtfManager)?.adx  ?? 0;
const m15ADXFiltro = getTFData('M15', mtfManager)?.adx ?? 0;

// ⭐ FIX: ativos de pulso (Boom/Crash/Jump/Step) têm ADX naturalmente baixo entre spikes
const isAtivoPulsoFiltroADX = ['boom_index','crash_index','jump_index','step_index','criptomoeda','volatility_index'].includes(tipoAtivo);
	  
if (!isAtivoPulsoFiltroADX && mode !== 'SNIPER' && h1ADXFiltro < 15 && m15ADXFiltro < 15) {
  console.log(`⛔ Mercado lateral (ADX H1 ${h1ADXFiltro.toFixed(1)}, M15 ${m15ADXFiltro.toFixed(1)}) → HOLD`);
  consolidated.signal = 'HOLD';
  consolidated.confidence = 0;
  consolidated.score = 0;
  consolidated.reasons = [
    "😴 Mercado lateral — H1 e M15 sem tendência",
    `💪 ADX H1 (${h1ADXFiltro.toFixed(1)}) e M15 (${m15ADXFiltro.toFixed(1)}) estão fracos`,
    "💡 Aguarda que o ADX suba acima de 15 para indicar tendência"
  ];
  consolidated.zona = 'C';
  bloqueioGlobal = true;
} else if (isAtivoPulsoFiltroADX && mode !== 'SNIPER' && h1ADXFiltro < 15 && m15ADXFiltro < 15) {
  console.log(`⚠️ ADX baixo em ativo de pulso (H1 ${h1ADXFiltro.toFixed(1)}, M15 ${m15ADXFiltro.toFixed(1)}) — PulseEngine no controlo`);
}
// ⭐⭐⭐ NOVA VALIDAÇÃO MACRO (usa PRO_CONFIG para cada modo)
const macroData = getTFData(PRO_CONFIG.macroTF, mtfManager, true);
const confirmData = PRO_CONFIG.confirmTF ? getTFData(PRO_CONFIG.confirmTF, mtfManager, true) : null;
const structureDataForAlign = getTFData(PRO_CONFIG.structureTF, mtfManager, true);

const tendenciaAlinhada = confirmData 
  ? (macroData && confirmData && 
     macroData.direction === confirmData.direction && 
     macroData.direction !== 'NEUTRAL')
  : (macroData && structureDataForAlign && 
     macroData.direction === structureDataForAlign.direction && 
     macroData.direction !== 'NEUTRAL');

const macroHasConflict = macroData?.conflictReason ? true : false;
const tendenciaAssumidaPorHistograma = !tendenciaAlinhada && macroHasConflict;

// ⭐⭐⭐ Bloqueio CHOP com validação de divergência macro
if (!bloqueioGlobal && regimeAtual === 'CHOP' && confiancaRegime < 0.6) {
  const divergenciaMacroCHOP = detectarDivergenciaMacro(mtfManager, PRO_CONFIG, 'CHOP');

  if (divergenciaMacroCHOP && divergenciaMacroCHOP.bloqueia) {
    // Divergência macro em CHOP = HOLD garantido
    console.log(`⛔ ${divergenciaMacroCHOP.motivo}`);
    consolidated.signal = 'HOLD';
    consolidated.confidence = 0;
    consolidated.score = 0;
    consolidated.reasons = [
      `🔴 ${divergenciaMacroCHOP.motivo}`,
      `💡 Em CHOP com divergência macro → ruído → aguardar alinhamento`
    ];
    consolidated.zona = 'C';
    bloqueioGlobal = true;
  } else if (!tendenciaAlinhada && !tendenciaAssumidaPorHistograma) {
    console.log(`⛔ Regime CHOP com confiança muito baixa (${(confiancaRegime * 100).toFixed(0)}%) e SEM tendência alinhada → HOLD`);
    consolidated.signal = 'HOLD';
    consolidated.confidence = 0;
    consolidated.score = 0;
    consolidated.reasons = [
      "😴 Mercado lateral (CHOP) — sem tendência definida",
      "💡 Aguarda que o mercado saia da lateralização e defina uma direção clara",
      "⏳ Enquanto estiver CHOP, o motor não gera sinais de entrada"
    ];
    consolidated.zona = 'C';
    bloqueioGlobal = true;
  } else {
    // ⭐ Tendência definida (alinhada ou assumida por histograma) → NÃO BLOQUEIA
    console.log(`⚠️ Regime CHOP, mas tendência definida (alinhada ou assumida por histograma) → mantém sinal, confiança reduzida`);
  }
}
let motorScore = 0;
let motorZona = 'C';
let motorReasons = [];

if (bloqueioGlobal) {
  // HOLD já definido pelos filtros globais acima — motor não é executado
} else if (!PRO_CONFIG) {
  console.log(`⛔ Configuração PRO não encontrada para o modo ${mode}`);
  consolidated.signal = 'HOLD';
  consolidated.confidence = 0;
  consolidated.score = 0;
  consolidated.reasons = ["⛔ Configuração PRO não encontrada"];
  consolidated.zona = 'C';
} else {

  const trendState = getTrendState(mtfManager, PRO_CONFIG);
  const structureState = getStructureState(trendState.direction, mtfManager, PRO_CONFIG);
	const entryState = getEntryTrigger(trendState.direction, mtfManager, PRO_CONFIG, demarkerInfo, tipoAtivo);
	
  // ⭐⭐⭐ VALIDAÇÃO DE DIVERGÊNCIA MACRO (antes de resolver o sinal)
  const divergenciaMacro = detectarDivergenciaMacro(mtfManager, PRO_CONFIG, regimeAtual);
  if (divergenciaMacro && divergenciaMacro.bloqueia && !bloqueioGlobal) {
    console.log(`⛔ [MACRO DIVERGENCE] ${divergenciaMacro.motivo}`);
    bloqueioGlobal = true;
    consolidated.signal = 'HOLD';
    consolidated.confidence = 0;
    consolidated.score = 0;
    consolidated.reasons = [`🔴 ${divergenciaMacro.motivo}`];
    consolidated.zona = divergenciaMacro.zona || 'C';
  }

  const resolved = resolveSignal(trendState, structureState, entryState, mode);

  // ⭐⭐⭐ NOVO: MICRO TIMING OBRIGATÓRIO ⭐⭐⭐
  // CAÇADOR: M1 confirma M5 | PESCADOR: M5 confirma M15 | BALEEIRO: M5 confirma M15
  let microTiming = { ok: true, reason: 'Não aplicável (modo sem micro timing)', bonus: 0 };
  if (PRO_CONFIG.microTF) {
    microTiming = getMicroTiming(
      trendState.direction,
      mtfManager,
      PRO_CONFIG.microTF,
      PRO_CONFIG.microMinADX || 15,
      PRO_CONFIG.microMinRSI_CALL || 45,
      PRO_CONFIG.microMinRSI_PUT || 55
    );

    if (!microTiming.ok) {
      console.log(`⛔ [MICRO TIMING] ${PRO_CONFIG.microTF} BLOQUEOU entrada: ${microTiming.reason}`);
      
      // ⭐⭐⭐ Calcular score de prontidão (não deixar a 0)
      let scoreProntidao = 0;
      let corProntidao = 'C';
      
      if (trendState.aligned && trendState.direction !== 'NEUTRAL') {
        const trendStrengthScore = trendState.strength >= 3 ? 25 : trendState.strength >= 2 ? 20 : 15;
        const structureBonus = structureState.active ? 10 : 0;
        const triggerTFKey = PRO_CONFIG.triggerTF || 'M5';
        const triggerData = getTFData(triggerTFKey, mtfManager);
        let triggerBonus = 0;
        if (triggerData && triggerData.conflictReason) triggerBonus = 10;
        if (entryState.ok) triggerBonus += 15;
        
        scoreProntidao = trendStrengthScore + structureBonus + triggerBonus;
        
        if (scoreProntidao >= 35) corProntidao = 'B';
        else if (scoreProntidao >= 20) corProntidao = 'C';
      } else if (trendState.direction !== 'NEUTRAL') {
        // Trend definida pelo fallback (não alinhada mas com direção)
        scoreProntidao = 25;
        if (entryState.ok) scoreProntidao += 15;
        corProntidao = scoreProntidao >= 35 ? 'B' : 'C';
      }
      
      consolidated.signal = 'HOLD';
      consolidated.confidence = scoreProntidao > 0 ? Math.min(0.40, scoreProntidao / 100) : 0;
      consolidated.score = scoreProntidao;
      motorZona = corProntidao;
      motorReasons.push(`⛔ Micro timing ${PRO_CONFIG.microTF}: ${microTiming.reason}`);
      if (scoreProntidao > 0) {
        motorReasons.push(`🟡 Score de prontidão: ${scoreProntidao}/100 — micro timing bloqueou mas tendência e entrada estão prontas`);
      }
      consolidated.reasons = motorReasons;
      consolidated.zona = corProntidao;
      bloqueioGlobal = true;
    } else {
      console.log(`✅ [MICRO TIMING] ${PRO_CONFIG.microTF} CONFIRMA: ${microTiming.reason}`);
    }
  }

  if (resolved.signal === 'HOLD' || bloqueioGlobal) {
    console.log(`⛔ Motor 3 camadas HOLD: Trend=${trendState.direction}(${trendState.macroTF}+${trendState.momentumTF}), Structure=${structureState.type}(${structureState.structureTF}), Entry=${entryState.reason}`);
    // ⭐⭐⭐ NOVAS MENSAGENS HUMANAS ⭐⭐⭐
    
       // 1. Trend (tendência de fundo)
    if (trendState.direction === 'NEUTRAL') {
      motorReasons.push(`🧭 ${trendState.reason}`);
    } else if (trendState.aligned) {
      const dirTexto = trendState.direction === 'UP' ? 'ALTA' : 'DOWN';
      motorReasons.push(`🧭 Tendência de fundo: ${dirTexto} (${trendState.macroTF}+${trendState.momentumTF} alinhados)`);
    } else if (trendState.direction !== 'NEUTRAL') {
      const dirTexto = trendState.direction === 'UP' ? 'ALTA' : 'DOWN';
      motorReasons.push(`🧭 Tendência assumida: ${dirTexto} (histograma ${trendState.macroTF} — ${trendState.macroTF}+${trendState.momentumTF} desalinhados)`);
    } else {
      motorReasons.push(`🧭 Tendência indefinida: ${trendState.macroTF} e ${trendState.momentumTF} não estão alinhados — mercado sem direção clara`);
    }
       // 2. Structure (pullback ou continuação)
    if (structureState.type === 'PULLBACK') {
      motorReasons.push(`🔄 ${structureState.structureTF} está em PULLBACK — o preço está a corrigir, aguarda o fim da correção`);
    } else if (structureState.type === 'CONTINUATION') {
      motorReasons.push(`📈 ${structureState.structureTF} está em CONTINUAÇÃO — a tendência mantém-se`);
    } else if (structureState.type === 'WEAK_CONTINUATION') {
      motorReasons.push(`⚠️ ${structureState.structureTF} está em CONTINUAÇÃO FRACA — tendência a perder força`);
    } else if (structureState.type === 'TREND_NEUTRAL_BUT_PUT') {
      motorReasons.push(`⚠️ ${structureState.structureTF} está PUT (🔥 BAIXA) mas Trend NEUTRAL — ${structureState.structureTF} está em baixa, mas os TFs maiores não alinham`);
    } else if (structureState.type === 'TREND_NEUTRAL_BUT_CALL') {
      motorReasons.push(`⚠️ ${structureState.structureTF} está CALL (🚀 ALTA) mas Trend NEUTRAL — ${structureState.structureTF} está em alta, mas os TFs maiores não alinham`);
    } else {
      motorReasons.push(`⏳ ${structureState.structureTF} está NEUTRO — sem estrutura definida para entrada`);
    }

    // 3. Entry (gatilho)
    if (!entryState.ok) {
      if (entryState.reason.includes('ADX')) {
        motorReasons.push(`💪 ${entryState.triggerTF} está sem força (ADX baixo) — o mercado não tem momento suficiente para entrar`);
      } else if (entryState.reason.includes('zona morta')) {
        motorReasons.push(`😴 ${entryState.triggerTF} está em zona morta — sem movimento, espera o mercado acordar`);
      } else if (entryState.reason.includes('sem condições')) {
        motorReasons.push(`⏰ ${entryState.triggerTF} ainda não deu o sinal de entrada — espera o momento certo`);
        
        const triggerTFKey = PRO_CONFIG.triggerTF || 'M5';
        const triggerData = getTFData(triggerTFKey, mtfManager);
        if (triggerData && triggerData.conflictReason) {
          const dirTendencia = trendState.direction === 'UP' ? 'CALL' : 'PUT';
          const dirOposta = trendState.direction === 'UP' ? 'PUT' : 'CALL';
          const dirOpostaTexto = dirOposta === 'CALL' ? 'ALTA' : 'BAIXA';
          
          motorReasons.push(`⏰ ${triggerTFKey} está ${dirOpostaTexto} PERDENDO FORÇA — aguarda cruzamento para ${dirTendencia} (iminente)`);
        }
      } else {
        motorReasons.push(`⏰ ${entryState.triggerTF}: ${entryState.reason}`);
      }
    }

    // 4. Micro timing (se bloqueou)
    if (microTiming && !microTiming.ok && PRO_CONFIG.microTF) {
      if (microTiming.reason.includes('ADX insuficiente')) {
        motorReasons.push(`🔬 ${PRO_CONFIG.microTF} (micro timing) está fraco — o TF mais rápido não tem força para confirmar`);
      } else if (microTiming.reason.includes('contra tendência')) {
        const dirTendencia = trendState.direction === 'UP' ? 'ALTA' : 'BAIXA';
        motorReasons.push(`🔬 ${PRO_CONFIG.microTF} (micro timing) está contra a tendência de ${dirTendencia} — possível armadilha, espera alinhar`);
      } else if (microTiming.reason.includes('Sem dados')) {
        motorReasons.push(`🔬 ${PRO_CONFIG.microTF} (micro timing) sem dados — a verificar TF mais rápido`);
      } else {
        motorReasons.push(`🔬 ${PRO_CONFIG.microTF} (micro timing): ${microTiming.reason}`);
      }
    }

    // 5. Resumo final
    if (trendState.direction === 'UP') {
      motorReasons.push(`💡 Para entrar CALL: espera o ${PRO_CONFIG.triggerTF} fazer um PULLBACK (correção) e depois dar sinal de compra`);
    } else if (trendState.direction === 'DOWN') {
      motorReasons.push(`💡 Para entrar PUT: espera o ${PRO_CONFIG.triggerTF} fazer um PULLBACK (correção) e depois dar sinal de venda`);
    } else {
      motorReasons.push(`💡 Aguarda que os timeframes maiores definam uma tendência clara`);
    }

    // 6. DeMarker (se estiver em zona de perigo)
    if (demarkerInfo.value > 0.70) {
      motorReasons.push(`📐 DeMarker em SOBRECOMPRA (${demarkerInfo.value.toFixed(2)}) — mercado esticado, risco de queda`);
    } else if (demarkerInfo.value < 0.30) {
      motorReasons.push(`📐 DeMarker em SOBREVENDA (${demarkerInfo.value.toFixed(2)}) — mercado esticado, risco de subida`);
    }

    // ⭐⭐⭐ Score de prontidão quando tendência alinhada mas trigger não confirma
    let scoreProntidao = 0;
    let corProntidao = 'C';
    
    if (trendState.aligned && trendState.direction !== 'NEUTRAL') {
      const trendStrengthScore = trendState.strength >= 3 ? 25 : trendState.strength >= 2 ? 20 : 15;
      const structureBonus = structureState.active ? 10 : 0;
      
      const triggerTFKey = PRO_CONFIG.triggerTF || 'M5';
      const triggerData = getTFData(triggerTFKey, mtfManager);
      let triggerBonus = 0;
      if (triggerData && triggerData.conflictReason) {
        triggerBonus = 10;
      }
      
      scoreProntidao = trendStrengthScore + structureBonus + triggerBonus;
      
     
      if (scoreProntidao >= 35) {
  corProntidao = 'B';
  motorReasons.push(`🟡 Score de prontidão: ${scoreProntidao}/100 (mín. prontidão: 35) — tendência definida, aguarda confirmação do ${triggerTFKey}`);
} else if (scoreProntidao >= 20) {
        corProntidao = 'C';
        motorReasons.push(`🔵 Tendência definida (${scoreProntidao}/100) — ${triggerTFKey} ainda não mostra sinais de entrada`);
      }
      
      motorScore = scoreProntidao;
      motorZona = corProntidao;
    }

    // ⭐ FIX: Exaustão BAIXO também aparece nas reasons
    if (exaustaoPrePulso && exaustaoPrePulso.detectado) {
      if (exaustaoPrePulso.nivel === 'MÉDIO') {
        motorReasons.push(`⚠️ ${exaustaoPrePulso.mensagemCurta}`);
      } else if (exaustaoPrePulso.nivel === 'BAIXO') {
        motorReasons.push(`💡 Sinais iniciais de exaustão (nível BAIXO) — possível spike próximo, observa`);
      }
    }

    consolidated.signal = 'HOLD';
    consolidated.confidence = scoreProntidao > 0 ? Math.min(0.40, scoreProntidao / 100) : 0;
    consolidated.score = scoreProntidao;  // ⭐ CORRIGIDO: motorScore → scoreProntidao
    consolidated.reasons = motorReasons;
    consolidated.zona = corProntidao;     // ⭐ CORRIGIDO: motorZona → corProntidao
  } else {
    motorScore = 45 * (trendState.strength / 4)
              + 25 * (structureState.active ? 1 : 0)
              + 20 * (entryState.ok ? 1 : 0)
              + 10 * (regimeAtual === 'TREND' ? 1 : regimeAtual === 'SPIKE' ? 0.5 : 0);

    const emaMacdBonus = (() => {
      let bonus = 0;
      const trendM5 = trendDirection(candlesMap['M5']);
      if (trendM5 === trendState.direction) bonus += 5;
      const trendM15 = trendDirection(candlesMap['M15']);
      if (trendM15 === trendState.direction) bonus += 5;
      const triggerTF = PRO_CONFIG.triggerTF;
      const triggerCandles = candlesMap[triggerTF];
      if (triggerCandles && triggerCandles.length >= 2) {
        const macdTrigger = calcularMACD(triggerCandles.map(c => parseFloat(c.close)));
        if (macdTrigger?.valido) {
          if (macdTrigger.histograma > 0.001 && trendState.direction === 'UP') bonus += 5;
          if (macdTrigger.histograma < -0.001 && trendState.direction === 'DOWN') bonus += 5;
        }
      }
      return bonus;
    })();

	      motorScore += emaMacdBonus;
    // ⭐ NOVO: bónus do micro timing
    motorScore += microTiming.bonus || 0;
    if (microTiming.bonus && microTiming.ok) {
      motorReasons.push(`🔹 Micro timing (${PRO_CONFIG.microTF}) confirma: +${microTiming.bonus}pts`);
    }

    const regimeMult = regimeScoreMultiplier(regimeAtual);
	  
motorScore = Math.round(motorScore * regimeMult);

    // ⭐⭐⭐ Penalização por aceleração de spread
    if (aceleracaoSpread && consolidated.signal !== 'HOLD') {
      const scoreAntes = motorScore;
      motorScore = Math.round(motorScore * aceleracaoSpread.fatorImpacto);
      if (aceleracaoSpread.nivel === 'EXTREMA') {
        motorReasons.push(`🚨 Aceleração extrema em ${aceleracaoSpread.totalTfsAcelerados} TFs — score: ${scoreAntes} → ${motorScore} (-${Math.round((1 - aceleracaoSpread.fatorImpacto) * 100)}%)`);
      } else if (aceleracaoSpread.nivel === 'ALTA') {
        motorReasons.push(`⚡ Aceleração alta em ${aceleracaoSpread.totalTfsAcelerados} TFs — score: ${scoreAntes} → ${motorScore} (-${Math.round((1 - aceleracaoSpread.fatorImpacto) * 100)}%)`);
      } else if (aceleracaoSpread.nivel === 'MÉDIA') {
        motorReasons.push(`📈 Aceleração média em ${aceleracaoSpread.totalTfsAcelerados} TFs — score: ${scoreAntes} → ${motorScore}`);
      }
      console.log(`📊 Spread acelerado (${aceleracaoSpread.nivel}): score ${scoreAntes} → ${motorScore} | TFs: ${aceleracaoSpread.tfsAcelerados.map(t => t.tf).join(',')}`);
    }
	  
    let ZONA_A, ZONA_B;
    switch (mode) {
      case 'SNIPER':   ZONA_A = 55; ZONA_B = 45; break;
      case 'CAÇADOR':  ZONA_A = 60; ZONA_B = 50; break;
      case 'PESCADOR': ZONA_A = 65; ZONA_B = 55; break;
      case 'BALEEIRO': ZONA_A = 70; ZONA_B = 60; break;
      default:         ZONA_A = 60; ZONA_B = 50;
    }

    if (spikeAtivo) {
      if (mode !== 'SNIPER') { ZONA_A += 10; ZONA_B += 10; }
      else { ZONA_A = 65; }
    }

    if (motorScore >= ZONA_A) motorZona = 'A';
    else if (motorScore >= ZONA_B) motorZona = 'B';
    else motorZona = 'C';

    if (motorZona === 'C') {
      console.log(`⛔ Score ${motorScore} (zona C) → HOLD`);
      consolidated.signal = 'HOLD';
      consolidated.confidence = 0;
      consolidated.score = motorScore;
      consolidated.reasons = motorReasons;
      consolidated.zona = motorZona;
    } else {
      console.log(`✅ Motor 3 camadas: ${resolved.signal} (score ${motorScore}, zona ${motorZona}) | TFs: ${trendState.macroTF}+${trendState.momentumTF}→${structureState.structureTF}→${entryState.triggerTF}`);
      consolidated.signal = resolved.signal;
      consolidated.confidence = Math.min(0.99, motorScore / 100);

      motorReasons.push(`📊 Regime: ${regimeAtual} | Trend: ${trendState.direction} [${trendState.macroTF}+${trendState.momentumTF}] | Structure: ${structureState.type} [${structureState.structureTF}] | Entry: ${entryState.reason} [${entryState.triggerTF}]`);
      motorReasons.push((motorZona === 'B' ? "⚠️ Entrada moderada" : "✅ Entrada forte") + ` | Score: ${motorScore} | Zona: ${motorZona}`);
      if (emaMacdBonus) motorReasons.push(`🔹 Bónus EMA/MACD: +${emaMacdBonus}pts`);

      // ⭐ Injetar aviso de exaustão nas reasons do sinal (MÉDIO e BAIXO)
      if (exaustaoPrePulso && exaustaoPrePulso.detectado) {
        if (exaustaoPrePulso.nivel === 'MÉDIO') {
          motorReasons.push(exaustaoPrePulso.mensagemCurta);
          motorReasons.push(`   • ${exaustaoPrePulso.sinais.join(' | ')}`);
        } else if (exaustaoPrePulso.nivel === 'BAIXO') {
          motorReasons.push(`⚡ Exaustão Pré-Pulso (BAIXO) detectada — possível spike próximo, observa`);
          if (exaustaoPrePulso.mensagemCurta) motorReasons.push(`💡 ${exaustaoPrePulso.mensagemCurta}`);
        }
      }

      consolidated.score = motorScore;
      consolidated.reasons = motorReasons;
      consolidated.zona = motorZona;
    }
  }
}
    const PRIMARY_TF_MAP = { 'SNIPER': 'M1', 'CAÇADOR': 'M5', 'PESCADOR': 'M15', 'BALEEIRO': 'H1' };
    const primaryTf = PRIMARY_TF_MAP[mode] || 'M1';
    const primaryCandles = candlesMap[primaryTf];

    const currentOpenCandle = primaryCandles?.at(-1);
    const candleOpenPrice   = currentOpenCandle?.open ?? null;
    const primaryOpenTf     = primaryTf;

    if (!currentPrice) {
      for (const tf of [primaryTf, 'M1', 'M5', 'M15', 'H1', 'H4', 'H24', 'W1', 'MN1']) {
        const p = mtfManager.timeframes[tf]?.analysis?.preco_atual;
        if (p) { currentPrice = p; priceSource = `fallback_${tf}`; break; }
      }
      if (!currentPrice) {
        try {
          const freshM1 = await client.getCandles(symbol, 1, 60);
          if (freshM1 && freshM1.length > 0) {
            currentPrice = parseFloat(freshM1[freshM1.length - 1].close);
            priceSource  = 'fallback_freshM1';
            console.log(`⚠️ Tick falhou, usando último M1 fechado: ${currentPrice}`);
          }
        } catch (err) { console.error('❌ Fallback M1 falhou:', err.message); }
      }
      if (!currentPrice && candleOpenPrice) {
        currentPrice = candleOpenPrice;
        priceSource  = 'fallback_open';
      }
    }

    const priceMovedFromOpen = (candleOpenPrice && currentPrice)
      ? parseFloat((currentPrice - candleOpenPrice).toFixed(5))
      : null;
    const priceMovedDirection = priceMovedFromOpen !== null
      ? (priceMovedFromOpen > 0 ? 'SUBIU' : priceMovedFromOpen < 0 ? 'CAIU' : 'LATERAL')
      : null;

    console.log(`🕯️  Open ${primaryTf}: ${candleOpenPrice} | 💰 Atual: ${currentPrice} | ${priceMovedDirection} ${priceMovedFromOpen}`);

    let primaryTrendNote = null;
    if (consolidated.signal === 'HOLD') {
      let tfKey = primaryTrendTf || { 'SNIPER': 'H1', 'CAÇADOR': 'H4', 'PESCADOR': 'H4', 'BALEEIRO': 'H4' }[mode];
      const analysis = mtfManager.timeframes[tfKey]?.analysis;
      if (analysis) {
        if (analysis.sinal === 'CALL') {
          primaryTrendNote = `Tendência primária (${tfKey}): ALTA. Pullback nos TFs menores é entrada a favor.`;
        } else if (analysis.sinal === 'PUT') {
          primaryTrendNote = `Tendência primária (${tfKey}): BAIXA. Pullback nos TFs menores é entrada a favor.`;
        } else if (analysis.sinal !== 'HOLD') {
          const dirTexto = analysis.sinal === 'CALL' ? 'ALTA' : 'BAIXA';
          primaryTrendNote = `Tendência primária (${tfKey}): ${dirTexto}. Aguarde pullback.`;
        }
      }
    }

    const suggestion = BotExecutionCore.generateEntrySuggestion(
      { sinal: consolidated.signal, probabilidade: consolidated.confidence }, currentPrice,
      null,
      (consolidated.reasons && consolidated.reasons.length > 0) ? consolidated.reasons : (motorReasons || [])
    );

	const primarySignal = consolidated.simpleMajority?.signal || consolidated.signal || 'HOLD';
    const analiseRefinadaPromise = (async () => {
      try {
        const modeMap = { 'SNIPER': 'SNIPER', 'CAÇADOR': 'CACADOR', 'PESCADOR': 'PESCADOR', 'BALEEIRO': 'BALEEIRO' };
        const dadosMercado = {
          ativo: symbol, precoAtual: currentPrice, volume: 0,
          precosHistoricos: historicalCandles || [], timeframes: {}
        };
        for (const tfKey of modeTimeframes) {
          const a = mtfManager.timeframes[tfKey]?.analysis;
          const prevHist = a?.macd_phase?.prev_histogram ?? null;
          if (a) dadosMercado.timeframes[tfKey] = {
            adx: a.adx || 25, rsi: a.rsi || 50, tendencia: a.sinal || 'HOLD',
            volatilidade: a.volatilidade || 1.0, precoAtual: a.preco_atual || currentPrice, precos: []
          };
        }
        const bot    = new TraderBotAnalise({ confiancaMinimaOperar: 60, confiancaAlta: 75, adxTendenciaForte: 25, adxSemTendencia: 20 });
        const analise = bot.gerarAnalise(dadosMercado, modeMap[mode] || 'CACADOR');
        const risco   = bot.validarOperacao(analise, req.user?.saldo || 1000, 2);
        const direcao   = analise?.sinal?.direcao   ?? 'N/A';
        const confianca = analise?.sinal?.confianca ?? 0;
        console.log(`📊 Refinada: ${direcao} ${confianca}%`);
        return { analiseRefinada: analise, validacaoRisco: risco };
      } catch (err) {
        console.error('❌ analiseRefinada:', err.message);
        return { analiseRefinada: { erro: err.message }, validacaoRisco: null };
      }
    })();

    let m1Timing = null, m5Timing = null, m15Timing = null, h1Timing = null;
    if (modeTimeframes.includes('M1'))  m1Timing  = calcularTimingM1(mtfManager.timeframes['M1']?.analysis,  primarySignal, mode);
    if (modeTimeframes.includes('M5'))  m5Timing  = calcularTimingM5(mtfManager.timeframes['M5']?.analysis,  primarySignal, mode);
    if (modeTimeframes.includes('M15')) m15Timing = calcularTimingM15(mtfManager.timeframes['M15']?.analysis, primarySignal, mode);
    if (modeTimeframes.includes('H1'))  h1Timing  = calcularTimingH1(mtfManager.timeframes['H1']?.analysis,  primarySignal, mode);

    let timingEspecial = null;
    if (mtfManager.tipoAtivo !== 'DEFAULT') {
      const m1a = mtfManager.timeframes['M1']?.analysis;
      if (m1a && typeof mtfManager.calcularTimingEspecial === 'function')
        timingEspecial = mtfManager.calcularTimingEspecial('M1', m1a);
    }

       let timingRiskWarning = null;
    if (consolidated.signal !== 'HOLD') {
      const modeTimingMap = { 'SNIPER': m1Timing, 'CAÇADOR': m5Timing, 'PESCADOR': m15Timing, 'BALEEIRO': h1Timing };
      const primaryTiming = modeTimingMap[mode];
      if (primaryTiming && !primaryTiming.permitido) {
        timingRiskWarning = `⛔ ENTRADA DE RISCO — timing do ${primaryTf} não confirma`;
      }
    }

    let liquidityResult = { sweepDetected: false };
    try {
      const analysisMap = {};
      for (const tfKey of modeTimeframes) {
        const a = mtfManager.timeframes[tfKey]?.analysis;
        if (a) analysisMap[tfKey] = a;
      }
      liquidityResult = detectLiquiditySweepRobusto({
        mode, currentPrice, candlesMap, analysisMap,
        atrValue: historicalCandles ? calcularATRLiquidity(historicalCandles, 14) : null
      });
      console.log(`💧 ${liquidityResult.sweepDetected ? `SWEEP ${liquidityResult.direction} ${liquidityResult.confidence}%` : 'sem sweep'}`);
    } catch (err) { console.error('❌ liquidez:', err.message); }

    // ⭐⭐⭐ BÓNUS DE LIQUIDEZ (ADICIONADO AQUI - depois do liquidityResult) ⭐⭐⭐
    if (consolidated.signal !== 'HOLD' && liquidityResult.sweepDetected && liquidityResult.confidence >= 80) {
      const bonusLiquidez = 10;
      motorScore += bonusLiquidez;
      motorReasons.push(`💧 Bónus liquidez: +${bonusLiquidez}pts (${liquidityResult.direction} ${liquidityResult.confidence.toFixed(0)}%)`);
      consolidated.score = motorScore;
    }

    const isAtivoPulso = ['boom_index','crash_index','jump_index','step_index'].includes(tipoAtivo);
    const hasTfDivergenceForLiquidity = false;
    let timingOk = false;
    if (mode === 'SNIPER'   && m1Timing?.permitido)  timingOk = true;
    if (mode === 'CAÇADOR'  && m5Timing?.permitido)  timingOk = true;
    if (mode === 'PESCADOR' && m15Timing?.permitido) timingOk = true;
    if (mode === 'BALEEIRO' && h1Timing?.permitido)  timingOk = true;

      // ✅ NOVO: Liquidez é apenas informativa — nunca substitui o sinal
if (liquidityResult.sweepDetected) {
    console.log(`💧 Liquidez detectada (${liquidityResult.direction} ${liquidityResult.confidence.toFixed(0)}%) — informativo apenas`);
}

       const modeTiming = (() => {
      if (mode === 'SNIPER')   return m1Timing;
      if (mode === 'CAÇADOR')  return m5Timing;
      if (mode === 'PESCADOR') return m15Timing;
      if (mode === 'BALEEIRO') return h1Timing;
      return null;
    })();
	  
      // ⭐⭐⭐ Anular sinal se timing primário não confirma ⭐⭐⭐
    // ⭐ NOVO: Para ativos de pulso, NÃO anula se o score for alto (Zona A)
    const isAtivoPulsoAnular = ['boom_index','crash_index','jump_index','step_index'].includes(tipoAtivo);
    const manterSinalPulso = isAtivoPulsoAnular && motorZona === 'A' && motorScore >= 100;
    
        if (consolidated.signal !== 'HOLD' && modeTiming && !modeTiming.permitido && !manterSinalPulso) {
      console.log(`⛔ Timing primário (${PRO_CONFIG.triggerTF}) NÃO OK — anulando sinal ${consolidated.signal}`);
      consolidated.signal = 'HOLD';
      
      // ⭐⭐⭐ Mostra score de prontidão em vez de 0%
      const scoreAnulado = Math.round(motorScore * 0.7); // 70% do score original
      consolidated.confidence = Math.min(0.35, scoreAnulado / 100);
      consolidated.score = scoreAnulado;
      motorZona = scoreAnulado >= 35 ? 'B' : 'C';
      
      motorReasons.push(`⛔ Timing do ${PRO_CONFIG.triggerTF} não confirma — sinal anulado`);
      motorReasons.push(`🟡 Score de prontidão: ${scoreAnulado}/100 — tendência definida, aguarda confirmação do ${PRO_CONFIG.triggerTF}`);
      if (modeTiming.motivo) {
        motorReasons.push(`📋 Motivo: ${modeTiming.motivo}`);
      }
      consolidated.reasons = motorReasons;
      consolidated.zona = motorZona;
       } else if (consolidated.signal !== 'HOLD' && modeTiming && !modeTiming.permitido && manterSinalPulso && !bloqueioGlobal) {
      // ⭐ Ativo de pulso com score alto — mantém o sinal (só se não foi bloqueado pelo micro timing)
      console.log(`⚠️ Timing ${PRO_CONFIG.triggerTF} não perfeito mas score alto (${motorScore}) em ativo de pulso — mantendo sinal`);
      motorReasons.push(`⚠️ Timing do ${PRO_CONFIG.triggerTF} não perfeito, mas score elevado (${motorScore}pts) em ativo de pulso`);
      motorReasons.push(`💡 O RSI pode ir mais baixo em Boom/Crash — mantém STOP apertado`);
    } else if (consolidated.signal !== 'HOLD' && modeTiming && !modeTiming.permitido && manterSinalPulso && bloqueioGlobal) {
      // ⭐ Micro timing bloqueou — NÃO mantém o sinal
      console.log(`⛔ Micro timing bloqueou — ignorando exceção de ativo de pulso`);
    }
    // ⭐⭐⭐ FIM DA VERIFICAÇÃO ⭐⭐⭐
    const stopTakeLevels = calcularStopTakePorModo(candlesMap, mode, modeTiming, tipoAtivo);
    const { analiseRefinada, validacaoRisco } = await analiseRefinadaPromise;

    const responseTimeframes = {};
    modeTimeframes.forEach(tfKey => {
      const d = mtfManager.timeframes[tfKey];
      if (d?.analysis) responseTimeframes[tfKey] = {
        sinal: d.analysis.sinal, probabilidade: d.analysis.probabilidade,
        adx: d.analysis.adx, rsi: d.analysis.rsi, preco_atual: d.analysis.preco_atual,
        macd_phase: d.analysis.macd_phase, divergencia_macd: d.analysis.divergencia_macd,
        _fonte: d.analysis._fonte || 'sistema'
      };
    });

    const responseTime = Date.now() - startTime;
    console.log(`✅ ${responseTime}ms | ${mode} | ${tipoAtivo} | ${agreement.totalTimeframes} TFs`);

    const alertasEntrada = [];
    for (const tfKey of modeTimeframes) {
      const anal = mtfManager.timeframes[tfKey]?.analysis;
      if (!anal) continue;

      const fase  = anal.macd_phase?.name || '';
      const adx   = anal.adx   ?? 0;
      const rsi   = anal.rsi   ?? 50;
      const sinal = anal.sinal || 'HOLD';

      if (/PERDENDO\s*FOR[ÇC]A/i.test(fase) || /weak/i.test(fase)) {
        alertasEntrada.push(`${tfKey} ${fase} – possível reversão iminente`);
      }

      const tfGatilho = { SNIPER: 'M1', 'CAÇADOR': 'M5', PESCADOR: 'M15', BALEEIRO: 'H1' }[mode];
      if (tfKey === tfGatilho) {
        const contraSignal = (consolidated.signal === 'PUT' && sinal === 'CALL') ||
                             (consolidated.signal === 'CALL' && sinal === 'PUT');
        if (contraSignal) {
          alertasEntrada.push(`${tfKey} em pullback – aguardar reversão`);
        }
      }

      if (tfKey === tfGatilho && adx < 20 && consolidated.signal !== 'HOLD') {
        alertasEntrada.push(`${tfKey} com ADX ${adx.toFixed(1)} (fraco) — tendência sem força no gatilho`);
      }

      if (tfKey === tfGatilho) {
        if (consolidated.signal === 'PUT'  && rsi < 32) alertasEntrada.push(`${tfKey} RSI ${rsi.toFixed(1)} próximo de sobrevenda — risco de pullback`);
        if (consolidated.signal === 'CALL' && rsi > 68) alertasEntrada.push(`${tfKey} RSI ${rsi.toFixed(1)} próximo de sobrecompra — risco de pullback`);
      }
    }
    if (demState?.locked && demState?.reason && consolidated.signal !== 'HOLD') {
      const contraLock =
        (demState.reason === 'trend_lock_alta'  && consolidated.signal === 'PUT') ||
        (demState.reason === 'trend_lock_baixa' && consolidated.signal === 'CALL');
      if (contraLock) {
        alertasEntrada.push(`DeMarker em ${demState.reason} — sinal contra a tendência de fundo`);
      }
    }

    if (timingRiskWarning) {
      alertasEntrada.push(timingRiskWarning.replace('⛔ ', ''));
    }

    if (liquidityResult.sweepDetected && !isAtivoPulso) {
      alertasEntrada.push(`Sweep de liquidez detectado (${liquidityResult.direction} ${liquidityResult.confidence.toFixed(0)}%) — entrada pode ser por reversão de liquidez`);
    }

    let positionSizeMultiplier = 1.0;
    if (consolidated.signal !== 'HOLD') {
      if (consolidated.confidence >= 0.70) positionSizeMultiplier = 1.0;
      else if (consolidated.confidence >= 0.55) positionSizeMultiplier = 0.5;
      else positionSizeMultiplier = 0;
    } else {
      positionSizeMultiplier = 0;
    }

    let demarkerLockApplied  = false;
    let demarkerBonusApplied = false;

    if (consolidated.signal !== 'HOLD' && demarkerInfo.locked) {
      const prev = consolidated.confidence;
      consolidated.confidence = Math.min(consolidated.confidence, 0.45);
      demarkerLockApplied = true;
      motorReasons.push(`🔒 DeMarker Lock ativo (${demarkerInfo.value?.toFixed(4) ?? '--'}) — confiança reduzida para ${(consolidated.confidence * 100).toFixed(1)}%`);
      console.log(`🔒 DeMarker lock — confiança ${(prev * 100).toFixed(1)}% → ${(consolidated.confidence * 100).toFixed(1)}%`);
    }

       const demExitBonus =
      (consolidated.signal === 'CALL' && demState?.reason === 'exit_oversold') ||
      (consolidated.signal === 'PUT'  && demState?.reason === 'exit_overbought');
    if (demExitBonus && consolidated.confidence < 0.99) {
      consolidated.confidence = Math.min(consolidated.confidence + 0.05, 0.99);
      demarkerBonusApplied = true;
      motorReasons.push(`🟢 DeMarker bónus: cruzamento de saída (${demState?.reason}) confirmou o sinal (+5% confiança)`);
      console.log(`🟢 DeMarker bônus cruzamento saída (+5%) — sinal: ${consolidated.signal} reason: ${demState.reason}`);
    }

    // ⭐ Sempre mostrar estado do DeMarker nas Razões (quando não há mensagem de lock/bonus já adicionada)
    if (!demarkerLockApplied && !demarkerBonusApplied &&
        demarkerInfo && demarkerInfo.value !== null && demarkerInfo.signal !== 'SEM_DADOS') {
      const demEmojis = { 'COMPRA': '🟢', 'VENDA': '🔴', 'SOBRECOMPRA': '🔴', 'SOBREVENDA': '🟢', 'AGUARDAR': '⏳' };
      const demEmoji = demarkerInfo.locked ? '🔒' : (demEmojis[demarkerInfo.signal] || '📡');
      const demReasonPT = {
        'exit_oversold':    'Saída sobrevenda ↑',
        'exit_overbought':  'Saída sobrecompra ↓',
        'trend_lock_alta':  'Lock: tendência alta',
        'trend_lock_baixa': 'Lock: tendência baixa',
        'overbought':       'Sobrecompra',
        'oversold':         'Sobrevenda',
        'neutral':          'Zona neutra',
      };
      const demReasonText = demReasonPT[demState?.reason] || demState?.reason || demarkerInfo.signal;
      motorReasons.push(`${demEmoji} DeMarker ${demarkerInfo.signal} 📡 DeM=${demarkerInfo.value.toFixed(4)} | ${demReasonText}`);
    }

        // ⭐⭐⭐ NOVO: VERIFICAÇÃO DE RSI EXTREMO PARA OS 4 MODOS ⭐⭐⭐
        
    const ALERTA_RSI_EXTREMO = [];
    let fatorRsiRisco = 1.0;

    // ⭐ Define thresholds fora do loop para usar no DeMarker também
    const isPulsoRSI = ['boom_index','crash_index','jump_index','step_index'].includes(tipoAtivo);
    
    // Thresholds de DeMarker (definidos aqui para estarem disponíveis fora do loop)
    const demSobrevenda  = isPulsoRSI ? 0.05 : 0.30;
    const demSobrecompra = isPulsoRSI ? 0.95 : 0.70;

    if (consolidated.signal !== 'HOLD') {
      for (const tfKey of modeTimeframes) {
        const anal = mtfManager.timeframes[tfKey]?.analysis;
        if (!anal) continue;
        const rsi = anal.rsi ?? 50;
        const adx = anal.adx ?? 0;
        
        // ⭐⭐⭐ Thresholds adaptativos para ativos de pulso ⭐⭐⭐
        
        // Thresholds de RSI
        const rsiExtremoPUT  = isPulsoRSI ? 12 : 25;
        const rsiAlertaPUT   = isPulsoRSI ? 20 : 35;
        const rsiZonaPUT     = isPulsoRSI ? 28 : 45;
        const rsiExtremoCall = isPulsoRSI ? 88 : 75;
        const rsiAlertaCall  = isPulsoRSI ? 80 : 65;
        const rsiZonaCall    = isPulsoRSI ? 72 : 55;
        
        // Penalidades (mais leves para ativos de pulso)
        const penalidadeForte = isPulsoRSI ? 0.92 : 0.85;
        const penalidadeMedia = isPulsoRSI ? 0.96 : 0.92;
        const penalidadeLeve  = isPulsoRSI ? 0.98 : 0.95;
        const penalidadeDem   = isPulsoRSI ? 0.90 : 0.80;
        const limiteMinFator  = isPulsoRSI ? 0.50 : 0.40;
        
        // ⭐ Para PUT: RSI muito baixo = risco de pullback (subida)
        if (consolidated.signal === 'PUT') {
          if (rsi < rsiExtremoPUT && adx > 25) {
            ALERTA_RSI_EXTREMO.push(`${tfKey} RSI ${rsi.toFixed(0)} (sobrevenda extrema)`);
            fatorRsiRisco *= penalidadeForte;
          } else if (rsi < rsiAlertaPUT) {
            ALERTA_RSI_EXTREMO.push(`${tfKey} RSI ${rsi.toFixed(0)} (sobrevenda)`);
            fatorRsiRisco *= penalidadeMedia;
          } else if (rsi < rsiZonaPUT) {
            ALERTA_RSI_EXTREMO.push(`${tfKey} RSI ${rsi.toFixed(0)} (zona baixa)`);
            fatorRsiRisco *= penalidadeLeve;
          }
        }
        
        // ⭐ Para CALL: RSI muito alto = risco de pullback (queda)
        if (consolidated.signal === 'CALL') {
          if (rsi > rsiExtremoCall && adx > 25) {
            ALERTA_RSI_EXTREMO.push(`${tfKey} RSI ${rsi.toFixed(0)} (sobrecompra extrema)`);
            fatorRsiRisco *= penalidadeForte;
          } else if (rsi > rsiAlertaCall) {
            ALERTA_RSI_EXTREMO.push(`${tfKey} RSI ${rsi.toFixed(0)} (sobrecompra)`);
            fatorRsiRisco *= penalidadeMedia;
          } else if (rsi > rsiZonaCall) {
            ALERTA_RSI_EXTREMO.push(`${tfKey} RSI ${rsi.toFixed(0)} (zona alta)`);
            fatorRsiRisco *= penalidadeLeve;
          }
        }
      }
      
      // ⭐ Penalização do DeMarker quando diverge do sinal
      const penalidadeDem = isPulsoRSI ? 0.90 : 0.80;
      const limiteMinFator = isPulsoRSI ? 0.50 : 0.40;
      
      // ⭐ PUT + DeMarker COMPRA (exit_oversold) = divergência (DeMarker diz comprar, sinal diz vender)
      if (consolidated.signal === 'PUT' && demarkerInfo.signal === 'COMPRA') {
        ALERTA_RSI_EXTREMO.push(`DeMarker ${demarkerInfo.value.toFixed(2)} (COMPRA — diverge do PUT)`);
        fatorRsiRisco *= penalidadeDem;
        motorReasons.push(`⚠️ DeMarker COMPRA (${demarkerInfo.value.toFixed(2)}) — diverge do sinal PUT, possível reversão`);
      }
      // ⭐ PUT + DeMarker SOBRECOMPRA = divergência (mercado esticado para cima)
      else if (consolidated.signal === 'PUT' && demarkerInfo.signal === 'SOBRECOMPRA') {
        ALERTA_RSI_EXTREMO.push(`DeMarker ${demarkerInfo.value.toFixed(2)} (SOBRECOMPRA — diverge do PUT)`);
        fatorRsiRisco *= penalidadeDem;
        motorReasons.push(`⚠️ DeMarker SOBRECOMPRA (${demarkerInfo.value.toFixed(2)}) — mercado esticado para cima, risco de reversão`);
      }
      // ⭐ PUT + DeMarker SOBREVENDA = risco de pullback (mercado esticado para baixo)
      else if (consolidated.signal === 'PUT' && demarkerInfo.signal === 'SOBREVENDA') {
        ALERTA_RSI_EXTREMO.push(`DeMarker ${demarkerInfo.value.toFixed(2)} (SOBREVENDA)`);
        fatorRsiRisco *= penalidadeDem;
        motorReasons.push(`⚠️ DeMarker SOBREVENDA (${demarkerInfo.value.toFixed(2)}) — mercado esticado para baixo, risco de pullback`);
      }
      // ⭐ PUT + DeMarker VENDA (exit_overbought) = ALINHADO (não penaliza)

      // ⭐ CALL + DeMarker VENDA (exit_overbought) = divergência (DeMarker diz vender, sinal diz comprar)
      if (consolidated.signal === 'CALL' && demarkerInfo.signal === 'VENDA') {
        ALERTA_RSI_EXTREMO.push(`DeMarker ${demarkerInfo.value.toFixed(2)} (VENDA — diverge do CALL)`);
        fatorRsiRisco *= penalidadeDem;
        motorReasons.push(`⚠️ DeMarker VENDA (${demarkerInfo.value.toFixed(2)}) — diverge do sinal CALL, possível reversão`);
      }
      // ⭐ CALL + DeMarker SOBREVENDA = divergência (mercado esticado para baixo)
      else if (consolidated.signal === 'CALL' && demarkerInfo.signal === 'SOBREVENDA') {
        ALERTA_RSI_EXTREMO.push(`DeMarker ${demarkerInfo.value.toFixed(2)} (SOBREVENDA — diverge do CALL)`);
        fatorRsiRisco *= penalidadeDem;
        motorReasons.push(`⚠️ DeMarker SOBREVENDA (${demarkerInfo.value.toFixed(2)}) — mercado esticado para baixo, risco de reversão`);
      }
      // ⭐ CALL + DeMarker SOBRECOMPRA = risco de pullback (mercado esticado para cima)
      else if (consolidated.signal === 'CALL' && demarkerInfo.signal === 'SOBRECOMPRA') {
        ALERTA_RSI_EXTREMO.push(`DeMarker ${demarkerInfo.value.toFixed(2)} (SOBRECOMPRA)`);
        fatorRsiRisco *= penalidadeDem;
        motorReasons.push(`⚠️ DeMarker SOBRECOMPRA (${demarkerInfo.value.toFixed(2)}) — mercado esticado para cima, risco de pullback`);
      }
      // ⭐ CALL + DeMarker COMPRA (exit_oversold) = ALINHADO (não penaliza)
      
      // Limita o fator de risco
      fatorRsiRisco = Math.max(limiteMinFator, Math.min(1.0, fatorRsiRisco));
      
      // Aplica o fator à confiança
      if (fatorRsiRisco < 1.0 && ALERTA_RSI_EXTREMO.length > 0) {
        const confiancaAntes = consolidated.confidence;
        consolidated.confidence = Math.max(0, consolidated.confidence * fatorRsiRisco);
        
        const tfsTexto = ALERTA_RSI_EXTREMO.join(', ');
        
        if (consolidated.signal === 'PUT') {
          motorReasons.push(`⚠️ RSI em zona baixa (${tfsTexto}) — risco de pullback (subida) antes de continuar a cair`);
          motorReasons.push(`📊 Confiança ajustada de ${(confiancaAntes * 100).toFixed(0)}% para ${(consolidated.confidence * 100).toFixed(0)}% devido a fatores de risco`);
          motorReasons.push(`💡 O preço pode subir primeiro (pullback) antes de retomar a queda — mantém o STOP e tem paciência`);
        } else if (consolidated.signal === 'CALL') {
          motorReasons.push(`⚠️ RSI em zona alta (${tfsTexto}) — risco de pullback (queda) antes de continuar a subir`);
          motorReasons.push(`📊 Confiança ajustada de ${(confiancaAntes * 100).toFixed(0)}% para ${(consolidated.confidence * 100).toFixed(0)}% devido a fatores de risco`);
          motorReasons.push(`💡 O preço pode cair primeiro (pullback) antes de retomar a subida — mantém o STOP e tem paciência`);
        }
      }
    }
    // ⭐⭐⭐ FIM DA VERIFICAÇÃO DE RSI EXTREMO ⭐⭐⭐

    // ⭐⭐⭐ BÓNUS DE CONFIANÇA POR LIQUIDEZ FORTE (todos os modos)
    if (consolidated.signal !== 'HOLD' && liquidityResult.sweepDetected && 
        liquidityResult.confidence >= 85 && liquidityResult.direction === consolidated.signal) {
      const confiancaAntes = consolidated.confidence;
      consolidated.confidence = Math.min(0.95, consolidated.confidence + 0.05);
      motorReasons.push(`💧 Liquidez ${liquidityResult.direction} a ${liquidityResult.confidence.toFixed(0)}% — confiança reforçada (+5%)`);
      console.log(`💧 Bónus liquidez na confiança: ${(confiancaAntes * 100).toFixed(1)}% → ${(consolidated.confidence * 100).toFixed(1)}%`);
    }

	  // ⭐ Log com confiança REAL após todos os ajustes
    if (timingRiskWarning) {
      console.log(`⚠️ Timing primário (${primaryTf}) NÃO OK — confiança final: ${(consolidated.confidence * 100).toFixed(1)}%`);
    }

        // ⭐ Sincronização final — garante que todas as razões acumuladas estão em consolidated.reasons
    // Se consolidated.reasons é um array separado (early-exit: bloqueio de pulso, CHOP, etc.)
    // faz merge com motorReasons em vez de substituir, preservando ambos os conjuntos de razões.
    if (motorReasons.length > 0) {
      if (consolidated.reasons && consolidated.reasons !== motorReasons && consolidated.reasons.length > 0) {
        // Early-exit com razões próprias: adiciona só o que ainda não está presente
        const toAdd = motorReasons.filter(r => !consolidated.reasons.includes(r));
        if (toAdd.length > 0) consolidated.reasons = [...consolidated.reasons, ...toAdd];
      } else {
        // Caminho normal do motor: consolidated.reasons já aponta para motorReasons (mesma ref)
        consolidated.reasons = motorReasons;
      }
    }

    res.json({
  success: true,
  mode, modeDescription: TRADING_MODES[mode].description,
  consolidated: {
    signal: consolidated.signal,
    confidence: consolidated.confidence,
    confianca_bruta: consolidated.confidence,
    confianca_ajustada: consolidated.confidence,
    fatores_reducao: ALERTA_RSI_EXTREMO.length > 0 ? [`RSI extremo em ${ALERTA_RSI_EXTREMO.length} TF(s): ${ALERTA_RSI_EXTREMO.join(', ')}`] : [],
    positionSizeMultiplier: positionSizeMultiplier,
    agreement: agreement.agreement,
    simpleMajority: consolidated.simpleMajority,
    timeframesAnalyzed: agreement.totalTimeframes,
    sinal_premium: consolidated.sinal_premium || null,
    price: currentPrice, priceSource,
    candleOpenPrice,
    candleOpenTf: primaryOpenTf,
    priceMovedFromOpen,
    priceMovedDirection,
    tipo_ativo: tipoAtivo,
    recentPulse: recentPulse || null,
    exaustaoPrePulso: exaustaoPrePulso || null,
    ...(m1Timing  && { m1_timing:  m1Timing  }),
    ...(m5Timing  && { m5_timing:  m5Timing  }),
    ...(m15Timing && { m15_timing: m15Timing }),
    ...(h1Timing  && { h1_timing:  h1Timing  }),
    config_ativo: consolidated.config_ativo,
    ponto_franco: consolidated.ponto_franco || null,
    timing_especial: timingEspecial,
    primaryTrendNote: primaryTrendNote || null,
    timingRiskWarning: timingRiskWarning || null,
	score: consolidated.score != null ? consolidated.score : (motorScore != null ? motorScore : null),
	score_reasons: consolidated.reasons || motorReasons || [],
    zona: consolidated.zona || motorZona || null,
    regime: regimeAtual,
    tipo_tendencia: consolidated.tipo_tendencia || null,
    ciclo_completo: consolidated.ciclo_completo || null,
    alinhamento_pescador: consolidated.alinhamento_pescador || null,
    alinhamento_baleeiro: consolidated.alinhamento_baleeiro || null,
	alertas_entrada: alertasEntrada,
    aceleracao: aceleracaoSpread?.label || null,
  },
  agreement: {
    agreement: agreement.agreement, primarySignal: agreement.primarySignal,
    callCount: agreement.callCount, putCount: agreement.putCount,
    totalTimeframes: agreement.totalTimeframes
  },
  // ⭐ CORREÇÃO: Só mostra TP/SL se sinal NÃO for HOLD e valores forem válidos
  suggestion: consolidated.signal !== 'HOLD' && stopTakeLevels && !isNaN(stopTakeLevels.takeProfit) && !isNaN(stopTakeLevels.stopLoss)
    ? {
        action: 'ENTRADA',
        reason: `Stop e Take calculados para o modo ${mode}`,
        entry: stopTakeLevels.precoEntrada || currentPrice,
        stopLoss: stopTakeLevels.stopLoss,
        takeProfit: stopTakeLevels.takeProfit
      }
    : {
        action: 'WAIT',
        reason: consolidated.signal === 'HOLD'
          ? 'Mercado neutro - aguardar definição'
          : (suggestion?.reason || 'Stop/Take não disponível'),
        entry: null,
        stopLoss: null,
        takeProfit: null
      },
  timeframes: responseTimeframes,
  refined_analysis: analiseRefinada,
  risk_validation: validacaoRisco,
  liquidity: liquidityResult.sweepDetected ? {
    sweepDetected: true,
    direction: liquidityResult.direction,
    confidence: liquidityResult.confidence,
    liquidityZone: liquidityResult.liquidityZone || null,
    details: liquidityResult.details || null,
    timingOk,
    overrodeSignal: (!isAtivoPulso && !hasTfDivergenceForLiquidity && liquidityResult.sweepDetected && liquidityResult.confidence >= 75 && timingOk)
  } : { sweepDetected: false },
  demarker: {
    ...demarkerInfo,
    lockApplied:  demarkerLockApplied,
    bonusApplied: demarkerBonusApplied,
    timeframe:    primaryTfForDem,
    source:       demSource
  },
  metadata: { responseTimeMs: responseTime, timestamp: new Date().toISOString() }
});
	
  } catch (error) {
    console.error('❌ Erro na análise:', error);
    const isDev = process.env.NODE_ENV === 'development';
    res.status(500).json({ error: isDev ? error.message : 'Erro interno no processamento da análise' });
  }
});
app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
app.use((err, req, res, next) => {
  console.error('❌ Erro global:', err);
  const isDev = process.env.NODE_ENV === 'development';
  res.status(500).json({ error: 'Erro interno', message: isDev ? err.message : undefined });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 Porta ${PORT}`);
  console.log(`🎯 Modos: ${Object.keys(TRADING_MODES).join(', ')}`);
  console.log(`📊 Candles: M1→100 | M5/M15→120 | H1→100 | H4→60 | H24→40 | W1/MN1 agregados`);
  console.log(`⚡ Tick timeout: 350ms | Candles + Tick em paralelo | analiseRefinada em paralelo`);
  console.log(`🏷️  Deteção de ativo: 9 tipos (volatility/boom/crash/jump/step/commodity/cripto/forex/normal)`);
  console.log(`💧 Liquidity Hunter Robusto ativo`);
  console.log(`💾 Cache em memória anti-ruído ativo (max ${MAX_MEMORY_CACHE_SIZE} entradas)`);
  console.log(`🧠 Motor de 3 Camadas (TREND → STRUCTURE → ENTRY) ativo`);
  console.log(`📐 DeMarker(14) híbrido: histórico imediato + ticks background`);
  console.log(`🔧 FIX: liquidityResult.confidence normalizado para escala 0-1`);
  console.log(`🧭 Nota de tendência primária ativa`);
  console.log(`⛔ Penalização de Timing: limitada a 35% se o TF primário não confirma`);
  console.log(`🛡️  FIX 1: uncaughtException + unhandledRejection com graceful shutdown`);
  console.log(`🔄 FIX 2: Watchdog de reconexão Deriv com lock a cada 4 minutos`);
  console.log(`💓 FIX 3: Self-ping anti-hibernação a cada 10 minutos`);
  console.log(`❤️  FIX 4: /health com status detalhado ativo`);
  console.log(`🔌 FIX: disconnect() seguro antes de abandonar cliente Deriv`);
  console.log(`🔌 FIX: optional chaining em analise.sinal ativo`);
  console.log(`⏱️  FIX: timeout getCandles reduzido para 12s`);
  console.log(`🔒 FIX: Cache Redis com validação JSON e LRU em memória`);
  console.log(`⚡ TTL reduzido para ativos de pulso no SNIPER (10s max)`);
  console.log(`🎯 RSI dinâmico por modo implementado`);
  console.log(`💠 Stop Loss dinâmico: 2% pulso / 0.2% normal`);
  console.log(`🛡️  Override de liquidez bloqueado em ativos de pulso`);
  console.log(`👁️  Detecção de pulso recente ativa`);
  console.log(`⚡ Ponto Franco calculado automaticamente`);
  console.log(`🎯 MOTOR: Score adaptativo | Zonas A/B/C | Regime-aware`);
  console.log(`🎯 TFs tendência: SNIPER→H1 | CAÇADOR→H4 | PESCADOR→H4 | BALEEIRO→H4`);
  console.log(`📊 RSI_LIMITS_BY_ASSET revisados (forex→40, volatility→40/42, boom→30)`);
  console.log(`📐 [FIX MN1] Análise manual MN1 com EMA5/9+RSI para <26 candles — ADX real calculado`);
  console.log(`⚡ [FIX PERF] H24_BIG buscado em paralelo com tick e candles regulares`);
  try { await getDerivClient(); console.log('✅ Conexão Deriv OK'); }
  catch (err) { console.error('❌ Conexão Deriv:', err); }
});

const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(async () => {
  try {
    if (typeof fetch !== 'function') {
      console.warn('⚠️ fetch não disponível para self-ping');
      return;
    }
    const res = await fetch(`${SELF_URL}/health`);
    console.log(`💓 Self-ping OK: ${res.status} | uptime: ${Math.floor(process.uptime())}s`);
  } catch (err) {
    console.error('⚠️ Self-ping falhou:', err.message);
  }
}, 10 * 60 * 1000);

server.keepAliveTimeout = 120000;
server.headersTimeout   = 120000;

process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM - encerrando...');
  server.close(() => {
    destroyAllDeMarkers();
    if (derivClient) {
      try { derivClient.disconnect(); } catch (e) {}
    }
    if (redisClient) redisClient.quit();
    process.exit(0);
  });
});
process.on('SIGINT', () => process.emit('SIGTERM'));

module.exports = app;
