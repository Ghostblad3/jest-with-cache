/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {exec} from 'child_process';
import { constants } from "fs";
import {readFile, stat, writeFile, access, readdir} from 'fs/promises';
import * as path from 'path';
import chalk = require('chalk');
import Emittery = require('emittery');
import pLimit = require('p-limit');
import type {
  Test,
  TestEvents,
  TestFileEvent,
  TestResult,
} from '@jest/test-result';
import {deepCyclicCopy} from 'jest-util';
import type {TestWatcher} from 'jest-watcher';
import {JestWorkerFarm, PromiseWithCustomMessage, Worker} from 'jest-worker';
import runTest from './runTest';
import type {SerializableResolver} from './testWorker';
import {EmittingTestRunner, TestRunnerOptions, UnsubscribeFn} from './types';


export type {Test, TestEvents} from '@jest/test-result';
export type {Config} from '@jest/types';
export type {TestWatcher} from 'jest-watcher';
export {CallbackTestRunner, EmittingTestRunner} from './types';
export type {
  CallbackTestRunnerInterface,
  EmittingTestRunnerInterface,
  OnTestFailure,
  OnTestStart,
  OnTestSuccess,
  TestRunnerContext,
  TestRunnerOptions,
  JestTestRunner,
  UnsubscribeFn,
} from './types';

type TestWorker = typeof import('./testWorker');

async function getTempDbFilesFromFolder(pattern: string) {
  const folderPath = process.cwd();
  const files = await readdir('./');
  return files
    .filter(file => file.includes(pattern) && file.endsWith('.json'))
    .map(file => path.join(folderPath, file));
}

async function combine(tempDbFiles: Array<string>) {
  const merged: Map<string, {content: string; lastModified: number}> = new Map();
  for (const dbFile of tempDbFiles) {
    const data = await readFile(dbFile, 'utf8');
    const jsonData = JSON.parse(data) as Array<{name: string, content:string, lastModified:number}>;
    if (merged.size === 0) {
      for (const item of jsonData) {
        merged.set(item.name, {
          content: item.content,
          lastModified: item.lastModified,
        });
      }
    } else {
      for (const item of jsonData) {
        const name = item.name;
        const lastModified = item.lastModified;
        const content = item.content;

        const existing = merged.get(name);
        if (existing) {
          if (lastModified > existing.lastModified) {
            merged.set(name, {content, lastModified});
          }
        } else {
          merged.set(name, {content, lastModified});
        }
      }
    }
  }

  return merged;
}

async function saveMapToFile(
  fileName: string,
  map: Map<string, {lastModified: number; content: string}>,
) {
  const array = Array.from(map, ([key, value]) => ({
    content: value.content,
    lastModified: value.lastModified,
    name: key,
  }));

  const jsonString = JSON.stringify(array, null, 1);
  await writeFile(fileName, jsonString, 'utf8');
  // eslint-disable-next-line no-console
  console.log('Saved map to file:', fileName);
}

async function readFileAsync(fileName: string) {
  try {
    await access(fileName, constants.F_OK);
    return await readFile(fileName, 'utf8');
  } catch {
    return '[]';
  }
}

function convertToMap(
  data: string,
): Map<string, {content: string; lastModified: number}> {
  const array = JSON.parse(data) as Array<{name:string; content: string; lastModified: number}>;
  const map = new Map<string, {content: string; lastModified: number}>();

  for (const item of array) {
    map.set(item.name, {
      content: item.content,
      lastModified: item.lastModified,
    });
  }

  return map;
}

