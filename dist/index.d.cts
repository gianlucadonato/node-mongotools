import fs from 'fs';
import child_process from 'child_process';
import { format } from 'date-fns';
import path from 'path';
import { Dropbox } from 'dropbox';
import { isAccessTokenValid, refreshAccessToken } from 'dropbox-refresh-token';
import crypto from 'crypto';

const isSet = value=>   value !== undefined && value !== null;

const ssync = child_process.spawnSync;

class MTWrapper {

    databaseFromOptions(options, defaultDatabase = 'backup') {
        let database = defaultDatabase;
        const uri = getOptionOrDefault(options, 'uri', null);
        if (uri != null) {
            if (!uri.includes('/')) {
                throw {error: 'INVALID_OPTIONS', message: 'uri: database name for dump is required.'};
            }
            database = uri.includes('?') ?
                uri.substring(uri.lastIndexOf('/') + 1, uri.indexOf('?')) :
                uri.substring(uri.lastIndexOf('/') + 1, uri.length);
        } else if ('db' in options && options.db !== '*') {
            database = options.db;
        }
        if (uri === null && (database === null || database === undefined || database === '')) {
            throw {"error": 'INVALID_OPTIONS', "message": 'database name for dump is required.'};
        }
        if (database === null || database === undefined || database === '' || database === '*') {
            return "all";
        }
        return database;
    }

    commandConnectFromOptions(options, command = '', isRestore = false) {
        const uri = getOptionOrDefault(options, 'uri', null);
        if (uri != null) {
            command += ' --uri ' + uri;
        } else {
            command += ' --host ' + getOptionOrDefault(options, 'host', '127.0.0.1') +
                ' --port ' + getOptionOrDefault(options, 'port', 27017);
            if (isOptionSet(options, 'username') && isOptionSet(options, 'password')) {
                command += ' --username ' + options.username +
                    ' --password ' + options.password;
                if ('authDb' in options && options.authDb !== null) {
                    command += ' --authenticationDatabase ' + options.authDb;
                }
            }
            if ('db' in options && options.db !== '*' && (!isRestore || isLegacyRestoreDb())) {// keep legacy capability
                command += ' --db ' + options.db;// deprecated for mongorestore: will produce additional deprecated stderr
            } else if (isRestore && !isLegacyRestoreDb() && 'db' in options && options.db !== '*' && options.db != null) {
                command += ' --nsInclude ' + options.db + '.*';
            }
        }
        if (isRestore && !isLegacyRestoreDb()
            && isOptionSet(options, 'dbFrom')
            && isOptionSet(options, 'dbTo')
            && !isOptionSet(options, 'db')) {
            command += ' --nsFrom ' + options.dbFrom + '.*' + ' --nsTo ' + options.dbTo + '.*';
        }
        if (isBooleanOptionSet(options, 'ssl')) {
            command += ' --ssl';
        }
        if (isOptionSet(options, 'sslCAFile')) {
            command += ' --sslCAFile ' + options.sslCAFile;
        }
        if (isOptionSet(options, 'sslPEMKeyFile')) {
            command += ' --sslPEMKeyFile ' + options.sslPEMKeyFile;
        }
        if (isOptionSet(options, 'sslPEMKeyPassword')) {
            command += ' --sslPEMKeyPassword ' + options.sslPEMKeyPassword;
        }
        if (isOptionSet(options, 'sslCRLFile')) {
            command += ' --sslCRLFile ' + options.sslCRLFile;
        }
        if (isBooleanOptionSet(options, 'sslFIPSMode')) {
            command += ' --sslFIPSMode';
        }
        if (isBooleanOptionSet(options, 'tlsInsecure')) {
            command += ' --tlsInsecure';
        }
        return command;
    }

    commandDumpCollectionsFromOptions(options, command) {
        // deprecated includeCollections
        if (isOptionSet(options, 'collection') && isOptionSet(options, 'includeCollections')) {
            throw {
                error: 'INVALID_OPTIONS',
                message: 'please remove deprecated "includeCollections" option and use "collection" only.'
            };
        }
        if (isOptionSet(options, 'collection') && !isSingleValue(options.collection)) {
            throw {error: 'INVALID_OPTIONS', message: '"collection" option must be a single value.'};
        }
        // deprecated includeCollections
        if (isOptionSet(options, 'includeCollections') && isOptionSet(options, 'excludeCollections')) {
            throw {
                error: 'INVALID_OPTIONS',
                message: '"excludeCollections" option is not allowed when "includeCollections" is specified.'
            };
        }
        if (isOptionSet(options, 'collection') && isOptionSet(options, 'excludeCollections')) {
            throw {
                error: 'INVALID_OPTIONS',
                message: '"excludeCollections" option is not allowed when "collection" is specified.'
            };
        }

        // deprecated includeCollections
        if (isOptionSet(options, 'includeCollections') && Array.isArray(options.includeCollections) && options.includeCollections.length > 0) {
            command += ' --collection ' + options.includeCollections[options.includeCollections.length - 1];// take only last value
            console.warn('includeCollections : this option is deprecated, please use "collection" instead');
        }

        if (isOptionSet(options, 'collection') && isSingleValue(options.collection)) {
            command += ' --collection ' + getSingleValue(options.collection);
        }

        if (isOptionSet(options, 'excludeCollections') && Array.isArray(options.excludeCollections)) {
            for (const collection of options.excludeCollections) {
                command += ' --excludeCollection ' + collection;
            }
        }
        return command;
    }

