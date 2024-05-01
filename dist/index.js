// lib/MTWrapper.js
import fs from "fs";
import child_process from "child_process";
import { format } from "date-fns";

// lib/util.js
var isSet = (value) => value !== void 0 && value !== null;

// lib/MTWrapper.js
var ssync = child_process.spawnSync;
var MTWrapper = class {
  databaseFromOptions(options, defaultDatabase = "backup") {
    let database = defaultDatabase;
    const uri = getOptionOrDefault(options, "uri", null);
    if (uri != null) {
      if (!uri.includes("/")) {
        throw { error: "INVALID_OPTIONS", message: "uri: database name for dump is required." };
      }
      database = uri.includes("?") ? uri.substring(uri.lastIndexOf("/") + 1, uri.indexOf("?")) : uri.substring(uri.lastIndexOf("/") + 1, uri.length);
    } else if ("db" in options && options.db !== "*") {
      database = options.db;
    }
    if (uri === null && (database === null || database === void 0 || database === "")) {
      throw { "error": "INVALID_OPTIONS", "message": "database name for dump is required." };
    }
    if (database === null || database === void 0 || database === "" || database === "*") {
      return "all";
    }
    return database;
  }
  commandConnectFromOptions(options, command = "", isRestore = false) {
    const uri = getOptionOrDefault(options, "uri", null);
    if (uri != null) {
      command += " --uri " + uri;
    } else {
      command += " --host " + getOptionOrDefault(options, "host", "127.0.0.1") + " --port " + getOptionOrDefault(options, "port", 27017);
      if (isOptionSet(options, "username") && isOptionSet(options, "password")) {
        command += " --username " + options.username + " --password " + options.password;
        if ("authDb" in options && options.authDb !== null) {
          command += " --authenticationDatabase " + options.authDb;
        }
      }
      if ("db" in options && options.db !== "*" && (!isRestore || isLegacyRestoreDb())) {
        command += " --db " + options.db;
      } else if (isRestore && !isLegacyRestoreDb() && "db" in options && options.db !== "*" && options.db != null) {
        command += " --nsInclude " + options.db + ".*";
      }
    }
    if (isRestore && !isLegacyRestoreDb() && isOptionSet(options, "dbFrom") && isOptionSet(options, "dbTo") && !isOptionSet(options, "db")) {
      command += " --nsFrom " + options.dbFrom + ".* --nsTo " + options.dbTo + ".*";
    }
    if (isBooleanOptionSet(options, "ssl")) {
      command += " --ssl";
    }
    if (isOptionSet(options, "sslCAFile")) {
      command += " --sslCAFile " + options.sslCAFile;
    }
    if (isOptionSet(options, "sslPEMKeyFile")) {
      command += " --sslPEMKeyFile " + options.sslPEMKeyFile;
    }
    if (isOptionSet(options, "sslPEMKeyPassword")) {
      command += " --sslPEMKeyPassword " + options.sslPEMKeyPassword;
    }
    if (isOptionSet(options, "sslCRLFile")) {
      command += " --sslCRLFile " + options.sslCRLFile;
    }
    if (isBooleanOptionSet(options, "sslFIPSMode")) {
      command += " --sslFIPSMode";
    }
    if (isBooleanOptionSet(options, "tlsInsecure")) {
      command += " --tlsInsecure";
    }
    return command;
  }
  commandDumpCollectionsFromOptions(options, command) {
    if (isOptionSet(options, "collection") && isOptionSet(options, "includeCollections")) {
      throw {
        error: "INVALID_OPTIONS",
        message: 'please remove deprecated "includeCollections" option and use "collection" only.'
      };
    }
    if (isOptionSet(options, "collection") && !isSingleValue(options.collection)) {
      throw { error: "INVALID_OPTIONS", message: '"collection" option must be a single value.' };
    }
    if (isOptionSet(options, "includeCollections") && isOptionSet(options, "excludeCollections")) {
      throw {
        error: "INVALID_OPTIONS",
        message: '"excludeCollections" option is not allowed when "includeCollections" is specified.'
      };
    }
    if (isOptionSet(options, "collection") && isOptionSet(options, "excludeCollections")) {
      throw {
        error: "INVALID_OPTIONS",
        message: '"excludeCollections" option is not allowed when "collection" is specified.'
      };
    }
    if (isOptionSet(options, "includeCollections") && Array.isArray(options.includeCollections) && options.includeCollections.length > 0) {
      command += " --collection " + options.includeCollections[options.includeCollections.length - 1];
      console.warn('includeCollections : this option is deprecated, please use "collection" instead');
    }
    if (isOptionSet(options, "collection") && isSingleValue(options.collection)) {
      command += " --collection " + getSingleValue(options.collection);
    }
    if (isOptionSet(options, "excludeCollections") && Array.isArray(options.excludeCollections)) {
      for (const collection of options.excludeCollections) {
        command += " --excludeCollection " + collection;
      }
    }
    return command;
  }
  commandDumpParametersFromOptions(options, command) {
    if (isOptionSet(options, "numParallelCollections")) {
      if (!Number.isInteger(options.numParallelCollections)) {
        throw {
          error: "INVALID_OPTIONS",
          message: '"numParallelCollections" option must be an integer.'
        };
      }
      if (options.numParallelCollections <= 0) {
        throw {
          error: "INVALID_OPTIONS",
          message: '"numParallelCollections" option must be a positive integer.'
        };
      }
      command += " --numParallelCollections " + options.numParallelCollections;
    }
    if (isBooleanOptionSet(options, "viewsAsCollections")) {
      command += " --viewsAsCollections";
    }
    return command;
  }
  mongodump(options) {
    const mt = this;
    return new Promise(function(resolve, reject) {
      if (!("db" in options) && !("uri" in options)) {
        return reject({ error: "INVALID_OPTIONS", message: "db: database name for dump is required." });
      }
      const dumpCmd = getOptionOrDefault(options, "dumpCmd", "mongodump");
      const path3 = getOptionOrDefault(options, "path", "backup");
      if (!fs.existsSync(path3)) {
        fs.mkdirSync(path3, { recursive: true });
      }
      const database = mt.databaseFromOptions(options);
      let command = mt.commandConnectFromOptions(options);
      command = mt.commandDumpCollectionsFromOptions(options, command);
      command = mt.commandDumpParametersFromOptions(options, command);
      const dateTimeSuffix = getNowFormatted();
      const simplifiedName = database.replace(/[^a-zA-Z0-9\\-]/g, "_");
      const fileName = getOptionOrDefault(options, "fileName", `${simplifiedName}__${dateTimeSuffix}.gz`);
      const fullFileName = `${path3}/${fileName}`;
      try {
        command += ` --archive=${fullFileName} --gzip`;
        if ("showCommand" in options && options.showCommand === true) {
          console.log(dumpCmd, command);
        }
        const dump = ssync(dumpCmd, command.split(" ").slice(1));
        if (dump.status === 0) {
          resolve({
            message: `db:${database} - dump created`,
            status: dump.status,
            fileName,
            // re-used by dropbox
            fullFileName,
            stdout: dump.stdout ? dump.stdout.toString() : null,
            stderr: dump.stderr ? dump.stderr.toString() : null
          });
        } else if (dump.error && dump.error.code === "ENOENT") {
          reject({ error: "COMMAND_NOT_FOUND", message: `Binary ${dumpCmd} not found` });
        } else {
          reject({
            error: "COMMAND_ERROR",
            message: dump.error,
            status: dump.status,
            stdout: dump.stdout ? dump.stdout.toString() : null,
            stderr: dump.stderr ? dump.stderr.toString() : null
          });
        }
      } catch (exception) {
        reject({ error: "COMMAND_EXCEPTION", message: exception });
      }
    });
  }
  mongorestore(options, toRestore = null) {
    const mt = this;
    return new Promise((resolve, reject) => {
      const dumpFile = toRestore == null ? options.dumpFile : toRestore;
      if (dumpFile === null || dumpFile === void 0) {
        return reject({ error: "INVALID_OPTIONS", message: "dumpFile: mongo dump file is required." });
      }
      const restoreCmd = getOptionOrDefault(options, "restoreCmd", "mongorestore");
      let command = mt.commandConnectFromOptions(options, "", true);
      if ("dropBeforeRestore" in options && options.dropBeforeRestore === true) {
        command += " --drop";
      }
      command += " --archive=" + dumpFile + " --gzip";
      if ("showCommand" in options && options.showCommand === true) {
        console.log(restoreCmd, command);
      }
      try {
        const restore = ssync(restoreCmd, command.split(" ").slice(1));
        if (restore.status === 0) {
          if ("deleteDumpAfterRestore" in options && options.deleteDumpAfterRestore === true) {
            fs.unlinkSync(dumpFile);
          }
          resolve({
            message: `file: ${dumpFile} restored`,
            dumpFile,
            status: restore.status,
            stdout: restore.stdout.toString(),
            stderr: restore.stderr.toString()
          });
        } else if (restore.error && restore.error.code === "ENOENT") {
          reject({ error: "COMMAND_NOT_FOUND", message: `Binary ${restoreCmd} not found` });
        } else {
          reject({
            error: "COMMAND_ERROR",
            message: restore.error,
            status: restore.status,
            stdout: restore.stdout.toString(),
            stderr: restore.stderr.toString()
          });
        }
      } catch (exception) {
        reject({ error: "COMMAND_EXCEPTION", message: exception });
      }
    });
  }
};
function getNowFormatted() {
  return format(/* @__PURE__ */ new Date(), "yyyy--dd_HHMMss");
}
function getOptionOrDefault(options, name, defaultValue) {
  return name in options && isSet(options[name]) ? options[name] : defaultValue;
}
function isOptionSet(options, optionName) {
  return optionName in options && isSet(options[optionName]);
}
function isBooleanOptionSet(options, optionName) {
  return optionName in options && "1" === options[optionName];
}
function isSingleValue(value) {
  return Array.isArray(value) && value.length === 1 || (typeof value === "string" || value instanceof String);
}
function getSingleValue(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}
function isLegacyRestoreDb() {
  return "1" === process.env.MT_MONGO_LEGACY_RESTORE_DB;
}
var MTWrapper_default = MTWrapper;

