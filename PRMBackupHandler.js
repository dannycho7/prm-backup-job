const fs = require("fs");
const { promises: fsPromises } = fs;
const path = require("path");

const archiver = require('archiver');
const bytes = require('bytes');
const mkdirp = require("mkdirp");
const moment = require("moment");
const progress = require("progress-stream");
const rimraf = require("rimraf");
const SFTPClient = require("ssh2-sftp-client");
const sgMail = require('@sendgrid/mail');

class PRMBackupHandler {
    constructor(config) {
        this.validateConfig(config);
        this.config = config;
        this.sftp = new SFTPClient('PRMBackupHandler');
        sgMail.setApiKey(this.config.SENDGRID_API_KEY);
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

    getFormattedTimeStr(time) {
        return moment(time).format('YYYYMMDD-HHmm');
    }

    async sendReport(isSuccess, outputFilePath, outputFileSize, timeStart, timeEnd) {
        let subjectStr = `[${this.config.USERNAME}] Backup ${isSuccess ? `success!` : "failed!"}`;
        let bodyPrefix = isSuccess ? `Saved ${bytes(outputFileSize)} backup to ${outputFilePath}.` : "Try running manually to diagnose the issue.";
        let body = `${bodyPrefix}\nStarted ${this.getFormattedTimeStr(timeStart)}. Ended ${this.getFormattedTimeStr(timeEnd)}`

        const msg = {
            to: this.config.REPORT_EMAIL,
            from: 'prm-backup-handler@dannycho.me',
            subject: subjectStr,
            text: body,
        };

        await sgMail.send(msg).then(() => {
            console.log("Successfully sent email report!");
        })
            .catch((err) => {
                console.error(err);
            });
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

        return outputFilePath;
    }

    async backup() {
        console.log("Starting backup");
        let timeStart = new Date();
        try {
            var fileNames = await fsPromises.readdir(this.config.BACKUP_FILES_PATH);
        } catch (err) {
            console.error(err);

        }

        const prmTempFileDir = path.join(this.config.BACKUP_FILES_PATH, ".prm-temp");
        await mkdirp(prmTempFileDir);

        const dateStr = this.getFormattedTimeStr(new Date());
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
            let stat = await fsPromises.stat(filePath);
            if (!stat.isDirectory()) {
                let progressStream = progress({
                    length: stat.size,
                    time: 1000 /* ms */
                });

                progressStream.on('progress', (progress) => {
                    console.log(`Progress for ${fileName}: ${JSON.stringify(progress)}`);
                });

                archive.append(fs.createReadStream(filePath).pipe(progressStream), { name: fileName });
            }
        }));

        archive.finalize();
        var isSuccess = false, outputFilePath, outputFileSize;

        return zipFilePromise
            .then(async () => {
                outputFileSize = (await fsPromises.stat(zipFilePath)).size;
                console.log(`Finished file compression! Exporting via SFTP`);
                outputFilePath = await this.exportFile(zipFilePath);
            })
            .then(() => {
                // cleanup temp directory after backup finishes
                return new Promise((resolve, reject) => rimraf(prmTempFileDir, resolve));
            })
            .then(() => {
                isSuccess = true;
            })
            .catch((err) => {
                console.error(err);
            })
            .finally(() => {
                let timeEnd = new Date();
                this.sendReport(isSuccess, outputFilePath, outputFileSize, timeStart, timeEnd);
            });
    }
};

module.exports = PRMBackupHandler;