    commandDumpParametersFromOptions(options, command) {
        if (isOptionSet(options, 'numParallelCollections')) {
            if (!Number.isInteger(options.numParallelCollections)) {
                throw {
                    error: 'INVALID_OPTIONS',
                    message: '"numParallelCollections" option must be an integer.'
                };
            }
            if (options.numParallelCollections <= 0) {
                throw {
                    error: 'INVALID_OPTIONS',
                    message: '"numParallelCollections" option must be a positive integer.'
                };
            }
            command += ' --numParallelCollections ' + options.numParallelCollections;
        }

        if (isBooleanOptionSet(options, 'viewsAsCollections')) {
            command += ' --viewsAsCollections';
        }

        return command;
    }

    mongodump(options) {
        const mt = this;
        return new Promise(function (resolve, reject) {
            if (!('db' in options) && !('uri' in options)) {
                return reject({error: 'INVALID_OPTIONS', message: 'db: database name for dump is required.'});
            }
            const dumpCmd = getOptionOrDefault(options, 'dumpCmd', 'mongodump');
            const path = getOptionOrDefault(options, 'path', 'backup');
            // create path if not exist
            if (!fs.existsSync(path)) {
                fs.mkdirSync(path, {recursive: true});
            }

            const database = mt.databaseFromOptions(options);
            let command = mt.commandConnectFromOptions(options);
            command = mt.commandDumpCollectionsFromOptions(options, command);
            command = mt.commandDumpParametersFromOptions(options, command);

            const dateTimeSuffix = getNowFormatted();
            const simplifiedName = database.replace(/[^a-zA-Z0-9\\-]/g, '_');
            const fileName = getOptionOrDefault(options, 'fileName', `${simplifiedName}__${dateTimeSuffix}.gz`);
            const fullFileName = `${path}/${fileName}`;

            try {// launch mongodump
                command += ` --archive=${fullFileName} --gzip`;
                if ('showCommand' in options && options.showCommand === true) {
                    console.log(dumpCmd, command);
                }
                const dump = ssync(dumpCmd, command.split(' ').slice(1));
                if (dump.status === 0) {
                    resolve({
                        message: `db:${database} - dump created`,
                        status: dump.status,
                        fileName,// re-used by dropbox
                        fullFileName,
                        stdout: dump.stdout ? dump.stdout.toString() : null,
                        stderr: dump.stderr ? dump.stderr.toString() : null
                    });
                } else if (dump.error && dump.error.code === "ENOENT") {
                    reject({error: 'COMMAND_NOT_FOUND', message: `Binary ${dumpCmd} not found`});
                } else {
                    reject({
                        error: 'COMMAND_ERROR', message: dump.error,
                        status: dump.status,
                        stdout: dump.stdout ? dump.stdout.toString() : null,
                        stderr: dump.stderr ? dump.stderr.toString() : null
                    });
                }
            } catch (exception) {
                reject({error: 'COMMAND_EXCEPTION', message: exception});
            }
        });
    }

    mongorestore(options, toRestore = null) {
        const mt = this;
        return new Promise((resolve, reject) => {
            const dumpFile = toRestore == null ? options.dumpFile : toRestore;
            if (dumpFile === null || dumpFile === undefined) {
                return reject({error: 'INVALID_OPTIONS', message: 'dumpFile: mongo dump file is required.'});
            }

            const restoreCmd = getOptionOrDefault(options, 'restoreCmd', 'mongorestore');
            let command = mt.commandConnectFromOptions(options, "", true);

            if ('dropBeforeRestore' in options && options.dropBeforeRestore === true) {
                command += ' --drop';
            }
            command += ' --archive=' + dumpFile + ' --gzip';

            if ('showCommand' in options && options.showCommand === true) {
                console.log(restoreCmd, command);
            }
            // launch mongorestore
            try {
                const restore = ssync(restoreCmd, command.split(' ').slice(1));
                if (restore.status === 0) {
                    if ('deleteDumpAfterRestore' in options && options.deleteDumpAfterRestore === true) {
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
                    reject({error: 'COMMAND_NOT_FOUND', message: `Binary ${restoreCmd} not found`});
                } else {
                    reject({
                        error: 'COMMAND_ERROR',
                        message: restore.error,
                        status: restore.status,
                        stdout: restore.stdout.toString(),
                        stderr: restore.stderr.toString()
                    });
                }
            } catch (exception) {
                reject({error: 'COMMAND_EXCEPTION', message: exception});
            }
        });
    }
}

//~ private
function getNowFormatted() {
    return format(new Date(), "yyyy--dd_HHMMss");
}

function getOptionOrDefault(options, name, defaultValue) {
    return (name in options && isSet(options[name])) ? options[name] : defaultValue;
}

function isOptionSet(options, optionName) {
    return optionName in options && isSet(options[optionName]);
}

function isBooleanOptionSet(options, optionName) {
    return optionName in options && "1" === options[optionName];
}

function isSingleValue(value) {
    return (Array.isArray(value) && value.length === 1) || (typeof value === 'string' || value instanceof String);
}

function getSingleValue(value) {
    return (Array.isArray(value) && value.length === 1) ? value[0] : value;
}

function isLegacyRestoreDb() {
    return "1" === process.env.MT_MONGO_LEGACY_RESTORE_DB;
}

const fsPromise = fs.promises;

class MTFilesystem {

