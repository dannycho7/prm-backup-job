const fs = require("fs");
const { promises: fsPromises } = fs;
const path = require("path");

const archiver = require('archiver');
const mkdirp = require("mkdirp");
const moment = require("moment");
const rimraf = require("rimraf");
const SFTPClient = require("ssh2-sftp-client");

class PRMBackupHandler {
    constructor(config) {
        this.validateConfig(config);
        this.config = config;
        this.sftp = new SFTPClient('PRMBackupHandler');
    }

    validateConfig(config) {
        if (!config) {
            throw new Error("Config is required");
        }

        for (const k in config) {
            let v = config[k];
            if (!v) {
                throw new Error(`Invalid value for ${k}: ${v}`);
            }
        }
    }

    async exportFile(srcFilePath) {
        const outputFileName = path.parse(srcFilePath).base;
        const outputFilePath = path.join(this.config.SFTP_EXPORT_DESTINATION_PATH, outputFileName);
        console.log(`Attempting to upload ${srcFilePath} and saving to ${outputFilePath}...`);

        await this.sftp.connect({
            host: this.config.SFTP_IP_ADDR,
            port: this.config.SFTP_PORT,
            username: this.config.SFTP_USERNAME,
            password: this.config.SFTP_PASSWORD,
        })
            .then(() => {
                console.log("Connection success");
                return this.sftp.fastPut(srcFilePath, outputFilePath);
            })
            .then(() => {
                console.log("Upload success");
            })
            .catch(err => {
                console.error(`Error: ${err.message}`);
            })
            .finally(() => {
                this.sftp.end();
            });
    }

    async backup() {
        console.log("Starting backup");
        try {
            var fileNames = await fsPromises.readdir(this.config.BACKUP_FILES_PATH);
        } catch (err) {
            console.error(err);

        }

        const prmTempFileDir = path.join(this.config.BACKUP_FILES_PATH, ".prm-temp");
        await mkdirp(prmTempFileDir);

        const dateStr = moment(new Date()).format('YYYYMMDD-HHmm');
        const zipFilePath = path.join(prmTempFileDir, `backup-${dateStr}.zip`);

        console.log(`Starting compression of files into and saving to ${zipFilePath}`);

        let zipFileOutput = fs.createWriteStream(zipFilePath);
        let archive = archiver('zip', {
            zlib: { level: 9 } // Sets the compression level.
        });

        let zipFilePromise = new Promise((resolve, reject) => {
            archive.on('warning', (err) => {
                if (err.code === 'ENOENT') {
                    console.warn(err);
                } else {
                    reject(err);
                }
            });

            archive.on('error', (err) => {
                reject(err);
            });

            zipFileOutput.on('close', () => {
                resolve();
            });
        });

        archive.pipe(zipFileOutput);

        await Promise.all(fileNames.map(async (fileName) => {
            let filePath = path.join(this.config.BACKUP_FILES_PATH, fileName);
            let fileStat = await fsPromises.stat(filePath)
            if (!fileStat.isDirectory()) {
                archive.append(fs.createReadStream(filePath), { name: fileName });
            }
        }));

        archive.finalize();

        return zipFilePromise
            .then(() => {
                console.log(`Finished file compression! Exporting via SFTP`)
                return this.exportFile(zipFilePath);
            })
            .then(() => {
                // cleanup temp directory after backup finishes
                return new Promise((resolve, reject) => rimraf(prmTempFileDir, resolve));
            });
    }
};

module.exports = PRMBackupHandler;
