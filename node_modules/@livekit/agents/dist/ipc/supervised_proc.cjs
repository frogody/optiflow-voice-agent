"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var supervised_proc_exports = {};
__export(supervised_proc_exports, {
  SupervisedProc: () => SupervisedProc
});
module.exports = __toCommonJS(supervised_proc_exports);
var import_node_events = require("node:events");
var import_log = require("../log.cjs");
var import_utils = require("../utils.cjs");
class SupervisedProc {
  #opts;
  #started = false;
  #closing = false;
  #runningJob = void 0;
  proc;
  #pingInterval;
  #memoryWatch;
  #pongTimeout;
  init = new import_utils.Future();
  #join = new import_utils.Future();
  #logger = (0, import_log.log)().child({ runningJob: this.#runningJob });
  constructor(initializeTimeout, closeTimeout, memoryWarnMB, memoryLimitMB, pingInterval, pingTimeout, highPingThreshold) {
    this.#opts = {
      initializeTimeout,
      closeTimeout,
      memoryWarnMB,
      memoryLimitMB,
      pingInterval,
      pingTimeout,
      highPingThreshold
    };
  }
  get started() {
    return this.#started;
  }
  get runningJob() {
    return this.#runningJob;
  }
  async start() {
    if (this.#started) {
      throw new Error("runner already started");
    } else if (this.#closing) {
      throw new Error("runner is closed");
    }
    this.proc = this.createProcess();
    this.#started = true;
    this.run();
  }
  async run() {
    await this.init.await;
    this.#pingInterval = setInterval(() => {
      this.proc.send({ case: "pingRequest", value: { timestamp: Date.now() } });
    }, this.#opts.pingInterval);
    this.#pongTimeout = setTimeout(() => {
      this.#logger.warn("job is unresponsive");
      clearTimeout(this.#pongTimeout);
      clearInterval(this.#pingInterval);
      this.proc.kill();
      this.#join.resolve();
    }, this.#opts.pingTimeout);
    this.#memoryWatch = setInterval(() => {
      const memoryMB = process.memoryUsage().heapUsed / (1024 * 1024);
      if (this.#opts.memoryLimitMB > 0 && memoryMB > this.#opts.memoryLimitMB) {
        this.#logger.child({ memoryUsageMB: memoryMB, memoryLimitMB: this.#opts.memoryLimitMB }).error("process exceeded memory limit, killing process");
        this.close();
      } else if (this.#opts.memoryWarnMB > 0 && memoryMB > this.#opts.memoryWarnMB) {
        this.#logger.child({
          memoryUsageMB: memoryMB,
          memoryWarnMB: this.#opts.memoryWarnMB,
          memoryLimitMB: this.#opts.memoryLimitMB
        }).error("process memory usage is high");
      }
    });
    const listener = (msg) => {
      var _a;
      switch (msg.case) {
        case "pongResponse": {
          const delay = Date.now() - msg.value.timestamp;
          if (delay > this.#opts.highPingThreshold) {
            this.#logger.child({ delay }).warn("job executor is unresponsive");
          }
          (_a = this.#pongTimeout) == null ? void 0 : _a.refresh();
          break;
        }
        case "exiting": {
          this.#logger.child({ reason: msg.value.reason }).debug("job exiting");
          break;
        }
        case "done": {
          this.#closing = true;
          this.proc.off("message", listener);
          break;
        }
      }
    };
    this.proc.on("message", listener);
    this.proc.on("error", (err) => {
      if (this.#closing) return;
      this.#logger.child({ err }).warn("job process exited unexpectedly; this likely means the error above caused a crash");
      clearTimeout(this.#pongTimeout);
      clearInterval(this.#pingInterval);
      clearInterval(this.#memoryWatch);
      this.#join.resolve();
    });
    this.proc.on("exit", () => {
      this.#join.resolve();
    });
    this.mainTask(this.proc);
    await this.#join.await;
  }
  async join() {
    if (!this.#started) {
      throw new Error("runner not started");
    }
    await this.#join.await;
  }
  async initialize() {
    const timer = setTimeout(() => {
      const err = new Error("runner initialization timed out");
      this.init.reject(err);
      throw err;
    }, this.#opts.initializeTimeout);
    this.proc.send({
      case: "initializeRequest",
      value: {
        loggerOptions: import_log.loggerOptions,
        pingInterval: this.#opts.pingInterval,
        pingTimeout: this.#opts.pingTimeout,
        highPingThreshold: this.#opts.highPingThreshold
      }
    });
    await (0, import_node_events.once)(this.proc, "message").then(([msg]) => {
      clearTimeout(timer);
      if (msg.case !== "initializeResponse") {
        throw new Error("first message must be InitializeResponse");
      }
    });
    this.init.resolve();
  }
  async close() {
    if (!this.#started) {
      return;
    }
    this.#closing = true;
    this.proc.send({ case: "shutdownRequest" });
    const timer = setTimeout(() => {
      this.#logger.error("job shutdown is taking too much time");
      this.proc.kill();
    }, this.#opts.closeTimeout);
    await this.#join.await.then(() => {
      clearTimeout(timer);
      clearTimeout(this.#pongTimeout);
      clearInterval(this.#pingInterval);
    });
  }
  async launchJob(info) {
    if (this.#runningJob) {
      throw new Error("executor already has a running job");
    }
    this.#runningJob = info;
    this.proc.send({ case: "startJobRequest", value: { runningJob: info } });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SupervisedProc
});
//# sourceMappingURL=supervised_proc.cjs.map