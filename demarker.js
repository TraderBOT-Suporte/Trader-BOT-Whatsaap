'use strict';

const { EventEmitter } = require('events');

const demarkerInstances = new Map();
const TF_SECONDS = { M1: 60, M5: 300, M15: 900, H1: 3600, H4: 14400, H24: 86400 };

// ─────────────────────────────────────────────────────────────────────────────
// CÁLCULO ESTÁTICO COM HISTÓRICO DE CANDLES
// Usado para obter resultado imediato em cada análise.
// Recebe array de candles no formato { open, high, low, close }
// e devolve o mesmo estado que getSignalState() da classe.
// ─────────────────────────────────────────────────────────────────────────────
function calcularDeMarkerComHistorico(candles, opts = {}) {
  const period      = opts.period       ?? 14;
  const overbought  = opts.overbought   ?? 0.70;
  const oversold    = opts.oversold     ?? 0.30;
  const persistLimit = opts.persistLimit ?? 5;
  const adxThreshold = opts.adxThreshold ?? 25;
  const emaPeriod   = opts.emaPeriod    ?? 21;

  if (!candles || candles.length < period + 2) {
    return { signal: 'SEM_DADOS', dem: null, prevDem: null, locked: false,
             reason: 'candles_insuficientes', persistCount: 0, adxProxy: 0,
             ema: null, isTrending: false };
  }

  // Normalizar candles
  const cls = candles.map(c => ({
    open:  parseFloat(c.open),
    high:  parseFloat(c.high),
    low:   parseFloat(c.low),
    close: parseFloat(c.close)
  }));

  // DeMax e DeMin
  const deMax = [];
  const deMin = [];
  for (let i = 1; i < cls.length; i++) {
    deMax.push(Math.max(cls[i].high - cls[i - 1].high, 0));
    deMin.push(Math.max(cls[i - 1].low - cls[i].low, 0));
  }

  // SMA auxiliar
  const sma = (arr, end, len) => {
    let s = 0;
    for (let j = end - len + 1; j <= end; j++) s += arr[j];
    return s / len;
  };

  // Série DeMarker completa
  const series = [];
  for (let i = period - 1; i < deMax.length; i++) {
    const sMax = sma(deMax, i, period);
    const sMin = sma(deMin, i, period);
    const sum  = sMax + sMin;
    series.push(sum === 0 ? 0.5 : sMax / sum);
  }

  if (series.length < 2) {
    return { signal: 'SEM_DADOS', dem: null, prevDem: null, locked: false,
             reason: 'serie_insuficiente', persistCount: 0, adxProxy: 0,
             ema: null, isTrending: false };
  }

  const dem     = series[series.length - 1];
  const prevDem = series[series.length - 2];

  // Persistência na zona extrema
  let persistCount = 0;
  const inZone = v => (dem >= overbought && v >= overbought) || (dem <= oversold && v <= oversold);
  for (let i = series.length - 1; i >= 0; i--) {
    if (inZone(series[i])) persistCount++;
    else break;
  }

  // ADX proxy simples (últimas 2*period velas)
  const adxWindow = Math.min(cls.length, period * 2);
  const recent = cls.slice(-adxWindow);
  const older  = cls.slice(-adxWindow * 2, -adxWindow).length > 0
    ? cls.slice(-adxWindow * 2, -adxWindow)
    : cls.slice(0, Math.floor(cls.length / 2));

  const avgRange = arr => arr.reduce((s, c) => s + (c.high - c.low), 0) / arr.length;
  const avgClose = arr => arr.reduce((s, c) => s + c.close, 0) / arr.length;
  const rr = avgRange(recent) / (avgRange(older) || 1);
  const cd = Math.abs(avgClose(recent) - avgClose(older));
  const sc = avgRange(recent) || 1;
  const adxProxy = Math.min(60, Math.max(0, (rr - 1) * 30 + (cd / sc) * 30));
  const isTrending = adxProxy >= adxThreshold;

  // EMA simples
  const emaCandles = cls.slice(-Math.max(emaPeriod, cls.length));
  const k = 2 / (emaPeriod + 1);
  let emaVal = emaCandles[0].close;
  for (let i = 1; i < emaCandles.length; i++) emaVal = emaCandles[i].close * k + emaVal * (1 - k);

  const lastClose = cls[cls.length - 1].close;
  const priceAboveEma = lastClose > emaVal;

  const base = { dem, prevDem, adxProxy, persistCount, ema: emaVal, isTrending };

  // ── Regra 1: cruzamento de saída ─────────────────────────────────────────
  if (prevDem >= overbought && dem < overbought)
    return { ...base, signal: 'VENDA',  locked: false, reason: 'exit_overbought' };
  if (prevDem <= oversold   && dem > oversold)
    return { ...base, signal: 'COMPRA', locked: false, reason: 'exit_oversold' };

  // ── Regra 2: oscillator lock ──────────────────────────────────────────────
  if (isTrending && persistCount >= persistLimit) {
    if (dem >= overbought) {
      if (!priceAboveEma)
        return { ...base, signal: 'VENDA',  locked: false, reason: 'lock_exception_below_ema' };
      return { ...base, signal: 'IGNORAR', locked: true, reason: 'trend_lock_alta' };
    }
    if (dem <= oversold) {
      if (priceAboveEma)
        return { ...base, signal: 'COMPRA', locked: false, reason: 'lock_exception_above_ema' };
      return { ...base, signal: 'IGNORAR', locked: true, reason: 'trend_lock_baixa' };
    }
  }

  // ── Regra 3: zona extrema sem lock ───────────────────────────────────────
  if (dem >= overbought)
    return { ...base, signal: 'SOBRECOMPRA', locked: false, reason: 'in_overbought_zone' };
  if (dem <= oversold)
    return { ...base, signal: 'SOBREVENDA',  locked: false, reason: 'in_oversold_zone' };

  // ── Regra 4: zona neutra ──────────────────────────────────────────────────
  return { ...base, signal: 'AGUARDAR', locked: false, reason: 'neutral_zone' };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASSE PRINCIPAL (ticks em tempo real — acumulação em background)
// ─────────────────────────────────────────────────────────────────────────────
class DeMarkerCalculator extends EventEmitter {
    constructor(client, symbol, period = 14, candleSeconds = 60, maxCandles = 200, opts = {}) {
        super();
        this.client        = client;
        this.symbol        = symbol;
        this.period        = period;
        this.candleSeconds = candleSeconds;
        this.maxCandles    = maxCandles;
        this.opts = {
            persistLimit : opts.persistLimit  ?? 5,
            adxThreshold : opts.adxThreshold  ?? 25,
            emaPeriod    : opts.emaPeriod     ?? 21,
            adxPeriod    : opts.adxPeriod     ?? 14,
            overbought   : opts.overbought    ?? 0.70,
            oversold     : opts.oversold      ?? 0.30,
        };
        this.candles    = [];
        this.demValues  = [];
        this.lastDem    = null;
        this.lastSignal = null;
        this._id = `dem_${symbol}_${Date.now()}`;
        this._init();
    }

    // ── Seed com histórico de candles ─────────────────────────────────────────
    // Chamado pelo server.js logo após criar a instância,
    // para que o DeMarker já tenha dados antes dos ticks chegarem.
    seedFromHistory(historicalCandles) {
        if (!historicalCandles || historicalCandles.length === 0) return;
        const existing = new Set(this.candles.map(c => c.start));
        let added = 0;
        for (const hc of historicalCandles) {
            const epoch = hc.epoch ?? hc.start ?? 0;
            const start = Math.floor(epoch / this.candleSeconds) * this.candleSeconds;
            if (existing.has(start)) continue;
            this.candles.push({
                start,
                open:      parseFloat(hc.open),
                high:      parseFloat(hc.high),
                low:       parseFloat(hc.low),
                close:     parseFloat(hc.close),
                completed: true   // candles históricos são sempre fechados
            });
            added++;
        }
        // Ordenar por start e limitar
        this.candles.sort((a, b) => a.start - b.start);
        if (this.candles.length > this.maxCandles) {
            this.candles = this.candles.slice(-this.maxCandles);
        }
        if (added > 0) {
            this._recalc();
            console.log(`📚 DeMarker ${this.symbol} seed: +${added} velas históricas (total: ${this.candles.filter(c=>c.completed).length} fechadas)`);
        }
    }

    _init() {
        this.client.addListener(this._id, this._onTick.bind(this));
        console.log(
            `📡 DeMarker(${this.period}) activo — ${this.symbol} ` +
            `[velas ${this.candleSeconds}s | lock≥${this.opts.persistLimit} | ADX≥${this.opts.adxThreshold}]`
        );
    }

    _onTick(msg) {
        const tick = msg?.tick;
        if (!tick) return;
        const { quote: price, epoch } = tick;
        if (price == null || epoch == null) return;
        const candleStart = Math.floor(epoch / this.candleSeconds) * this.candleSeconds;
        if (this.candles.length === 0) { this._openCandle(candleStart, price); return; }
        const cur = this.candles[this.candles.length - 1];
        if (candleStart > cur.start) {
            cur.completed = true;
            this._openCandle(candleStart, price);
            this._recalc();
            this._emit();
        } else {
            if (price > cur.high) cur.high = price;
            if (price < cur.low)  cur.low  = price;
            cur.close = price;
        }
    }

    _openCandle(start, price) {
        this.candles.push({ start, open: price, high: price, low: price, close: price, completed: false });
        if (this.candles.length > this.maxCandles) this.candles.shift();
    }

    _recalc() {
        const closed = this.candles.filter(c => c.completed);
        if (closed.length < this.period + 1) { this.lastDem = null; this.demValues = []; return; }
        const deMax = [], deMin = [];
        for (let i = 1; i < closed.length; i++) {
            deMax.push(Math.max(closed[i].high - closed[i-1].high, 0));
            deMin.push(Math.max(closed[i-1].low - closed[i].low, 0));
        }
        const sma = (arr, end, len) => { let s=0; for(let j=end-len+1;j<=end;j++) s+=arr[j]; return s/len; };
        const series = [];
        for (let i = this.period-1; i < deMax.length; i++) {
            const sMax = sma(deMax, i, this.period);
            const sMin = sma(deMin, i, this.period);
            const sum  = sMax + sMin;
            series.push(sum === 0 ? 0.5 : sMax / sum);
        }
        this.demValues = new Array(closed.length).fill(null);
        for (let i = 0; i < series.length; i++) this.demValues[this.period + i] = series[i];
        this.lastDem = this.demValues[this.demValues.length - 1];
    }

    _ema(period) {
        const closed = this.candles.filter(c => c.completed);
        if (closed.length < period) return null;
        const k = 2 / (period + 1);
        let v = closed[0].close;
        for (let i = 1; i < closed.length; i++) v = closed[i].close * k + v * (1 - k);
        return v;
    }

    _adxProxy() {
        const closed = this.candles.filter(c => c.completed);
        const n = this.opts.adxPeriod;
        if (closed.length < n * 2) return 0;
        const recent = closed.slice(-n);
        const older  = closed.slice(-n*2, -n);
        const avgRange = arr => arr.reduce((s,c) => s + (c.high - c.low), 0) / arr.length;
        const avgClose = arr => arr.reduce((s,c) => s + c.close, 0) / arr.length;
        const rr = avgRange(recent) / (avgRange(older) || 1);
        const cd = Math.abs(avgClose(recent) - avgClose(older));
        const sc = avgRange(recent) || 1;
        return Math.min(60, Math.max(0, (rr-1)*30 + (cd/sc)*30));
    }

    _persistCount() {
        const last = this.lastDem;
        if (last === null) return 0;
        const { overbought, oversold } = this.opts;
        const same = v => (last >= overbought && v >= overbought) || (last <= oversold && v <= oversold);
        let n = 0;
        for (let i = this.demValues.length-1; i >= 0; i--) {
            if (this.demValues[i] !== null && same(this.demValues[i])) n++;
            else break;
        }
        return n;
    }

    _prevDem() {
        const valid = this.demValues.filter(v => v !== null);
        return valid.length >= 2 ? valid[valid.length - 2] : null;
    }

    _filter() {
        const dem = this.lastDem;
        if (dem === null) return { signal: 'SEM_DADOS', dem: null, prevDem: null,
            adxProxy: 0, persistCount: 0, ema: null, locked: false, isTrending: false,
            reason: 'dados_insuficientes' };
        const { overbought, oversold, persistLimit, adxThreshold, emaPeriod } = this.opts;
        const prevDem      = this._prevDem();
        const adxProxy     = this._adxProxy();
        const persistCount = this._persistCount();
        const ema          = this._ema(emaPeriod);
        const isTrending   = adxProxy >= adxThreshold;
        const closed       = this.candles.filter(c => c.completed);
        const lastPrice    = closed.length > 0 ? closed[closed.length-1].close : null;
        const priceAboveEma = ema !== null && lastPrice !== null && lastPrice > ema;
        const base = { dem, prevDem, adxProxy, persistCount, ema, isTrending };
        if (prevDem !== null) {
            if (prevDem >= overbought && dem < overbought)
                return { ...base, signal: 'VENDA',  locked: false, reason: 'exit_overbought' };
            if (prevDem <= oversold   && dem > oversold)
                return { ...base, signal: 'COMPRA', locked: false, reason: 'exit_oversold' };
        }
        if (isTrending && persistCount >= persistLimit) {
            if (dem >= overbought) {
                if (ema !== null && !priceAboveEma)
                    return { ...base, signal: 'VENDA',  locked: false, reason: 'lock_exception_below_ema' };
                return { ...base, signal: 'IGNORAR', locked: true, reason: 'trend_lock_alta' };
            }
            if (dem <= oversold) {
                if (ema !== null && priceAboveEma)
                    return { ...base, signal: 'COMPRA', locked: false, reason: 'lock_exception_above_ema' };
                return { ...base, signal: 'IGNORAR', locked: true, reason: 'trend_lock_baixa' };
            }
        }
        if (dem >= overbought) return { ...base, signal: 'SOBRECOMPRA', locked: false, reason: 'in_overbought_zone' };
        if (dem <= oversold)   return { ...base, signal: 'SOBREVENDA',  locked: false, reason: 'in_oversold_zone' };
        return { ...base, signal: 'AGUARDAR', locked: false, reason: 'neutral_zone' };
    }

    _emit() {
        if (this.lastDem === null) return;
        const state = this._filter();
        const payload = {
            symbol: this.symbol,
            dem:          state.dem          !== null ? +state.dem.toFixed(6)     : null,
            prevDem:      state.prevDem      !== null ? +state.prevDem.toFixed(6) : null,
            ema:          state.ema          !== null ? +state.ema.toFixed(6)     : null,
            adxProxy:     +state.adxProxy.toFixed(2),
            persistCount: state.persistCount,
            isTrending:   state.isTrending,
            locked:       state.locked,
            signal:       state.signal,
            reason:       state.reason,
            timestamp:    new Date().toISOString(),
        };
        this.emit('update', payload);
        if (state.signal !== this.lastSignal) {
            this.lastSignal = state.signal;
            this.emit('signal', payload);
            const icons = { COMPRA:'🟢', VENDA:'🔴', SOBRECOMPRA:'🟡', SOBREVENDA:'🔵', IGNORAR:'🔒', AGUARDAR:'⏳', SEM_DADOS:'⚪' };
            console.log(
                `${icons[state.signal]??'❓'} DeMarker ${this.symbol} | ` +
                `DeM=${state.dem?.toFixed(4)} prevDem=${state.prevDem?.toFixed(4)} | ` +
                `Sinal=${state.signal} | Razão=${state.reason} | ` +
                `Lock=${state.locked} | Persist=${state.persistCount} | ` +
                `ADX≈${state.adxProxy?.toFixed(1)} | EMA=${state.ema?.toFixed(4)??'n/a'}`
            );
        }
    }

    getLastDeMarker()     { return this.lastDem; }
    getSignalState()      { if (this.lastDem === null) return null; return this._filter(); }
    getDemarkerHistory()  { return [...this.demValues]; }
    getCandles()          { return this.candles; }
    getWarmupStatus() {
        const completed = this.candles.filter(c => c.completed).length;
        const needed    = this.period + 1;
        return { ready: completed >= needed, completed, needed, missing: Math.max(0, needed - completed) };
    }
    stop() {
        this.client.removeListener(this._id);
        this.removeAllListeners();
        console.log(`🛑 DeMarker parado — ${this.symbol}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────
function getOrCreateDeMarker(client, symbol, candleSeconds = 300, opts = {}) {
    const key = `${symbol}:${candleSeconds}`;
    if (demarkerInstances.has(key)) return demarkerInstances.get(key);
    const dem = new DeMarkerCalculator(client, symbol, 14, candleSeconds, 200, {
        persistLimit: 5, adxThreshold: 25, emaPeriod: 21, adxPeriod: 14,
        overbought: 0.70, oversold: 0.30, ...opts,
    });
    dem.on('update', (payload) => { void payload; });
    dem.on('signal', (payload) => {
        if (payload.signal === 'IGNORAR') {
            console.log(`🔒 [DeMarker] Oscillator lock activo — ${symbol} (persist=${payload.persistCount}, ADX≈${payload.adxProxy}, razão=${payload.reason})`);
        }
    });
    demarkerInstances.set(key, dem);
    return dem;
}

function destroyDeMarker(symbol, candleSeconds = 300) {
    const key = `${symbol}:${candleSeconds}`;
    const dem = demarkerInstances.get(key);
    if (dem) { dem.stop(); demarkerInstances.delete(key); }
}

function destroyAllDeMarkers() {
    demarkerInstances.forEach(dem => dem.stop());
    demarkerInstances.clear();
}

module.exports = {
    DeMarkerCalculator,
    calcularDeMarkerComHistorico,
    getOrCreateDeMarker,
    destroyDeMarker,
    destroyAllDeMarkers,
    demarkerInstances,
    TF_SECONDS,
};
