/** @flow */
import path from 'path';
import R from 'ramda';
import * as RA from 'ramda-adjunct';
import fs from 'fs-extra';
import { BitIds, BitId } from '../../bit-id';
import { filterObject } from '../../utils';
import type { ExtensionOptions } from '../../extensions/extension';
import CompilerExtension from '../../extensions/compiler-extension';
import TesterExtension from '../../extensions/tester-extension';
import type { EnvExtensionOptions, EnvType, EnvLoadArgsProps } from '../../extensions/env-extension';
import type { PathOsBased, PathLinux } from '../../utils/path';
import {
  BIT_JSON,
  NO_PLUGIN_TYPE,
  COMPILER_ENV_TYPE,
  TESTER_ENV_TYPE,
  DEFAULT_LANGUAGE,
  DEFAULT_BINDINGS_PREFIX,
  DEFAULT_EXTENSIONS,
  PACKAGE_JSON
} from '../../constants';
import logger from '../../logger/logger';
import JSONFile from '../component/sources/json-file';

export type RegularExtensionObject = {
  rawConfig: Object,
  options: ExtensionOptions
};

export type EnvFile = {
  [string]: PathLinux
};

export type EnvExtensionObject = {
  rawConfig: Object,
  options: EnvExtensionOptions,
  files: string[]
};

export type TesterExtensionObject = EnvExtensionObject;

export type CompilerExtensionObject = EnvExtensionObject;

export type Extensions = { [extensionName: string]: RegularExtensionObject };
export type Envs = { [envName: string]: CompilerExtensionObject };
export type Compilers = { [compilerName: string]: CompilerExtensionObject };
export type Testers = { [testerName: string]: TesterExtensionObject };

export type AbstractBitConfigProps = {
  compiler?: string | Compilers,
  tester?: string | Testers,
  dependencies?: Object,
  devDependencies?: Object,
  compilerDependencies?: Object,
  testerDependencies?: Object,
  lang?: string,
  bindingPrefix?: string,
  extensions?: Extensions
};

/**
 * There are two Bit Config: ConsumerBitConfig and ComponentBitConfig, both inherit this class.
 * The config data can be written in package.json inside "bit" property. And, can be written in
 * bit.json file. Also, it might be written in both, in which case, if there is any conflict, the
 * bit.json wins.
 */
export default class AbstractBitConfig {
  path: string;
  _compiler: Compilers | string;
  _tester: Testers | string;
  dependencies: { [string]: string };
  devDependencies: { [string]: string };
  compilerDependencies: { [string]: string };
  testerDependencies: { [string]: string };
  lang: string;
  bindingPrefix: string;
  extensions: Extensions;
  writeToPackageJson = false;
  writeToBitJson = false;

  constructor(props: AbstractBitConfigProps) {
    this._compiler = props.compiler || {};
    this._tester = props.tester || {};
    this.lang = props.lang || DEFAULT_LANGUAGE;
    this.bindingPrefix = props.bindingPrefix || DEFAULT_BINDINGS_PREFIX;
    this.extensions = props.extensions || DEFAULT_EXTENSIONS;
  }

  get compiler(): ?Compilers {
    const compilerObj = transformEnvToObject(this._compiler);
    if (R.isEmpty(compilerObj)) return undefined;
    return compilerObj;
  }

  set compiler(compiler: string | Compilers) {
    this._compiler = transformEnvToObject(compiler);
  }

  get tester(): ?Testers {
    const testerObj = transformEnvToObject(this._tester);
    if (R.isEmpty(testerObj)) return undefined;
    return testerObj;
  }

  set tester(tester: string | Testers) {
    this._tester = transformEnvToObject(tester);
  }

  addDependencies(bitIds: BitId[]): this {
    const idObjects = R.mergeAll(bitIds.map(bitId => bitId.toObject()));
    this.dependencies = R.merge(this.dependencies, idObjects);
    return this;
  }

  addDependency(bitId: BitId): this {
    this.dependencies = R.merge(this.dependencies, bitId.toObject());
    return this;
  }

  hasCompiler(): boolean {
    return !!this.compiler && this._compiler !== NO_PLUGIN_TYPE && !R.isEmpty(this.compiler);
  }

  hasTester(): boolean {
    return !!this.tester && this._tester !== NO_PLUGIN_TYPE && !R.isEmpty(this.tester);
  }

  getEnvsByType(type: EnvType): ?Compilers | ?Testers {
    if (type === COMPILER_ENV_TYPE) {
      return this.compiler;
    }
    return this.tester;
  }

  async loadCompiler(consumerPath: string, scopePath: string, context?: Object): Promise<?CompilerExtension> {
    if (!this.hasCompiler()) {
      return null;
    }

    const compilerP = this.loadEnv(COMPILER_ENV_TYPE, consumerPath, scopePath, CompilerExtension.load, context);
    const compiler: CompilerExtension = ((await compilerP: any): CompilerExtension);
    return compiler;
  }

  async loadTester(consumerPath: string, scopePath: string, context?: Object): Promise<?TesterExtension> {
    if (!this.hasTester()) {
      return null;
    }
    const testerP = this.loadEnv(TESTER_ENV_TYPE, consumerPath, scopePath, TesterExtension.load, context);

    const tester: ?TesterExtension = ((await testerP: any): TesterExtension);
    return tester;
  }