// lib/MTFilesystem.js
import fs2 from "fs";
import path from "path";
var fsPromise = fs2.promises;
var MTFilesystem = class {
  listFromFilesystem(path3) {
    return new Promise((resolve, reject) => {
      if (!fs2.existsSync(path3)) {
        return reject(new Error(`no dump path ${path3}`));
      }
      fs2.readdir(path3, (err, files) => {
        if (err) {
          return reject(err);
        }
        return resolve(files.map((f) => path3 + "/" + f));
      });
    });
  }
  fileSystemRotation(dryMode, path3, ctimeMsMax, cleanCount, minCount) {
    const mt = this;
    return new Promise((resolve, reject) => {
      if (!fs2.existsSync(path3)) {
        return reject(new Error(`no dump path ${path3}`));
      }
      mt.walk(path3).then((existingBackupsWithStats) => {
        const initialBackupsCount = existingBackupsWithStats.length;
        const deprecatedBackups = mt.filterByDate(existingBackupsWithStats, ctimeMsMax);
        const deprecatedBackupsCount = deprecatedBackups.length;
        mt.backupsToClean(dryMode, deprecatedBackups, cleanCount, minCount).then((deletedBackups) => {
          const cleanedCount = deletedBackups.length;
          const cleanedFiles = deletedBackups.map((db) => db.filePath);
          resolve({ initialBackupsCount, deprecatedBackupsCount, cleanedCount, cleanedFiles });
        });
      }).catch((err) => reject(err));
    });
  }
  async backupsToClean(dryMode, deprecatedBackups, cleanCount, minCount) {
    if (deprecatedBackups === null || deprecatedBackups === void 0 || deprecatedBackups.length <= minCount) {
      return [];
    }
    deprecatedBackups = deprecatedBackups.sort((a, b) => {
      return (a.stats.ctimeMs > b.stats.ctimeMs) - (a.stats.ctimeMs < b.stats.ctimeMs);
    });
    var toDelete = deprecatedBackups.length > minCount ? deprecatedBackups.slice(minCount, Math.min(minCount + cleanCount, deprecatedBackups.length)) : [];
    for (const toDeleteEntry of toDelete) {
      if (!dryMode) {
        await fsPromise.unlink(toDeleteEntry.filePath);
      } else {
        console.log("*dry mode* DELETE", toDeleteEntry.filePath);
      }
    }
    return toDelete;
  }
  filterByDate(filesWithStat, ctimeMsMax) {
    if (filesWithStat === null || filesWithStat === void 0 || filesWithStat.length < 1) {
      return filesWithStat;
    }
    if (ctimeMsMax === null || ctimeMsMax === void 0) {
      return filesWithStat;
    }
    return filesWithStat.filter((fws) => fws.stats.ctimeMs < ctimeMsMax);
  }
  // https://nodejs.org/api/fs.html#fs_dir_read_callback
  // https://stackoverflow.com/questions/2727167/how-do-you-get-a-list-of-the-names-of-all-files-present-in-a-directory-in-node-j
  walk(dir) {
    return new Promise((resolve, reject) => {
      fsPromise.readdir(dir).then((readFiles) => {
        Promise.all(readFiles.map(async (file) => {
          const filePath = path.join(dir, file);
          const stats = await fsPromise.stat(filePath);
          if (stats.isFile())
            return { filePath, stats };
          return null;
        })).then((files) => {
          const allEntries = files.reduce((all, folderContents) => all.concat(folderContents), []);
          resolve(allEntries.filter((e) => e !== null));
        }).catch((err) => reject(err));
      }).catch((err) => reject(err));
    });
  }
};
var MTFilesystem_default = MTFilesystem;