async function deleteTempFiles(tempDbFiles: Array<string>) {
  try {
    await Promise.all(
      tempDbFiles.map(async item => {
        try {
          const filePath = item;
          // eslint-disable-next-line no-console
          console.log(`Attempting to delete: ${filePath}`);

          await new Promise((resolve, reject) => {
            exec(`del /f "${filePath}"`, (err, _stdout, stderr) => {
              if (err) {
                console.error(`Error deleting file: ${filePath}. ${stderr}`);
                reject(err);
              } else {
                // eslint-disable-next-line no-console
                console.log(`Deleted: ${filePath}`);
                resolve(null);
              }
            });
          });
        } catch (err: any) {
          console.error(
            `Failed to delete file: ${item}. Error: ${err.message}`,
          );
        }
      }),
    );
  } catch (err: any) {
    console.error(`Error during file deletion process: ${err.message}`);
    throw err; // Re-throw the error if needed
  }
}

export default class TestRunner extends EmittingTestRunner {
  readonly #eventEmitter = new Emittery<TestEvents>();

  async runTests(
    tests: Array<Test>,
    watcher: TestWatcher,
    options: TestRunnerOptions,
  ): Promise<void> {
    console.time('Read module cache from disk');
    const data = await readFileAsync('./output.json');
    console.timeEnd('Read module cache from disk');

    //const otherData = await readFileAsync('./other.json');

    console.time('Build cache Map');
    const dbMap = convertToMap(data);
    console.timeEnd('Build cache Map');

    //const otherDataMap = convertToMap(otherData);

    console.time('Invalidate cache');
    try {
      await Promise.allSettled(
        [...dbMap.entries()].map(async ([key, value]) => {
          try {
            const stats = await stat(key);
            const mtime = stats.mtime.getTime();

            if (mtime !== value.lastModified) {
              const content = await readFile(key, 'utf8');
              dbMap.set(key, {content, lastModified: mtime});
            }
          } catch {
            dbMap.delete(key);
          }
        }),
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(e);
      throw new Error(`Error reading file: ${e}`);
    }
    console.timeEnd('Invalidate cache');

    if (options.serial) {
      await this.#createInBandTestRun(tests, watcher, dbMap);

      console.time('Save cache to disk');
      await saveMapToFile('./output.json', dbMap);
      console.timeEnd('Save cache to disk');
    } else {
      console.time('Save cache to disk');
      await saveMapToFile('./output.json', dbMap);
      console.timeEnd('Save cache to disk');

      await this.#createParallelTestRun(tests, watcher);

      const tempDbFiles = await getTempDbFilesFromFolder('temp-output');

      console.time('Combine worker caches');
      const combinedMap = await combine(tempDbFiles);
      console.timeEnd('Combine worker caches');

      console.time('Save cache to disk');
      await saveMapToFile('./output.json', combinedMap);
      console.timeEnd('Save cache to disk');

      await deleteTempFiles(tempDbFiles);

      console.time('Combine other data caches')
      const tempOtherDbFiles = await getTempDbFilesFromFolder('pmet-other');
      const combinedOtherMap = await combine(tempOtherDbFiles);
      await saveMapToFile('./other.json', combinedOtherMap);
      console.timeEnd('Combine other data caches')

      await deleteTempFiles(tempOtherDbFiles);
    }

    // eslint-disable-next-line no-console
    console.log('Tests finished, exiting...');

    return Promise.resolve();
  }

  async #createInBandTestRun(
    tests: Array<Test>,
    watcher: TestWatcher,
    dbMap: Map<string, {lastModified: number; content: string}>,
  ) {
    process.env.JEST_WORKER_ID = '1';
    const mutex = pLimit(1);
    return tests.reduce(
      (promise, test) =>
        mutex(() =>
          promise
            .then(async () => {
              if (watcher.isInterrupted()) {
                throw new CancelRun();
              }

              // `deepCyclicCopy` used here to avoid mem-leak
              const sendMessageToJest: TestFileEvent = (eventName, args) =>
                this.#eventEmitter.emit(
                  eventName,
                  deepCyclicCopy(args, {keepPrototype: false}),
                );

              await this.#eventEmitter.emit('test-file-start', [test]);

              return runTest(
                test.path,
                this._globalConfig,
                test.context.config,
                test.context.resolver,
                this._context,
                sendMessageToJest,
                dbMap,
              );
            })
            .then(
              result =>
                this.#eventEmitter.emit('test-file-success', [test, result]),
              error =>
                this.#eventEmitter.emit('test-file-failure', [test, error]),
            ),
        ),
      Promise.resolve(),
    );
  }

  async #createParallelTestRun(tests: Array<Test>, watcher: TestWatcher) {
    const resolvers: Map<string, SerializableResolver> = new Map();
    for (const test of tests) {
      if (!resolvers.has(test.context.config.id)) {
        resolvers.set(test.context.config.id, {
          config: test.context.config,
          serializableModuleMap: test.context.moduleMap.toJSON(),
        });
      }
    }

    const worker = new Worker(require.resolve('./testWorker'), {
      enableWorkerThreads: this._globalConfig.workerThreads,
      exposedMethods: ['worker'],
      forkOptions: {serialization: 'json', stdio: 'pipe'},
      // The workerIdleMemoryLimit should've been converted to a number during
      // the normalization phase.
      idleMemoryLimit:
        typeof this._globalConfig.workerIdleMemoryLimit === 'number'
          ? this._globalConfig.workerIdleMemoryLimit
          : undefined,
      maxRetries: 3,
      numWorkers: this._globalConfig.maxWorkers,
      setupArgs: [{serializableResolvers: Array.from(resolvers.values())}],
    }) as JestWorkerFarm<TestWorker>;

    if (worker.getStdout()) worker.getStdout().pipe(process.stdout);
    if (worker.getStderr()) worker.getStderr().pipe(process.stderr);

    const mutex = pLimit(this._globalConfig.maxWorkers);

    // Send test suites to workers continuously instead of all at once to track
    // the start time of individual tests.
    const runTestInWorker = (test: Test) =>
      mutex(async () => {
        if (watcher.isInterrupted()) {
          return Promise.reject();
        }

        await this.#eventEmitter.emit('test-file-start', [test]);

        const promise = worker.worker({
          config: test.context.config,
          context: {
            ...this._context,
            changedFiles:
              this._context.changedFiles &&
              Array.from(this._context.changedFiles),
            sourcesRelatedToTestsInChangedFiles:
              this._context.sourcesRelatedToTestsInChangedFiles &&
              Array.from(this._context.sourcesRelatedToTestsInChangedFiles),
          },
          globalConfig: this._globalConfig,
          path: test.path,
        }) as PromiseWithCustomMessage<TestResult>;

        if (promise.UNSTABLE_onCustomMessage) {
          // TODO: Get appropriate type for `onCustomMessage`
          promise.UNSTABLE_onCustomMessage(([event, payload]: any) =>
            this.#eventEmitter.emit(event, payload),
          );
        }

        return promise;
      });

    const onInterrupt = new Promise((_, reject) => {
      watcher.on('change', state => {
        if (state.interrupted) {
          reject(new CancelRun());
        }
      });
    });

    const runAllTests = Promise.all(
      tests.map(test =>
        runTestInWorker(test).then(
          result =>
            this.#eventEmitter.emit('test-file-success', [test, result]),
          error => this.#eventEmitter.emit('test-file-failure', [test, error]),
        ),
      ),
    );

    const cleanup = async () => {
      const {forceExited} = await worker.end();
      if (forceExited) {
        console.error(
          chalk.yellow(
            'A worker process has failed to exit gracefully and has been force exited. ' +
              'This is likely caused by tests leaking due to improper teardown. ' +
              'Try running with --detectOpenHandles to find leaks. ' +
              'Active timers can also cause this, ensure that .unref() was called on them.',
          ),
        );
      }
    };

    return Promise.race([runAllTests, onInterrupt]).then(cleanup, cleanup);
  }

  on<Name extends keyof TestEvents>(
    eventName: Name,
    listener: (eventData: TestEvents[Name]) => void | Promise<void>,
  ): UnsubscribeFn {
    return this.#eventEmitter.on(eventName, listener);
  }
}

class CancelRun extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'CancelRun';
  }
}
