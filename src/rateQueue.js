// ==== Rate Queue ====
//
// The bot turns one message into X sends, causing bursts of API calls
// This queue sits above library to pace outbound request
//
// It provides:
// > one request in flight at a time, with a minimum start gap
// > retries with exponential backoff and jitter
// > rate-limit handling using server retry hints when available
// > backpressure if queueMax is exceeded, drop oldest task

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==== error classification ====
//
// pull retry hint out of whatever library threw
// returns:
// > isRateLimit  – did this look like a rate limit
// > isTransient  – is it worth retrying at all
// > retryMs      - server-suggested wait in ms, or null if it did not say
function classifyError(err) {
  const message = (err && err.message) || "";

  //conection failures from library start with this:
  const isConnect = /could not connect to server/i.test(message);

  let body = null;
  try {
    body = JSON.parse(message);
  } catch { }

  let retryMs = null;
  if (body && typeof body == "object") {
    const inner = body.error && typeof body.error === "object" ? body.error : body;
    //retryAfter shows up in ms on some endpoints and seconds on others
    //heuristic: small number == seconds, no?
    if (typeof inner.retryAfter === "number") {
      retryMs = inner.retryAfter <= 120 ? inner.retryAfter * 1000 : inner.retryAfter;
    } else if (typeof inner.ttl === "number") {
      retryMs = inner.ttl;
    }
  }

  const text = body ? JSON.stringify(body) : message;
  const looksRateLimited = retryMs != null || /rate.?limit|too many|slow.?mode|\b429\b/i.test(text);

  return {
    isRateLimit: looksRateLimited,
    isTransient: looksRateLimited || isConnect,
    retryMs,
  };
}

class RateQueue {
  // > logger                                     – scoped logger (see logger.js)
  // > minGapMs                                   – minimum spacing between task starts
  // > maxAttempts, baseBackoffMs, maxBackoffMs   – retry tuning
  // > queueMax                                   - hard cap before shedding oldest task
  constructor(opts) {
    this.log = opts.logger;
    this.minGapMs = opts.minGapMs;
    this.windowLimit = opts.windowLimit;
    this.windowMs = opts.windowMs;
    this.maxAttempts = opts.maxAttempts;
    this.baseBackoffMs = opts.baseBackoffMs;
    this.maxBackoffMs = opts.maxBackoffMs;
    this.queueMax = opts.queueMax;

    this.tasks = [];
    this.running = false;
    this.lastStartAt = 0;
    this.sendTimes = [];

    //rolling counters
    this.stats = { enqueued: 0, done: 0, failed: 0, retried: 0, shed: 0 };
  }

  get size() {
    return this.tasks.length;
  }

  // ==== public api ====
  //
  // hand label and async function. get back a Promise that resolves
  // with fucntions result, or rejects once given up on it
  // lable is purely for logs
  enqueue(label, fn) {
    return new Promise((resolve, reject) => {
      //shed oldest task if drowning. better lose stalest relay
      //than to OOM process and lose everything
      if (this.tasks.length >= this.queueMax) {
        const dropped = this.tasks.shift();
        this.stats.shed++;
        this.log.warn(`queue full (${this.queueMax}), sheeding oldest task`, {
          dropped: dropped.label,
        });
        dropped.reject(new Error("Queue overflow; task shed"));
      }

      const task = { label, fn, resolve, reject, attempts: 0 };
      this.tasks.push(task);
      this.stats.enqueued++;
      this.log.debug(`enqueued "${label}"`, { size: this.tasks.length });

      this._kick();
    });
  }

  // ==== worker ====
  _kick() {
    if (this.running) return;
    this.running = true;
    this._drain().catch((err) => {
      //drain lopp should never throw, but if it somehow does
      //there shouldnt be a silently dead worker
      this.log.error("queue worker crashed", err);
      this.running = false;
    });
  }

  async _drain() {
    while (this.tasks.length) {
      const task = this.tasks.shift();
      await this._respectBudget();
      await this._respectGap();
      await this._runTask(task);
    }
    this.running = false;
    this.log.trace("queue drained, worker idle");
  }

  //enforce minimum spacing between START of each task
  async _respectGap() {
    const since = Date.now() - this.lastStartAt;
    if (since < this.minGapMs) {
      const wait = this.minGapMs - since;
      this.log.trace(`spacing gap, waiting ${wait}ms`);
      await sleep(wait);
    }
    this.lastStartAt = Date.now();
    this.sendTimes.push(this.lastStartAt);
  }

  //sliding window rate limit
  //sleep until budgets refills to avoid 429s
  //minGap only smooths bursts
  async _respectBudget() {
    if (!this.windowLimit) return;
    const now = Date.now();
    const cutoff = now - this.windowMs;
    while (this.sendTimes.length && this.sendTimes[0] <= cutoff) this.sendTimes.shift();

    if (this.sendTimes.length >= this.windowLimit) {
      const wait = this.sendTimes[0] + this.windowMs - now + 250;
      this.log.debug(`send budget spent (${this.windowLimit}/${this.windowMs}ms, waitinh ${wait}ms`);
      await sleep(wait);
      const cutoff2 = Date.now() - this.windowMs;
      while (this.sendTimes.length && this.sendTimes[0] <= cutoff2) this.sendTimes.shift();
    }
  }

  async _runTask(task) {
    task.attempts++;
    this.log.trace(`run "${task.label}" attempt ${task.attempts}`);
    try {
      const result = await task.fn();
      this.stats.done++;
      this.log.debug(`done "${task.label}"`, { attempts: task.attempts });
      task.resolve(result);
    } catch (err) {
      await this._handleFailure(task, err);
    }
  }

  async _handleFailure(task, err) {
    const verdict = classifyError(err);
    const giveUp = !verdict.isTransient || task.attempts >= this.maxAttempts;

    if (giveUp) {
      this.stats.failed++;
      this.log.error(
        `giving up on "${task.label} after ${task.attempts} attempt(s)`,
        { rateLimited: verdict.isRateLimit, transient: verdict.isTransient },
        err,
      );
      task.reject(err);
      return;
    }

    let delay = this._backoffFor(task.attempts, verdict.retryMs);
    if (verdict.isRateLimit) {
      delay = Math.max(delay, this.windowMs + 500);
    }
    this.stats.retried++;
    this.log.warn(
      `retrying "${task.label}" in ${delay}ms ` +
      `(attempt ${task.attempts}/${this.maxAttempts}, ` +
      `${verdict.isRateLimit ? "rate-limited" : "transient"})`,
    );

    await sleep(delay);
    this.tasks.unshift(task);
  }

  //server hint wins when present, otherwise classic exponential backoff
  //either way cap it and sprinkle jitter so parallel-ish retries do not
  //all wake up on sam millisecond
  _backoffFor(attempt, hintedMs) {
    const base =
      hintedMs !== null && hintedMs !== undefined
        ? hintedMs
        : this.baseBackoffMs * Math.pow(2, attempt - 1);
    const capped = Math.min(base, this.maxBackoffMs);
    const jitter = Math.floor(Math.random() * this.baseBackoffMs);
    return capped + jitter;
  }
}

module.exports = { RateQueue, classifyError };
