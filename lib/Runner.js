'use strict';

const AWS = require('aws-sdk');
const EventEmitter = require('events');
const BPromise = require('bluebird');
const percentile = require('percentile');

const REPORT_REGEX = /REPORT RequestId: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+Duration: ([0-9.]+) ms\s+Billed Duration: ([0-9]+) ms\s+Memory Size: (\d+) MB\s+Max Memory Used: (\d+) MB\s+$/; // eslint-disable-line max-len
const PERCENTILES = [50, 66, 75, 80, 90, 95, 98, 99];

class Runner extends EventEmitter {
  constructor(options = {}) {
    super();

    Object.assign(this, options);

    this.lambdaClient = new AWS.Lambda({ region: options.region });
  }

  _getAllocatedMemory() {
    return this.lambdaClient
      .getFunctionConfiguration({
        FunctionName: this.functionName
      })
      .promise()
      .then(result => result.MemorySize);
  }

  _setAllocatedMemory(memorySize) {
    return this.lambdaClient
      .updateFunctionConfiguration({
        FunctionName: this.functionName,
        MemorySize: memorySize
      })
      .promise();
  }

  _invokeLambda(i) {
    return BPromise.resolve()
      .then(() => {
        if (typeof this.payload === 'function') {
          return this.payload(i);
        }

        return this.payload;
      })
      .then(payload => {
        return this.lambdaClient
          .invoke({
            FunctionName: this.functionName,
            Payload: JSON.stringify(payload),
            LogType: 'Tail'
          })
          .promise()
          .then(response => {
            const log = Buffer.from(response.LogResult, 'base64').toString('utf8');
            const parsedLog = REPORT_REGEX.exec(log);

            return parsedLog
              ? Math.round(Number(parsedLog[2]))
              : null;
          });
      });
  }

  static _getAverage(durations) {
    const average = durations.reduce((acc, duration) => acc + duration, 0) / durations.length;
    return Math.round(average);
  }

  static _parseCycleResult(cycleResult) {
    const percentiles = PERCENTILES.reduce((memo, i) => {
      return Object.assign(memo, { [i]: percentile(i, cycleResult) });
    }, {});

    return {
      min: Math.min(...cycleResult),
      max: Math.max(...cycleResult),
      avg: Runner._getAverage(cycleResult),
      percentiles
    };
  }

  _cycle(count) {
    return BPromise.resolve()
      .then(() => {
        if (this.warmup && this.concurrency === 1) {
          this.emit('warmup');

          return this._invokeLambda(0);
        }
        return false;
      })
      .delay(this.warmup ? this.delay : 0)
      .then(() => {
        return BPromise.map(Array.from(Array(count)).keys(), i => {
          return BPromise
            .delay(this.concurrency === 1 ? this.delay : 0)
            .then(() => {
              return this._invokeLambda(i + 1);
            })
            .tap(invocationDuration => {
              this.emit('invoke', invocationDuration);
            });
        }, { concurrency: this.concurrency });
      });
  }

  run() {
    return this._getAllocatedMemory()
      .then(originalMemorySize => {
        this.emit('start', originalMemorySize);

        return BPromise.reduce(this.steps, (report, memoryStep) => {
          return this._setAllocatedMemory(memoryStep)
            .then(() => {
              this.emit('step', memoryStep);

              return this._cycle(this.repeats)
                .then(cycleResult => {
                  const parsedResult = Runner._parseCycleResult(cycleResult);

                  this.emit('result', parsedResult);

                  return Object.assign(report, { [memoryStep]: parsedResult });
                });
            });
        }, {})
        .finally(() => {
          this.emit('finish');
          return this._setAllocatedMemory(originalMemorySize);
        });
      });
  }
}

module.exports = Runner;