// lib/MTOptions.js
var MTOptions = class {
  constructor(options) {
    const LO = "127.0.0.1";
    const opt = options ? options : {};
    this.uri = "uri" in opt ? opt.uri : process.env.MT_MONGO_URI || null;
    this.db = "db" in opt ? opt.db : process.env.MT_MONGO_DB || null;
    this.dbFrom = "dbFrom" in opt ? opt.dbFrom : process.env.MT_MONGO_DB_FROM || null;
    this.dbTo = "dbTo" in opt ? opt.dbTo : process.env.MT_MONGO_DB_TO || null;
    this.host = "host" in opt ? opt.host : process.env.MT_MONGO_HOST || LO;
    this.port = "port" in opt ? opt.port : process.env.MT_MONGO_PORT || 27017;
    this.username = "username" in opt ? opt.username : process.env.MT_MONGO_USER || null;
    this.password = "password" in opt ? opt.password : process.env.MT_MONGO_PWD || null;
    this.authDb = "authDb" in opt ? opt.authDb : process.env.MT_MONGO_AUTH_DB || "admin";
    this.ssl = "ssl" in opt ? opt.ssl : process.env.MT_MONGO_SSL || null;
    this.sslCAFile = "sslCAFile" in opt ? opt.sslCAFile : process.env.MT_MONGO_SSL_CA_FILE || null;
    this.sslPEMKeyFile = "sslPEMKeyFile" in opt ? opt.sslPEMKeyFile : process.env.MT_MONGO_SSL_PEM_KEY_FILE || null;
    this.sslPEMKeyPassword = "sslPEMKeyPassword" in opt ? opt.sslPEMKeyPassword : process.env.MT_MONGO_SSL_PEM_KEY_PASSWORD || null;
    this.sslCRLFile = "sslCRLFile" in opt ? opt.sslCRLFile : process.env.MT_MONGO_SSL_CRL_FILE || null;
    this.sslFIPSMode = "sslFIPSMode" in opt ? opt.sslFIPSMode : process.env.MT_MONGO_SSL_FIPS || null;
    this.tlsInsecure = "tlsInsecure" in opt ? opt.tlsInsecure : process.env.MT_MONGO_TLS_INSECURE || null;
    this.assumeValidPort();
    this.showCommand = "showCommand" in opt ? opt.showCommand : process.env.MT_SHOW_COMMAND === "true";
    this.dumpCmd = "dumpCmd" in opt ? opt.dumpCmd : process.env.MT_MONGODUMP || "mongodump";
    this.path = "path" in opt ? opt.path : process.env.MT_PATH || "backup";
    this.fileName = "fileName" in opt ? opt.fileName : process.env.MT_FILENAME || null;
    this.encrypt = "encrypt" in opt ? opt.encrypt : false;
    this.secret = "secret" in opt ? opt.secret : process.env.MT_SECRET || null;
    this.includeCollections = "includeCollections" in opt ? opt.includeCollections : null;
    this.collection = "collection" in opt ? opt.collection : process.env.MT_COLLECTION || null;
    this.excludeCollections = "excludeCollections" in opt ? opt.excludeCollections : process.env.MT_EXCLUDE_COLLECTIONS || null;
    this.defaultEncryptSuffix = ".enc";
    this.encryptSuffix = "encryptSuffix" in opt ? opt.encryptSuffix : this.defaultEncryptSuffix;
    this.restoreCmd = "restoreCmd" in opt ? opt.restoreCmd : process.env.MT_MONGORESTORE || "mongorestore";
    this.dumpFile = "dumpFile" in opt ? opt.dumpFile : process.env.MT_DUMP_FILE || null;
    this.decrypt = "decrypt" in opt ? opt.decrypt : this.dumpFile && this.dumpFile.endsWith(this.defaultEncryptSuffix) || false;
    this.dropBeforeRestore = "dropBeforeRestore" in opt ? opt.dropBeforeRestore : false;
    this.deleteDumpAfterRestore = "deleteDumpAfterRestore" in opt ? opt.deleteDumpAfterRestore : false;
    this.dropboxLocalPath = "dropboxLocalPath" in opt ? opt.dropboxLocalPath : process.env.MT_DROPBOX_LOCAL_PATH || "dropbox";
    this.dropboxToken = "dropboxToken" in opt ? opt.dropboxToken : process.env.MT_DROPBOX_TOKEN || null;
    this.dropboxAppKey = "dropboxAppKey" in opt ? opt.dropboxAppKey : process.env.MT_DROPBOX_APP_KEY || null;
    this.dropboxAppSecret = "dropboxAppSecret" in opt ? opt.dropboxAppSecret : process.env.MT_DROPBOX_APP_SECRET || null;
    this.dropboxRefreshToken = "dropboxRefreshToken" in opt ? opt.dropboxRefreshToken : process.env.MT_DROPBOX_REFRESH_TOKEN || null;
    this.isDeprecatedDropboxTokenAvailable = isNotEmptyString(this.dropboxToken);
    this.isDropboxRefreshTokenAvailable = areNotEmptyStrings([this.dropboxAppKey, this.dropboxAppSecret, this.dropboxRefreshToken]);
    this.isDropboxEnabled = this.isDeprecatedDropboxTokenAvailable || this.isDropboxRefreshTokenAvailable;
    this.rotationDryMode = "rotationDryMode" in opt ? opt.rotationDryMode : process.env.MT_ROTATION_DRY_MODE === "true";
    this.rotationWindowsDays = "rotationWindowsDays" in opt ? opt.rotationWindowsDays : process.env.MT_ROTATION_WINDOWS_DAYS || 15;
    this.rotationMinCount = "rotationMinCount" in opt ? opt.rotationMinCount : process.env.MT_ROTATION_MIN_COUNT || 2;
    this.rotationCleanCount = "rotationCleanCount" in opt ? opt.rotationCleanCount : process.env.MT_ROTATION_CLEAN_COUNT || 10;
  }
  assumeValidPort() {
    if (isNaN(this.port)) {
      this.port = parseInt(this.port, 10);
    }
    if (isNaN(this.port)) {
      throw new Error(`invalid port ${this.port}`);
    }
  }
  getPath() {
    return "path" in this ? this.path : "backup";
  }
  getDropboxPath() {
    return "/" + this.getPath();
  }
  getDropboxLocalPath() {
    return "dropboxLocalPath" in this ? this.dropboxLocalPath : "dropbox";
  }
};
var isNotEmptyString = (value) => value !== void 0 && typeof value === "string" && value.length > 0;
var areNotEmptyStrings = (arr) => Array.isArray(arr) && arr.length > 0 && arr.reduce((rez, curValue) => rez && isNotEmptyString(curValue), true);