    listFromFilesystem(path) {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(path)) {
                return reject(new Error(`no dump path ${path}`));
            }
            fs.readdir(path, (err, files) => {
                if (err) {
                    return reject(err);
                }
                return resolve(files.map(f => path + '/' + f));
            });
        });
    }

    fileSystemRotation(dryMode, path, ctimeMsMax, cleanCount, minCount) {
        const mt = this;
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(path)) {
                return reject(new Error(`no dump path ${path}`));
            }
            mt.walk(path)
                .then(existingBackupsWithStats => {
                    const initialBackupsCount = existingBackupsWithStats.length;
                    const deprecatedBackups = mt.filterByDate(existingBackupsWithStats, ctimeMsMax);
                    const deprecatedBackupsCount = deprecatedBackups.length;
                    mt.backupsToClean(dryMode, deprecatedBackups, cleanCount, minCount)
                        .then(deletedBackups => {
                            const cleanedCount = deletedBackups.length;
                            const cleanedFiles = deletedBackups.map(db => db.filePath);
                            // DEBUG // console.log(JSON.stringify({deletedBackups}))
                            resolve({initialBackupsCount, deprecatedBackupsCount, cleanedCount, cleanedFiles});
                        });
                })
                .catch(err => reject(err));

        });
    }

    async backupsToClean(dryMode, deprecatedBackups, cleanCount, minCount) {
        if (deprecatedBackups === null || deprecatedBackups === undefined || deprecatedBackups.length <= minCount) {
            return [];
        }
        // sort by creation date asc
        deprecatedBackups = deprecatedBackups.sort((a, b) => {
            return (a.stats.ctimeMs > b.stats.ctimeMs) - (a.stats.ctimeMs < b.stats.ctimeMs);// ctimeMs asc
        });
        // DEBUG // console.log("fs backupsToClean", {deprecatedBackups, cleanCount, minCount});
        // keep nb to clean
        var toDelete = deprecatedBackups.length > minCount ?
            deprecatedBackups.slice(minCount, Math.min(minCount + cleanCount, deprecatedBackups.length))
            : [];
        // DEBUG // console.log("toDelete", {toDelete});
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
        if (filesWithStat === null || filesWithStat === undefined || filesWithStat.length < 1) {
            return filesWithStat;
        }
        if (ctimeMsMax === null || ctimeMsMax === undefined) {
            return filesWithStat;
        }
        return filesWithStat.filter(fws => fws.stats.ctimeMs < ctimeMsMax);
    }

    // https://nodejs.org/api/fs.html#fs_dir_read_callback
    // https://stackoverflow.com/questions/2727167/how-do-you-get-a-list-of-the-names-of-all-files-present-in-a-directory-in-node-j
    walk(dir) {
        return new Promise((resolve, reject) => {
            fsPromise.readdir(dir).then(readFiles => {
                Promise.all(readFiles.map(async file => {
                    const filePath = path.join(dir, file);
                    const stats = await fsPromise.stat(filePath);
                    if (stats.isFile()) return {filePath, stats};
                    return null;
                })).then(files => {
                    const allEntries = files.reduce((all, folderContents) => all.concat(folderContents), []);
                    resolve(allEntries.filter(e => e !== null));
                }).catch(err => reject(err));
            }).catch(err => reject(err));
        });
    }

}

const MUST_LOG_DEBUG = process.env.MT_DROPBOX_DEBUG === "true" || false;
class MTDropbox {
    // https://github.com/dropbox/dropbox-sdk-js/blob/main/examples/javascript/node/basic.js
    listFromDropbox(options) {
        return new Promise((resolve, reject) => {
            getDropbox(options)
                .then(dbx => {
                    const path = options.getDropboxPath();
                    MUST_LOG_DEBUG && console.log(`Dropbox filesListFolder ${path}:`);
                    dbx.filesListFolder({path})
                        .then(response => {
                            const fileNames = response.result.entries
                                .filter(e => e[".tag"] === "file")
                                .map(e => e.path_lower);
                            resolve(fileNames);
                        })
                        .catch(filesListError => {
                            MUST_LOG_DEBUG && console.log('filesListError', filesListError);
                            const {status, error} = filesListError;
                            if (status === 409) {
                                reject(new Error(`Dropbox path '${path}' dont exist`));
                                return;
                            }
                            const errorMessage = `Dropbox list ${path}: [status:${status}] ${error?.error_summary}`;
                            reject(new Error(errorMessage));
                        });
                })
                .catch(err => reject(err));
        });
    }

