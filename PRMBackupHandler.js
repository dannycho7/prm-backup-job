const fs = require("fs");
const path = require("path");

const AdmZip = require("adm-zip");

class PRMBackupHandler {
    constructor(config) {
        this.validateConfig(config);
        this.config = config;
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

    async handleFile(filePath) {
        let zip = new AdmZip();
        zip.addLocalFile(filePath);
        zip.writeZip(filePath + ".zip");
    }

    backup(onSuccessCB) {
        fs.readdir(this.config.BACKUP_FILES_PATH, (err, fileNames) => {
            if (err) {
                console.error(`Unable to find directory ${process.env.PRM_BACKUP_JOB_PATH}`);
            } else {
                return Promise.all(fileNames.map(async (fileName) => {
                    let filePath = path.join(this.config.BACKUP_FILES_PATH, fileName);
                    await this.handleFile(filePath);
                }))
                    .then((_) => {
                        onSuccessCB();
                    });
            }
        });
    }
};

module.exports = PRMBackupHandler;