  async loadEnv(
    envType: EnvType,
    consumerPath: string,
    scopePath: string,
    loadFunc: Function,
    context?: Object
  ): Promise<?CompilerExtension | ?TesterExtension> {
    const envs = this.getEnvsByType(envType);
    if (!envs) return undefined;
    // TODO: Gilad - support more than one key of compiler
    const envName = Object.keys(envs)[0];
    const envObject = envs[envName];
    const envProps = getEnvsProps(consumerPath, scopePath, envName, envObject, this.path, envType, context);
    const env = await loadFunc(envProps);
    return env;
  }

  /**
   * before v13, envs were strings of bit-id.
   * to be backward compatible, if an env doesn't have any files/config, convert it to a string
   */
  getBackwardCompatibleEnv(type: EnvType): ?Compilers | ?Testers | ?string {
    const envObj = this.getEnvsByType(type);
    if (!envObj) return undefined;
    if (Object.keys(envObj).length !== 1) return envObj; // it has more than one id, it's >= v13
    const envId = Object.keys(envObj)[0];
    if (
      RA.isNilOrEmpty(envObj[envId].rawConfig) &&
      RA.isNilOrEmpty(envObj[envId].options) &&
      RA.isNilOrEmpty(envObj[envId].files)
    ) {
      return envId;
    }
    return envObj;
  }

  getDependencies(): BitIds {
    return BitIds.fromObject(this.dependencies);
  }

  toPlainObject(): Object {
    const isPropDefaultOrNull = (val, key) => {
      if (!val) return false;
      if (key === 'lang') return val !== DEFAULT_LANGUAGE;
      if (key === 'bindingPrefix') return val !== DEFAULT_BINDINGS_PREFIX;
      if (key === 'extensions') return !R.equals(val, DEFAULT_EXTENSIONS);
      return true;
    };

    return filterObject(
      {
        lang: this.lang,
        bindingPrefix: this.bindingPrefix,
        env: {
          compiler: this.getBackwardCompatibleEnv(COMPILER_ENV_TYPE),
          tester: this.getBackwardCompatibleEnv(TESTER_ENV_TYPE)
        },
        dependencies: this.dependencies,
        extensions: this.extensions
      },
      isPropDefaultOrNull
    );
  }

  async write({ bitDir }: { bitDir: string }): Promise<string[]> {
    const jsonFiles = await this.prepareToWrite({ bitDir });
    return Promise.all(jsonFiles.map(jsonFile => jsonFile.write()));
  }

  async prepareToWrite({ bitDir }: { bitDir: string }): Promise<JSONFile[]> {
    const plainObject = this.toPlainObject();
    const JsonFiles = [];
    const addJsonFile = (pathStr: string, content: Object) => {
      const params = { base: bitDir, override: true, path: pathStr, content };
      JsonFiles.push(JSONFile.load(params));
    };
    if (this.writeToPackageJson) {
      const packageJsonPath = AbstractBitConfig.composePackageJsonPath(bitDir);
      const packageJsonFile = await fs.readJson(packageJsonPath);
      packageJsonFile.bit = plainObject;
      addJsonFile(packageJsonPath, packageJsonFile);
    }
    if (this.writeToBitJson) {
      const bitJsonPath = AbstractBitConfig.composeBitJsonPath(bitDir);
      addJsonFile(bitJsonPath, plainObject);
    }
    return JsonFiles;
  }

  toJson(readable: boolean = true) {
    if (!readable) return JSON.stringify(this.toPlainObject());
    return JSON.stringify(this.toPlainObject(), null, 4);
  }

  static composeBitJsonPath(bitPath: PathOsBased): PathOsBased {
    return path.join(bitPath, BIT_JSON);
  }
  static composePackageJsonPath(bitPath: PathOsBased): PathOsBased {
    return path.join(bitPath, PACKAGE_JSON);
  }

  static async pathHasBitJson(bitPath: string): Promise<boolean> {
    return fs.exists(this.composeBitJsonPath(bitPath));
  }
  static async pathHasPackageJson(bitPath: string): Promise<boolean> {
    return fs.exists(this.composePackageJsonPath(bitPath));
  }

  static async loadJsonFileIfExist(jsonFilePath: string): Promise<?Object> {
    try {
      const file = await fs.readJson(jsonFilePath);
      return file;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  static async removeIfExist(bitPath: string): Promise<boolean> {
    const dirToRemove = this.composeBitJsonPath(bitPath);
    if (fs.exists(dirToRemove)) {
      logger.info(`abstract-bit-config, deleting ${dirToRemove}`);
      return fs.remove(dirToRemove);
    }
    return false;
  }
}

const transformEnvToObject = (env): Envs => {
  if (typeof env === 'string') {
    if (env === NO_PLUGIN_TYPE) return {};
    return {
      [env]: {}
    };
  }
  return env;
};

const getEnvsProps = (
  consumerPath: string,
  scopePath: string,
  envName: string,
  envObject: EnvExtensionObject,
  bitJsonPath: string,
  envType: EnvType,
  context?: Object
): EnvLoadArgsProps => {
  const envProps = {
    name: envName,
    consumerPath,
    scopePath,
    rawConfig: envObject.rawConfig,
    files: envObject.files,
    bitJsonPath,
    options: envObject.options,
    envType,
    context
  };
  return envProps;
};
