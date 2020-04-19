const fsPromises = require("fs").promises;
const path = require("path");

const mkdirp = require("mkdirp");
const moment = require("moment");
const rimraf = require("rimraf");

const AdmZip = require("adm-zip");
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
        try {
            var fileNames = await fsPromises.readdir(this.config.BACKUP_FILES_PATH);
        } catch (err) {
            console.error(err);

        }

        const prmTempFileDir = path.join(this.config.BACKUP_FILES_PATH, ".prm-temp");
        await mkdirp(prmTempFileDir);

        let zip = new AdmZip();
        await Promise.all(fileNames.map(async (fileName) => {
            let filePath = path.join(this.config.BACKUP_FILES_PATH, fileName);
            let fileStat = await fsPromises.stat(filePath)
            if (!fileStat.isDirectory()) {
                zip.addLocalFile(filePath);
            }
        }));

        const dateStr = moment(new Date()).format('YYYYMMDD-HHmm');
        const zipFilePath = path.join(prmTempFileDir, `backup-${dateStr}.zip`);
        zip.writeZip(zipFilePath);

        await this.exportFile(zipFilePath);

        // cleanup temp directory after backup finishes
        return new Promise((resolve, reject) => rimraf(prmTempFileDir, resolve));
    }
};

module.exports = PRMBackupHandler;