// lib/MTEncrypt.js
import fs3 from "fs";
import crypto from "crypto";
var algorithm = "aes-256-ctr";
var expectedKeyLength = 32;
var iv = "NODE-MONGOTOOLS_";
var MTEncrypt = class {
  encrypt(source, destination, secretKey, removeSource = true) {
    return new Promise((resolve) => {
      if (!secretKey || secretKey.length !== expectedKeyLength) {
        throw new Error(`Encrypt algorithm ${algorithm} require a secret key having ${expectedKeyLength} length`);
      }
      const inStream = fs3.createReadStream(source);
      const encrypt = crypto.createCipheriv(algorithm, secretKey, iv);
      const outFileStream = fs3.createWriteStream(destination);
      inStream.pipe(encrypt).pipe(outFileStream);
      inStream.on("end", () => {
        if (removeSource === true) {
          fs3.unlinkSync(source);
        }
        resolve();
      });
    });
  }
  decrypt(source, destination, secretKey) {
    return new Promise((resolve) => {
      console.info("decrypt " + source + " into " + destination);
      const inStream = fs3.createReadStream(source);
      const decrypt = crypto.createDecipheriv(algorithm, secretKey, iv);
      const outFileStream = fs3.createWriteStream(destination);
      inStream.pipe(decrypt).pipe(outFileStream);
      inStream.on("end", () => {
        resolve();
      });
    });
  }
};
var MTEncrypt_default = MTEncrypt;