    // https://github.com/dropbox/dropbox-sdk-js/blob/main/examples/javascript/node/upload.js
    mongoDumpUploadOnDropbox(options, dumpResult) {
        return new Promise((resolve, reject) => {
            const path = options.getDropboxPath();
            const filename = dumpResult.fileName ? dumpResult.fileName : "mongodump.gz";
            const dbxFilename = path + "/" + filename;
            getDropbox(options)
                .then(dbx => {
                    fs.readFile(dumpResult.fullFileName, (readFileError, contents) => {
                        if (readFileError) {
                            return reject(readFileError);
                        }
                        MUST_LOG_DEBUG && console.log(`Dropbox upload ${dbxFilename}:`);
                        dbx.filesUpload({path: dbxFilename, contents})
                            .then(response => {
                                // DEBUG // console.log(response.result);
                                const {path_display, size} = response.result;
                                dumpResult.dropboxFile = path_display;
                                dumpResult.dropboxFileSize = size;
                                dumpResult.message = dumpResult.message + ` - uploaded on dropbox as ${dumpResult.dropboxFile} (${size} o)`;
                                resolve(dumpResult);
                            })
                            .catch(uploadErr => {
                                MUST_LOG_DEBUG && console.log('uploadErr', uploadErr);
                                const {status, error} = uploadErr;
                                const errorMessage = `Dropbox upload ${dbxFilename}: [status:${status}] ${error?.error_summary}`;
                                reject(new Error(errorMessage));
                            });
                    });
                })
                .catch(err => reject(err));
        })
    }

    // https://github.com/dropbox/dropbox-sdk-js/blob/main/examples/javascript/node/download.js
    mongorestoreDownloadFromDropbox(options) {
        return new Promise( (resolve, reject) => {
            const dbxFullFilename = options.dumpFile;
            const localPath = options.getDropboxLocalPath();
            const fileName = extractFilename(dbxFullFilename);
            const fullFileName = localPath + '/' + fileName;
            if (!dbxFullFilename.startsWith('/')) {
                return reject(new Error(`Dropbox dumpFile ${dbxFullFilename} must start with '/'. Note for Windows users: unalias node and set MSYS_NO_PATHCONV=1 may help.`))
            }
            // create path if not exist
            if (!fs.existsSync(localPath)) {
                fs.mkdirSync(localPath, {recursive: true});
            }
            getDropbox(options)
                .then(dbx => {
                    MUST_LOG_DEBUG && console.log(`Dropbox download ${dbxFullFilename}:`);
                    dbx.filesDownload({"path": dbxFullFilename})
                        .then(response => {
                            // DEBUG // console.log(response.result);
                            fs.writeFileSync(fullFileName, response.result.fileBinary);
                            resolve({
                                message: `dump downloaded into ${fullFileName}`,
                                fileName,
                                fullFileName
                            });
                        })
                        .catch(downloadErr => {
                            MUST_LOG_DEBUG && console.log('downloadErr', downloadErr);
                            const {status, error} = downloadErr;
                            const errorMessage = `Dropbox download ${dbxFullFilename}: [status:${status}] ${error?.error_summary}`;
                            reject(new Error(errorMessage));
                        });
                })
                .catch(err => reject(err));
        });
    }

    rotation(options, dryMode, ctimeMsMax, cleanCount, minCount) {
        const mt = this;
        return new Promise((resolve, reject) => {
            getDropbox(options)
                .then(dbx => {
                    const path = options.getDropboxPath();
                    MUST_LOG_DEBUG && console.log(`Dropbox list ${path}`);
                    dbx.filesListFolder({path})
                        .then(async response => {
                            const result = response.result;
                            // DEBUG // console.log(result);
                            if (result.has_more === true) {
                                return reject(new Error(`dropbox backup directory ${path} has more than 2000 files. Rotation has been skipped`));
                            }
                            const initialBackupsCount = result.length;
                            const deprecatedBackups = result.entries
                                .filter(e => e[".tag"] === "file")
                                .filter(e => new Date(e.client_modified) < new Date(ctimeMsMax))
                                .map(e => {
                                    const {name, path_lower, client_modified} = e;
                                    return {name, path_lower, client_modified};
                                });
                            const deprecatedBackupsCount = deprecatedBackups.length;
                            const deletedBackups = await mt.backupsToClean(dbx, dryMode, deprecatedBackups, cleanCount, minCount);
                            const cleanedCount = deletedBackups.length;
                            const cleanedFiles = deletedBackups.map(db => db.path_lower);
                            // DEBUG //  console.log('fileNames', fileNames)
                            return resolve({initialBackupsCount, deprecatedBackupsCount, cleanedCount, cleanedFiles});
                        })
                        .catch(filesListError => {
                            MUST_LOG_DEBUG && console.log('filesListError', filesListError);
                            const {status, error} = filesListError;
                            const errorMessage = `Dropbox list ${path}: [status:${status}] ${error?.error_summary}`;
                            reject(new Error(errorMessage));
                        });
                })
                .catch(err => reject(err));
        });
    }

