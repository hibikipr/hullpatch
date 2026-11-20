// A fixed pool of worker threads with a bounded queue. One job per worker at a time;
// a job that runs too long gets its worker terminated and replaced.
import { Worker } from 'node:worker_threads';

export class PoolFullError extends Error {}
export class JobTimeoutError extends Error {}

export class Pool {
  constructor({ size, queue, timeoutMs, workerUrl, workerData = {} }) {
    this.size = size;
    this.maxQueue = queue;
    this.timeoutMs = timeoutMs;
    this.workerUrl = workerUrl;
    this.workerData = workerData;
    this.workers = [];
    this.queue = [];
    this.closed = false;
    for (let i = 0; i < size; i++) this.workers.push(this._spawn());
  }

  get running() { return this.workers.filter((w) => w.job).length; }
  get waiting() { return this.queue.length; }
  /** True when a new job would be refused. */
  get full() { return this.queue.length >= this.maxQueue && this.workers.every((w) => w.job); }

  _spawn() {
    const slot = { worker: new Worker(this.workerUrl, { workerData: this.workerData }), job: null, timer: null };
    slot.worker.on('message', (msg) => {
      const job = slot.job;
      if (!job) return;
      this._finish(slot);
      job.resolve(msg);
      this._drain();
    });
    const lost = (err) => {
      if (this.workers.indexOf(slot) < 0) return; // already replaced
      const job = slot.job;
      this._replace(slot);
      if (job) job.reject(err instanceof Error ? err : new Error('worker exited unexpectedly'));
    };
    slot.worker.on('error', lost);
    slot.worker.on('exit', () => lost(new Error('worker exited unexpectedly')));
    return slot;
  }

  _finish(slot) {
    clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
  }

  _replace(slot) {
    clearTimeout(slot.timer);
    slot.job = null;
    const i = this.workers.indexOf(slot);
    slot.worker.removeAllListeners();
    slot.worker.on('error', () => {});
    slot.worker.terminate();
    if (i >= 0) {
      if (this.closed) this.workers.splice(i, 1);
      else this.workers[i] = this._spawn();
    }
    this._drain();
  }

  _drain() {
    while (this.queue.length) {
      const slot = this.workers.find((w) => !w.job);
      if (!slot) return;
      const job = this.queue.shift();
      slot.job = job;
      slot.timer = setTimeout(() => {
        this._replace(slot);
        job.reject(new JobTimeoutError('job timed out'));
      }, this.timeoutMs);
      try {
        slot.worker.postMessage(job.msg, job.transfer);
      } catch (err) { // e.g. a buffer that cannot be transferred: fail this job, keep the worker
        this._finish(slot);
        job.reject(err);
      }
    }
  }

  /** Run `msg` in a worker; `transfer` lists ArrayBuffers handed over without copying. Rejects PoolFullError when saturated. */
  run(msg, transfer = []) {
    if (this.closed) return Promise.reject(new Error('pool closed'));
    if (this.full) return Promise.reject(new PoolFullError('queue full'));
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, transfer, resolve, reject });
      this._drain();
    });
  }

  async close() {
    this.closed = true;
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
  }
}