// lib/MongoTools.js
var MongoTools = class {
  constructor() {
    this.wrapper = new MTWrapper_default();
    this.fs = new MTFilesystem_default();
    this.enc = new MTEncrypt_default();
  }
  list(opt) {
    const mt = this;
    return new Promise((resolve, reject) => {
      const options = assumeOptions(opt);
      const path3 = options.getPath();
      mt.fs.listFromFilesystem(path3).then((filesystem) => {
        if (!options.isDropboxEnabled) {
          return resolve({ path: path3, filesystem });
        }
      }).catch((err) => reject(err));
    });
  }
  mongodump(opt) {
    const mt = this;
    return new Promise((resolve, reject) => {
      const options = assumeOptions(opt);
      mt.wrapper.mongodump(options).then((dumpResult) => {
        if (options.encrypt === true) {
          mt.encryptDump(options, dumpResult).then((dumpResult2) => {
            mt.uploadOnDropboxIfEnabled(options, dumpResult2, resolve, reject);
          }).catch((err) => reject(err));
        } else {
          mt.uploadOnDropboxIfEnabled(options, dumpResult, resolve, reject);
        }
      }).catch((err) => reject(err));
    });
  }
  uploadOnDropboxIfEnabled(options, dumpResult, resolve, reject) {
    resolve(dumpResult);
  }
  encryptDump(opt, dumpResult) {
    const mt = this;
    return new Promise((resolve, reject) => {
      const secret = opt.secret;
      if (secret === null) {
        return reject(new Error(`secret is required to encrypt dump. ${dumpResult.fullFileName} is not encrypted.`));
      }
      const originalFile = "" + dumpResult.fullFileName;
      dumpResult.fileName += opt.encryptSuffix;
      dumpResult.fullFileName += opt.encryptSuffix;
      mt.enc.encrypt(originalFile, dumpResult.fullFileName, secret).then(() => {
        resolve(dumpResult);
      }).catch((err) => reject(err));
    });
  }
  mongorestore(opt) {
    const options = assumeOptions(opt);
    const path3 = options.getPath();
    const mt = this;
    return new Promise((resolve, reject) => {
      let toRestore = options.dumpFile;
      if (!toRestore) {
        return reject(new Error("dumpFile is required"));
      }
      mt.decryptAndRestore(options, toRestore, resolve, reject);
    });
  }
  decryptAndRestore(options, toRestore, resolve, reject) {
    if (options.decrypt === true) {
      this.decryptDump(options, toRestore).then((toRestore2) => {
        this.wrapper.mongorestore(options, toRestore2).then(resolve).catch((err) => reject(err));
      }).catch((err) => reject(err));
    } else {
      this.wrapper.mongorestore(options, toRestore).then(resolve).catch((err) => reject(err));
    }
  }
  decryptDump(opt, dumpFilename) {
    const mt = this;
    return new Promise((resolve, reject) => {
      const secret = opt.secret;
      if (secret === null) {
        return reject(new Error(`secret is required to decrypt dump. ${dumpFilename} is not decrypted.`));
      }
      const suffix = opt.encryptSuffix;
      const originalFile = "" + dumpFilename;
      const decryptedFile = originalFile.endsWith(suffix) ? "" + originalFile.slice(0, -suffix.length) : originalFile;
      mt.enc.decrypt(originalFile, decryptedFile, secret).then(() => {
        resolve(decryptedFile);
      }).catch((err) => reject(err));
    });
  }
  rotation(opt) {
    const options = assumeOptions(opt);
    const rotationDryMode = "rotationDryMode" in options ? options.rotationDryMode : false;
    const windowsDays = "rotationWindowsDays" in options ? options.rotationWindowsDays : 15;
    const minCount = "rotationMinCount" in options ? options.rotationMinCount : 2;
    const cleanCount = "rotationCleanCount" in options ? options.rotationCleanCount : 10;
    try {
      assumeInt(windowsDays, 0, null, "rotationWindowsDays: must be an integer greater than or equal to 0");
      assumeInt(minCount, 0, null, "minCount: must be an integer greater than or equal to 0");
      assumeInt(cleanCount, 0, null, "cleanCount: must be an integer greater than or equal to 0");
    } catch (validationError) {
      return Promise.reject({ error: "INVALID_OPTIONS", message: validationError });
    }
    const path3 = options.getPath();
    const ctimeMsMax = /* @__PURE__ */ new Date();
    ctimeMsMax.setDate(ctimeMsMax.getDate() - windowsDays);
    const ctimeMsMaxMs = ctimeMsMax.getTime();
    const mt = this;
    return new Promise((resolve, reject) => {
      mt.fs.fileSystemRotation(rotationDryMode, path3, ctimeMsMaxMs, cleanCount, minCount).then((filesystemRotationResult) => {
        resolve({ filesystem: filesystemRotationResult });
      }).catch((err) => reject(err));
    });
  }
};
function assumeInt(value, intMin, intMax, errorMsg) {
  if (isNaN(value) || intMin !== null && value < intMin || intMax !== null && value > intMax) {
    throw errorMsg;
  }
}
function assumeOptions(options) {
  if (options === null || options === void 0 || !(options instanceof MTOptions)) {
    return new MTOptions(options);
  }
  return options;
}
var MongoTools_default = MongoTools;