    async backupsToClean(dbx, dryMode, deprecatedBackups, cleanCount, minCount) {
        if (deprecatedBackups === null || deprecatedBackups === undefined || deprecatedBackups.length <= minCount) {
            return [];
        }
        // sort by client_modified asc
        deprecatedBackups = deprecatedBackups.sort((a, b) => {
            return (a.client_modified > b.client_modified) - (a.client_modified < b.client_modified);// client_modified asc
        });
        MUST_LOG_DEBUG && console.log("dbx backupsToClean", {deprecatedBackups, cleanCount, minCount});
        // keep nb to clean
        const toDelete = deprecatedBackups.length > minCount ?
            deprecatedBackups.slice(minCount, Math.min(minCount + cleanCount, deprecatedBackups.length))
            : [];
        MUST_LOG_DEBUG && console.log("dbx toDelete", {toDelete});

        for (const toDeleteEntry of toDelete) {
            if (!dryMode) {
                await this.backupDelete(dbx, toDeleteEntry.path_lower)
                    .catch(error => {
                        return Promise.reject(error);
                    });
            } else {
                console.log("*dry mode* DELETE", toDeleteEntry.path_lower);
            }
        }
        return Promise.resolve(toDelete);
    }

    backupDelete(dbx, backupPath) {
        return new Promise((resolve, reject) => {
            dbx.filesDeleteV2({"path": backupPath})
                .then(() => resolve(backupPath))
                .catch(reject);
        });
    }
}

//~ private

function extractFilename(fullFileName) {
    return path.basename(fullFileName);
}

function getDropbox(options) {
    if (!options.isDropboxEnabled) {
        return Promise.reject(new Error("Dropbox is not enabled. Please update your environment."));
    }
    return new Promise((resolve, reject) => {
        const {
            dropboxToken,// keep legacy token
            dropboxRefreshToken, dropboxAppKey, dropboxAppSecret, // current way to proceed
            freshAccessToken // accessToken: set when already retrieved from current session
        } = options;
        if (MUST_LOG_DEBUG && isSet(freshAccessToken)) {
            console.log("we will reuse access-token");
        }
        const currentAccessToken = isSet(freshAccessToken) ? freshAccessToken : dropboxToken;
        isAccessTokenValid(currentAccessToken).then(result => {
            const {isValid, info} = result;
            if (isValid) {
                if (MUST_LOG_DEBUG) {
                    console.log(`use valid access-token from ${info?.email}`);
                }
                resolve(new Dropbox({"accessToken": currentAccessToken}));
            }
        }).catch(rejectResult => {
            const {isValid, error} = rejectResult;
            MUST_LOG_DEBUG && console.log(`isValid:${isValid} error:${error} - so dropboxRefreshAccessToken`);
            if (!isSet(dropboxRefreshToken) || !isSet(dropboxAppKey) || !isSet(dropboxAppSecret)) {
                reject(new Error("to refresh a dropbox access token, following options are required: dropboxRefreshToken, dropboxAppKey, dropboxAppSecret"));
                return;
            }
            refreshAccessToken(dropboxRefreshToken, dropboxAppKey, dropboxAppSecret)
                .then(freshAccessToken => {
                    options.freshAccessToken = freshAccessToken;
                    resolve(new Dropbox({"accessToken": freshAccessToken}));
                })
                .catch(err => reject(err));
        });
    })
}

