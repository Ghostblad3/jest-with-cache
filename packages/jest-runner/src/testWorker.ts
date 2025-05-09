/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// eslint-disable-next-line no-restricted-imports
import {constants} from 'fs';
import {writeFile, readFile, access} from 'fs/promises';
import {addOtherMap}  from 'jest-resolve';
import exit = require('exit');
import type {
  SerializableError,
  TestFileEvent,
  TestResult,
} from '@jest/test-result';
import type {Config} from '@jest/types';
import HasteMap, {SerializableModuleMap} from 'jest-haste-map';
import {separateMessageFromStack} from 'jest-message-util';
import type Resolver from 'jest-resolve';
import Runtime from 'jest-runtime';
import {messageParent} from 'jest-worker';
import runTest from './runTest';
import type {ErrorWithCode, TestRunnerSerializedContext} from './types';

export type SerializableResolver = {
  config: Config.ProjectConfig;
  serializableModuleMap: SerializableModuleMap;
};

type WorkerData = {
  config: Config.ProjectConfig;
  globalConfig: Config.GlobalConfig;
  path: string;
  context: TestRunnerSerializedContext;
};

async function saveMapToFile(
  fileName: string,
  map: Map<string, {lastModified: number; content: string | object}>,
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
  }catch (e){
    return '[]';
  }
}

function convertToMap(data: string) {
  const array = JSON.parse(data) as Array<{name:string, content:string, lastModified: number}>;
  const map = new Map<string, {content: string, lastModified:number}>();

  for (const item of array) {
    map.set(item.name, {
      content: item.content,
      lastModified: item.lastModified,
    });
  }

  return map;
}

function convertToOtherMap(data: string) {
  const array = JSON.parse(data) as Array<{name:string, content:object, lastModified: number}>;
  const map = new Map<string, {content: object, lastModified:number}>();

  for (const item of array) {
    map.set(item.name, {
      content: item.content,
      lastModified: item.lastModified,
    });
  }

  return map;
}

let dbMap: Map<string, {content: string; lastModified: number}> | null = null;
let otherMap: Map<string, {content: object; lastModified: number}> | null = null;
let lock = false;
class Mutex {
  private _locked: boolean;
  private _waiting: Array<any>;
  constructor() {
    this._locked = false;
    this._waiting = [];
  }

  lock() {
    return new Promise(resolve => {
      if (!this._locked) {
        this._locked = true;
        resolve(null);
      } else {
        this._waiting.push(resolve);
      }
    });
  }

  unlock() {
    if (this._waiting.length > 0) {
      const resolve = this._waiting.shift();
      resolve();
    } else {
      this._locked = false;
    }
  }
}
const mutex = new Mutex();

// Make sure uncaught errors are logged before we exit.
process.on('uncaughtException', err => {
  console.error(err.stack);
  exit(1);
});

const formatError = (error: string | ErrorWithCode): SerializableError => {
  if (typeof error === 'string') {
    const {message, stack} = separateMessageFromStack(error);
    return {
      message,
      stack,
      type: 'Error',
    };
  }

  return {
    code: error.code || undefined,
    message: error.message,
    stack: error.stack,
    type: 'Error',
  };
};

const resolvers = new Map<string, Resolver>();
const getResolver = (config: Config.ProjectConfig) => {
  const resolver = resolvers.get(config.id);
  if (!resolver) {
    throw new Error(`Cannot find resolver for: ${config.id}`);
  }
  return resolver;
};

export function setup(setupData: {
  serializableResolvers: Array<SerializableResolver>;
}): void {
  // Module maps that will be needed for the test runs are passed.
  for (const {
    config,
    serializableModuleMap,
  } of setupData.serializableResolvers) {
    const moduleMap = HasteMap.getStatic(config).getModuleMapFromJSON(
      serializableModuleMap,
    );
    resolvers.set(config.id, Runtime.createResolver(config, moduleMap));
  }
}

const sendMessageToJest: TestFileEvent = (eventName, args) => {
  messageParent([eventName, args]);
};

export async function worker({
  config,
  globalConfig,
  path,
  context,
}: WorkerData): Promise<TestResult> {
  if (!dbMap) {
    const data = await readFileAsync('./output.json');
    dbMap = convertToMap(data);
  }

  if (!otherMap){
    const data = await readFileAsync('./other.json');
    otherMap = convertToOtherMap(data);
    addOtherMap(otherMap);
  }

  try {
    return await runTest(
      path,
      globalConfig,
      config,
      getResolver(config),
      {
        ...context,
        changedFiles: context.changedFiles && new Set(context.changedFiles),
        sourcesRelatedToTestsInChangedFiles:
          context.sourcesRelatedToTestsInChangedFiles &&
          new Set(context.sourcesRelatedToTestsInChangedFiles),
      },
      sendMessageToJest,
      dbMap
    );
  } catch (error: any) {
    throw formatError(error);
  }
}

process.on('beforeExit', async () => {
  if (!dbMap || !otherMap) return;

  await mutex.lock();
  if (lock) {
    mutex.unlock();
    return;
  }
  lock = true;
  mutex.unlock();

  try {
    const randomPart = Math.floor(Math.random() * (10000000000 - 1000000000 + 1)) + 1000000000;
    const name = `./temp-output-${
      randomPart
    }.json`;
    const otherName = `./pmet-other-${randomPart}.json`;
    await saveMapToFile(name, dbMap);
    await saveMapToFile(otherName, otherMap);
    // eslint-disable-next-line no-console
    console.log(`Database saved as ${name}`);
  } catch (error) {
    console.error('Error during exit handler:', error);
  }
});