// lib/MTCommand.js
import path2 from "path";
var MTCommand = class {
  constructor() {
    this.mt = new MongoTools_default();
  }
  /**
   * pick filename only from full file+path string
   */
  filenameOnly(fullName) {
    return fullName ? fullName.substring(fullName.lastIndexOf(path2.sep) + 1, fullName.length) : "";
  }
  /**
   * help user on usage
   */
  printUsage() {
    const launchCmd = this.filenameOnly(process.argv[0]) + " " + this.filenameOnly(process.argv[1]);
    console.log("Usage:	" + launchCmd + " <options|list|dump|dumpz|restore backup/myFile.gz|rotation>");
  }
  logOutput(result) {
    if (result.stdout) {
      console.info("stdout:", result.stdout);
    }
    if (result.stderr) {
      console.error("stderr:", result.stderr);
    }
  }
  logSuccess(success) {
    this.logOutput(success);
    if (success.message && success.fullFileName) {
      console.info(`OK ${success.message} - local dump:${success.fullFileName}`);
    } else if (success.message) {
      console.info(`OK ${success.message}`);
    } else {
      console.info(`OK ${JSON.stringify(success, null, 4)}`);
    }
  }
  logError(err) {
    if (err && err.status) {
      console.error(`Error ${err.status} ${JSON.stringify(err.error, null, 4)}`);
    } else if (err && err.message) {
      console.error(`Error ${err.message}`);
    } else if (err && err.text) {
      console.error(`Error ${err.text}`);
    } else {
      console.error(`Error ${JSON.stringify(err, null, 4)}`);
    }
    this.logOutput(err);
  }
  doAction(action = "list") {
    const cmd = this;
    if (!["options", "list", "dump", "dumpz", "restore", "rotation"].includes(action)) {
      this.printUsage();
      return;
    }
    if (action === "options") {
      console.log(JSON.stringify(new MTOptions(), null, 2));
    }
    if (action === "list") {
      this.mt.list(new MTOptions()).then((listResult) => {
        console.log(JSON.stringify(listResult, null, 4));
      }).catch((error) => cmd.logError(error.message));
      return;
    }
    if (action === "dumpz") {
      this.mt.mongodump(new MTOptions({
        "encrypt": true
      })).then(cmd.logSuccess.bind(cmd)).catch((error) => cmd.logError(error.message));
      return;
    }
    if (action === "dump") {
      this.mt.mongodump(new MTOptions({})).then(cmd.logSuccess.bind(cmd)).catch((error) => cmd.logError(error.message));
      return;
    }
    if (action === "restore") {
      if (process.argv.slice(2).length !== 2) {
        this.printUsage();
        return;
      }
      const restoreFile = process.argv.slice(2)[1];
      this.mt.mongorestore(new MTOptions({
        dumpFile: restoreFile,
        dropBeforeRestore: false,
        deleteDumpAfterRestore: false
      })).then(cmd.logSuccess.bind(cmd)).catch((error) => cmd.logError(error.message));
      return;
    }
    if (action === "rotation") {
      this.mt.rotation(new MTOptions()).then(cmd.logSuccess.bind(cmd)).catch((error) => cmd.logError(error.message));
    }
  }
};
var MTCommand_default = MTCommand;
export {
  MTCommand_default as MTCommand,
  MTOptions,
  MongoTools_default as MongoTools
};