class MTOptions {
    constructor(options) {
        const LO = '127.0.0.1';
        const opt = options ? options : {};
        //~ database connect options
        this.uri = "uri" in opt ? opt.uri : (process.env.MT_MONGO_URI || null);    // database uri
        this.db = "db" in opt ? opt.db : (process.env.MT_MONGO_DB || null);    // database name
        this.dbFrom = "dbFrom" in opt ? opt.dbFrom : (process.env.MT_MONGO_DB_FROM || null);    // source database name for mongorestore
        this.dbTo = "dbTo" in opt ? opt.dbTo : (process.env.MT_MONGO_DB_TO || null);    // target database name for mongorestore
        this.host = "host" in opt ? opt.host : (process.env.MT_MONGO_HOST || LO);      // database hostname
        this.port = "port" in opt ? opt.port : (process.env.MT_MONGO_PORT || 27017);   // database port
        this.username = "username" in opt ? opt.username : (process.env.MT_MONGO_USER || null);    // database username
        this.password = "password" in opt ? opt.password : (process.env.MT_MONGO_PWD || null);    // database password
        this.authDb = "authDb" in opt ? opt.authDb : (process.env.MT_MONGO_AUTH_DB || 'admin'); // authenticate database
        //~ ssl options
        this.ssl = "ssl" in opt ? opt.ssl : (process.env.MT_MONGO_SSL || null);    // if "1" then ssl is enabled
        this.sslCAFile = "sslCAFile" in opt ? opt.sslCAFile : (process.env.MT_MONGO_SSL_CA_FILE || null);    // .pem file containing the root certificate chain
        this.sslPEMKeyFile = "sslPEMKeyFile" in opt ? opt.sslPEMKeyFile : (process.env.MT_MONGO_SSL_PEM_KEY_FILE || null); // .pem file containing the certificate and key
        this.sslPEMKeyPassword = "sslPEMKeyPassword" in opt ? opt.sslPEMKeyPassword : (process.env.MT_MONGO_SSL_PEM_KEY_PASSWORD || null);    // password to decrypt the sslPEMKeyFile, if necessary
        this.sslCRLFile = "sslCRLFile" in opt ? opt.sslCRLFile : (process.env.MT_MONGO_SSL_CRL_FILE || null);    // .pem file containing the certificate revocation list
        this.sslFIPSMode = "sslFIPSMode" in opt ? opt.sslFIPSMode : (process.env.MT_MONGO_SSL_FIPS || null);    // if "1" then use FIPS mode of the installed openssl library
        this.tlsInsecure = "tlsInsecure" in opt ? opt.tlsInsecure : (process.env.MT_MONGO_TLS_INSECURE || null);    // if "1" then  bypass the validation for server's certificate chain and host name

        this.assumeValidPort();

        this.showCommand = "showCommand" in opt ? opt.showCommand : (process.env.MT_SHOW_COMMAND === 'true'); // show wrapped commands

        //~ dump
        this.dumpCmd = "dumpCmd" in opt ? opt.dumpCmd : (process.env.MT_MONGODUMP || 'mongodump');   // mongodump binary
        this.path = "path" in opt ? opt.path : (process.env.MT_PATH || 'backup');     // target dump location
        this.fileName = "fileName" in opt ? opt.fileName : (process.env.MT_FILENAME || null);         // target dump filename
        this.encrypt = "encrypt" in opt ? opt.encrypt : false;
        this.secret = "secret" in opt ? opt.secret : (process.env.MT_SECRET || null);         // secret to encrypt dump

        this.includeCollections = "includeCollections" in opt ? opt.includeCollections : null;// #deprecated
        this.collection = "collection" in opt ? opt.collection : (process.env.MT_COLLECTION || null);
        this.excludeCollections = "excludeCollections" in opt ? opt.excludeCollections : (process.env.MT_EXCLUDE_COLLECTIONS || null);

        this.defaultEncryptSuffix = '.enc';
        this.encryptSuffix = "encryptSuffix" in opt ? opt.encryptSuffix : this.defaultEncryptSuffix;

        //~ restore
        this.restoreCmd = "restoreCmd" in opt ? opt.restoreCmd : (process.env.MT_MONGORESTORE || 'mongorestore'); // mongorestore binary
        this.dumpFile = "dumpFile" in opt ? opt.dumpFile : (process.env.MT_DUMP_FILE || null);     // dump file location
        this.decrypt = "decrypt" in opt ? opt.decrypt : this.dumpFile && this.dumpFile.endsWith(this.defaultEncryptSuffix) || false;  // decrypt dump before restore
        this.dropBeforeRestore = "dropBeforeRestore" in opt ? opt.dropBeforeRestore : false;                // drop db before restore
        this.deleteDumpAfterRestore = "deleteDumpAfterRestore" in opt ? opt.deleteDumpAfterRestore : false; // delete dump after restore

        //~ dropbox
        this.dropboxLocalPath = "dropboxLocalPath" in opt ? opt.dropboxLocalPath : (process.env.MT_DROPBOX_LOCAL_PATH || "dropbox");

        // DEPRECATED - MT_DROPBOX_TOKEN - old-long-lived access-token - no more available from dropbox developers portal
        this.dropboxToken        = "dropboxToken"        in opt ? opt.dropboxToken        : (process.env.MT_DROPBOX_TOKEN || null);

        // TIP: get key,secret from dropbox developers app dev portal : https://www.dropbox.com/developers/apps/
        this.dropboxAppKey       = "dropboxAppKey"       in opt ? opt.dropboxAppKey       : (process.env.MT_DROPBOX_APP_KEY || null);
        this.dropboxAppSecret    = "dropboxAppSecret"    in opt ? opt.dropboxAppSecret    : (process.env.MT_DROPBOX_APP_SECRET || null);
        // TIP: long-lived offline refresh-token. cf. https://github.com/boly38/dropbox-refresh-token
        this.dropboxRefreshToken = "dropboxRefreshToken" in opt ? opt.dropboxRefreshToken : (process.env.MT_DROPBOX_REFRESH_TOKEN || null);

        this.isDeprecatedDropboxTokenAvailable = isNotEmptyString(this.dropboxToken);
        this.isDropboxRefreshTokenAvailable    = areNotEmptyStrings([this.dropboxAppKey, this.dropboxAppSecret, this.dropboxRefreshToken]);
        this.isDropboxEnabled = this.isDeprecatedDropboxTokenAvailable || this.isDropboxRefreshTokenAvailable;

        //~ rotation
        // rotationDryMode       : dont do delete actions, just print it
        this.rotationDryMode = "rotationDryMode" in opt ? opt.rotationDryMode : (process.env.MT_ROTATION_DRY_MODE === 'true');
        // rotationWindowsDays   : safe time windows defined by [ now-rotationWindowsDays day(s) =until=> now ] where backups can't be removed.
        this.rotationWindowsDays = "rotationWindowsDays" in opt ? opt.rotationWindowsDays : (process.env.MT_ROTATION_WINDOWS_DAYS || 15);
        // backup out of safe time windows are called "deprecated backup"
        // rotationMinCount      : minimum deprecated backups to keep.
        this.rotationMinCount = "rotationMinCount" in opt ? opt.rotationMinCount : (process.env.MT_ROTATION_MIN_COUNT || 2);
        // rotationCleanCount    : number of (oldest first) deprecated backups to delete
        this.rotationCleanCount = "rotationCleanCount" in opt ? opt.rotationCleanCount : (process.env.MT_ROTATION_CLEAN_COUNT || 10);

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
        return ('path' in this) ? this.path : 'backup';
    }

