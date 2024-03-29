const fs = require("fs");
const { promises: fsPromises } = fs;
const path = require("path");

const archiver = require("archiver");
const bytes = require("bytes");
const mkdirp = require("mkdirp");
const moment = require("moment");
const progress = require("progress-stream");
const rimraf = require("rimraf");
const SFTPClient = require("ssh2-sftp-client");
const sgMail = require("@sendgrid/mail");
const slash = require("slash");

class PRMBackupHandler {
  constructor(config) {
    this.validateConfig(config);
    this.config = config;
    this.sftp = new SFTPClient("PRMBackupHandler");
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

  getFormattedTimeStrForFile(time) {
    return moment(time).format("YYYYMMDD-HHmm");
  }

  getFormattedTimeStrForEmail(time) {
    return moment(time).format("YYYY-MM-DD HH:mm");
  }

  async sendEmail(subject, body) {
    const msg = {
      to: this.config.REPORT_EMAIL,
      from: "prm-backup-handler@dannycho.me",
      subject: subject,
      text: body,
    };

    return sgMail
      .send(msg)
      .then(() => {
        console.log("Successfully sent email report!");
      })
      .catch((err) => {
        console.error(err);
      });
  }

  async sendNoFilesReport() {
    let subject = `[${this.config.USERNAME}] No backup initiated!`;
    let body = `Could not find any files in ${path.resolve(
      this.config.BACKUP_FILES_PATH
    )}`;

    return this.sendEmail(subject, body);
  }

  async sendReport(
    isSuccess,
    outputFilePath,
    outputFileSize,
    timeStart,
    timeEnd
  ) {
    let subject = `[${this.config.USERNAME}] Backup ${
      isSuccess ? `success!` : "failed!"
    }`;
    let bodyPrefix = isSuccess
      ? `Saved ${bytes(outputFileSize)} backup to ${outputFilePath}.`
      : "Try running manually to diagnose the issue.";
    let body =
      `${bodyPrefix}\nStarted: ${this.getFormattedTimeStrForEmail(
        timeStart
      )}.\n` + `Ended: ${this.getFormattedTimeStrForEmail(timeEnd)}.`;

    return this.sendEmail(subject, body);
  }

  async exportFile(srcFilePath) {
    const dateStr = this.getFormattedTimeStrForFile(new Date());
    const outputFileName = `backup-${dateStr}.zip`;
    const outputFilePath = slash(
      path.join(this.config.SFTP_EXPORT_DESTINATION_PATH, outputFileName)
    );
    console.log(`Attempting to upload to ${outputFilePath}...`);

    return this.sftp
      .connect({
        host: this.config.SFTP_IP_ADDR,
        port: this.config.SFTP_PORT,
        username: this.config.SFTP_USERNAME,
        password: this.config.SFTP_PASSWORD,
      })
      .then(() => {
        console.log("Connection success");
        return this.sftp.fastPut(srcFilePath, outputFilePath, {
          step: (total_transferred, chunk, total) => {
            console.log(
              `Progress for uploading ${outputFilePath}: ` +
                `transferred ${bytes(total_transferred)} of ${bytes(total)}`
            );
          },
        });
      })
      .then(() => {
        console.log("Upload success");
        return this.sftp.stat(outputFilePath);
      })
      .then((stat) => {
        return { outputFilePath, outputFileSize: stat.size };
      })
      .finally(() => {
        this.sftp.end();
      });
  }

  async backup() {
    console.log("Starting backup");
    let timeStart = new Date();
    try {
      var fileNames = await fsPromises.readdir(this.config.BACKUP_FILES_PATH);
      // backupFileNames only consists of files that were modified today
      var backupFileNames = [];
      await Promise.all(
        fileNames.map(async (fileName) => {
          let stats = await fsPromises.stat(
            path.join(this.config.BACKUP_FILES_PATH, fileName)
          );
          if (stats.isDirectory()) {
            console.warn(`Encountered directory in stat of ${fileName}`);
          }
          let mdate = new Date(stats.mtime).toLocaleDateString();
          let today = new Date().toLocaleDateString();
          // We should only upload files that were created/modified today.
          const isModifiedToday = mdate == today;
          if (isModifiedToday) {
            backupFileNames.push(fileName);
          }
        })
      );
    } catch (err) {
      console.error(err);
    }

    if (backupFileNames.length == 0) {
      return this.sendNoFilesReport();
    }

    let archive = archiver("zip", {
      zlib: { level: 9 }, // Sets the compression level.
    });

    archive.on("warning", (err) => {
      if (err.code === "ENOENT") {
        console.warn(err);
      } else {
        console.error(err);
      }
    });

    archive.on("error", (err) => {
      console.error(err);
    });

    var archiveDirPath = path.join(
      this.config.BACKUP_FILES_PATH,
      "prm-backup-job-archives"
    );
    await mkdirp(archiveDirPath);
    var archiveFilePath = path.join(
      archiveDirPath,
      timeStart.getTime().toString()
    );
    var archiveFileStream = fs.createWriteStream(archiveFilePath);
    archiveFileStream.on("close", async () => {
      var isSuccess = false,
        outputFilePath,
        outputFileSize;

      await this.exportFile(archiveFilePath)
        .then((stats) => {
          outputFilePath = stats.outputFilePath;
          outputFileSize = stats.outputFileSize;
          isSuccess = true;
        })
        .catch((err) => console.error(err))
        .finally(() => {
          let timeEnd = new Date();
          return this.sendReport(
            isSuccess,
            outputFilePath,
            outputFileSize,
            timeStart,
            timeEnd
          );
        });

      this.cleanup(archiveDirPath);
    });
    archive.pipe(archiveFileStream);

    await Promise.all(
      backupFileNames.map(async (fileName) => {
        let filePath = path.join(this.config.BACKUP_FILES_PATH, fileName);
        let stat = await fsPromises.stat(filePath);
        if (!stat.isDirectory()) {
          let progressStream = progress({
            length: stat.size,
            time: 1000 /* ms */,
          });

          progressStream.on("progress", (progress) => {
            console.log(
              `Progress for archiving ${fileName}: ` +
                `${Number(progress.percentage).toFixed(2)}% finished, ` +
                `${bytes(progress.transferred)} transferred, ` +
                `${bytes(progress.remaining)} remaining`
            );
          });

          archive.append(fs.createReadStream(filePath).pipe(progressStream), {
            name: fileName,
          });
        }
      })
    );

    archive.finalize();
  }

  async cleanup(archiveDirPath) {
    console.log("Cleaning up...");
    rimraf.sync(archiveDirPath);
    console.log(`Successfully removed ${archiveDirPath}!`);
    console.log("Cleanup finished");
  }

  // DEPRECATED
  async _exportFileStream(srcFileStream) {
    const dateStr = this.getFormattedTimeStrForFile(new Date());
    const outputFileName = `backup-${dateStr}.zip`;
    const outputFilePath = path.join(
      this.config.SFTP_EXPORT_DESTINATION_PATH,
      outputFileName
    );
    console.log(`Attempting to upload to ${outputFilePath}...`);

    return this.sftp
      .connect({
        host: this.config.SFTP_IP_ADDR,
        port: this.config.SFTP_PORT,
        username: this.config.SFTP_USERNAME,
        password: this.config.SFTP_PASSWORD,
      })
      .then(() => {
        console.log("Connection success");
        return this.sftp.put(srcFileStream, outputFilePath);
      })
      .then(() => {
        console.log("Upload success");
        return this.sftp.stat(outputFilePath);
      })
      .then((stat) => {
        return { outputFilePath, outputFileSize: stat.size };
      })
      .finally(() => {
        this.sftp.end();
      });
  }
}

module.exports = PRMBackupHandler;