    getDropboxPath() {
        return '/' + this.getPath();
    }

    getDropboxLocalPath() {
        return ('dropboxLocalPath' in this) ? this.dropboxLocalPath : 'dropbox';
    }
}

const isNotEmptyString = value => value !== undefined && typeof value === 'string' && value.length > 0;
const areNotEmptyStrings = arr => Array.isArray(arr) && arr.length > 0 && arr.reduce((rez, curValue) => rez && isNotEmptyString(curValue), true);

const algorithm = 'aes-256-ctr';
const expectedKeyLength = 32;// aes-256-ctr require 32 byte length key
const iv = "NODE-MONGOTOOLS_";// crypto.randomBytes(16);

// credit - July 30, 2020 - Atta : https://attacomsian.com/blog/nodejs-encrypt-decrypt-data
class MTEncrypt {

    encrypt(source, destination, secretKey, removeSource = true) {
        return new Promise(resolve => {
            if (!secretKey || secretKey.length !== expectedKeyLength) {
                throw new Error(`Encrypt algorithm ${algorithm} require a secret key having ${expectedKeyLength} length`);
            }
            // input file
            const inStream = fs.createReadStream(source);
            // encrypt content
            const encrypt = crypto.createCipheriv(algorithm, secretKey, iv);
            // write file
            const outFileStream = fs.createWriteStream(destination);

            inStream.pipe(encrypt).pipe(outFileStream);

            inStream.on('end', () => {
                if (removeSource === true) {
                    fs.unlinkSync(source);
                }
                resolve();
            });
        });
    }

    decrypt(source, destination, secretKey) {
        return new Promise(resolve => {
            console.info("decrypt " + source + " into " + destination);
            // input file
            const inStream = fs.createReadStream(source);
            // decrypt content
            const decrypt = crypto.createDecipheriv(algorithm, secretKey, iv);
            // write file
            const outFileStream = fs.createWriteStream(destination);

            inStream.pipe(decrypt).pipe(outFileStream);

            inStream.on('end', () => {
                resolve();
            });
        });
    }

}

class MongoTools {
    constructor() {
        this.wrapper = new MTWrapper();
        this.dbx = new MTDropbox();
        this.fs = new MTFilesystem();
        this.enc = new MTEncrypt();
    }

    list(opt) {
        const mt = this;
        return new Promise((resolve, reject) => {
            const options = assumeOptions(opt);
            const path = options.getPath();
            mt.fs.listFromFilesystem(path)
                .then(filesystem => {
                    if (!options.isDropboxEnabled) {
                        return resolve({path, filesystem});
                    }
                    mt.dbx.listFromDropbox(options)
                        .then(dropbox => {
                            resolve({path, filesystem, dropbox});
                        })
                        .catch(err => reject(err));
                })
                .catch(err => reject(err));
        });
    }

    mongodump(opt) {
        const mt = this;
        return new Promise((resolve, reject) => {
            const options = assumeOptions(opt);
            mt.wrapper.mongodump(options)
                .then(dumpResult => {
                    if (options.encrypt === true) {
                        mt.encryptDump(options, dumpResult)
                            .then(dumpResult => {
                                mt.uploadOnDropboxIfEnabled(options, dumpResult, resolve, reject);
                            })
                            .catch(err => reject(err));
                    } else {
                        mt.uploadOnDropboxIfEnabled(options, dumpResult, resolve, reject);
                    }

                })
                .catch(err => reject(err));
        });
    }

    uploadOnDropboxIfEnabled(options, dumpResult, resolve, reject) {
        // DEBUG // console.log(options.dropboxEnabled , JSON.stringify(dumpResult));
        if (options.isDropboxEnabled && dumpResult.fileName && dumpResult.fullFileName) {
            this.dbx.mongoDumpUploadOnDropbox(options, dumpResult)
                .then(resolve)
                .catch(err => reject(err));
        } else {
            resolve(dumpResult);
        }
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
            mt.enc.encrypt(originalFile, dumpResult.fullFileName, secret)
                .then(() => {
                    resolve(dumpResult);
                })
                .catch(err => reject(err));
        });
    }

    mongorestore(opt) {
        const options = assumeOptions(opt);
        const path = options.getPath();
        const mt = this;
        return new Promise((resolve, reject) => {
            let toRestore = options.dumpFile;
            if (!toRestore) {
                return reject(new Error("dumpFile is required"));
            }
            if (!toRestore.startsWith(path) && options.isDropboxEnabled === true) {
                mt.dbx.mongorestoreDownloadFromDropbox(options)
                    .then(downloadResult => {
                        if (downloadResult === undefined) {
                            return;
                        }
                        console.log(downloadResult.message);
                        toRestore = downloadResult.fullFileName;
                        mt.decryptAndRestore(options, toRestore, resolve, reject);
                    })
                    .catch(err => reject(err));
            } else {
                mt.decryptAndRestore(options, toRestore, resolve, reject);
            }
        });
    }

    decryptAndRestore(options, toRestore, resolve, reject) {
        if (options.decrypt === true) {
            this.decryptDump(options, toRestore)
                .then(toRestore => {
                    this.wrapper.mongorestore(options, toRestore)
                        .then(resolve)
                        .catch(err => reject(err));
                })
                .catch(err => reject(err));
        } else {
            this.wrapper.mongorestore(options, toRestore)
                .then(resolve)
                .catch(err => reject(err));
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
            mt.enc.decrypt(originalFile, decryptedFile, secret)
                .then(() => {
                    resolve(decryptedFile);
                })
                .catch(err => reject(err));
        });
    }

    rotation(opt) {
        const options = assumeOptions(opt);
        const rotationDryMode = 'rotationDryMode' in options ? options.rotationDryMode : false;
        const windowsDays = 'rotationWindowsDays' in options ? options.rotationWindowsDays : 15;
        const minCount = 'rotationMinCount' in options ? options.rotationMinCount : 2;
        const cleanCount = 'rotationCleanCount' in options ? options.rotationCleanCount : 10;
        try {
            assumeInt(windowsDays, 0, null, "rotationWindowsDays: must be an integer greater than or equal to 0");
            assumeInt(minCount, 0, null, "minCount: must be an integer greater than or equal to 0");
            assumeInt(cleanCount, 0, null, "cleanCount: must be an integer greater than or equal to 0");
        } catch (validationError) {
            return Promise.reject({error: 'INVALID_OPTIONS', message: validationError});
        }
        const path = options.getPath();
        const ctimeMsMax = new Date();
        ctimeMsMax.setDate(ctimeMsMax.getDate() - windowsDays);
        const ctimeMsMaxMs = ctimeMsMax.getTime();
        // DEBUG // console.log("ctimeMsMax", ctimeMsMaxMs, "==>", ctimeMsMax)
        const mt = this;
        return new Promise((resolve, reject) => {
            mt.fs.fileSystemRotation(rotationDryMode, path, ctimeMsMaxMs, cleanCount, minCount)
                .then(filesystemRotationResult => {
                    if (options.isDropboxEnabled) {
                        mt.dbx.rotation(options, rotationDryMode, ctimeMsMax, cleanCount, minCount)
                            .then(dropboxRotationResult => {
                                resolve({
                                    filesystem: filesystemRotationResult,
                                    dropbox: dropboxRotationResult
                                });
                            })
                            .catch(err => reject(err));
                    } else {
                        resolve({filesystem: filesystemRotationResult});
                    }
                })
                .catch(err => reject(err));

        });
    }

}

//~ private world

function assumeInt(value, intMin, intMax, errorMsg) {
    if (isNaN(value)
        || (value < intMin)
        || (intMax !== null )
    ) {
        throw errorMsg;
    }
}

function assumeOptions(options) {
    if (options === null || options === undefined || !(options instanceof MTOptions)) {
        return new MTOptions(options);
    }
    return options;
}

class MTCommand {
  constructor() {
    this.mt = new MongoTools();
    // DEBUG // console.log(new MTOptions());
  }

  /**
   * pick filename only from full file+path string
   */
  filenameOnly(fullName) {
      return fullName ? fullName.substring(fullName.lastIndexOf(path.sep) + 1, fullName.length) : '';
  }

  /**
   * help user on usage
   */
  printUsage() {
    const launchCmd = this.filenameOnly(process.argv[0]) + ' ' + this.filenameOnly(process.argv[1]);
    console.log('Usage:\t' + launchCmd + ' <options|list|dump|dumpz|restore backup/myFile.gz|rotation>');
  }

  logOutput(result) {
    if (result.stdout) { console.info('stdout:', result.stdout); }
    if (result.stderr) { console.error('stderr:', result.stderr); }
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
    // DEBUG // console.error(JSON.stringify(err));
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

  doAction(action = 'list') {
    const cmd = this;
    if (!['options','list','dump','dumpz','restore','rotation'].includes(action)) {
      this.printUsage();
      return;
    }
    if (action === 'options') {
      console.log(JSON.stringify(new MTOptions(), null, 2));
    }
    if (action === 'list') {
      this.mt.list(new MTOptions()).then((listResult) => {
        console.log(JSON.stringify(listResult, null, 4));
      }).catch(error => cmd.logError(error.message));
      return;
    }
    if (action === 'dumpz') {
      this.mt.mongodump(new MTOptions({
            "encrypt":true
      }))
      .then(cmd.logSuccess.bind(cmd)).catch(error => cmd.logError(error.message));
      return;
    }
    if (action === 'dump') {
      this.mt.mongodump(new MTOptions({})).then(cmd.logSuccess.bind(cmd)).catch(error => cmd.logError(error.message));
      return;
    }
    // restore action do need an extra argument: the file to restore
    if (action === 'restore') {
      if (process.argv.slice(2).length !== 2) {
        this.printUsage();
        return;
      }
      const restoreFile = process.argv.slice(2)[1];
      this.mt.mongorestore(new MTOptions({
            dumpFile: restoreFile,
            dropBeforeRestore: false,
            deleteDumpAfterRestore: false
      }))
      .then(cmd.logSuccess.bind(cmd)).catch(error => cmd.logError(error.message));
      return;
    }
    if (action === 'rotation') {
      this.mt.rotation(new MTOptions()).then(cmd.logSuccess.bind(cmd)).catch(error => cmd.logError(error.message));
    }
  }

}

export { MTCommand, MTOptions, MongoTools };
