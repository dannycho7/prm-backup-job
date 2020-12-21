require("dotenv").config();

const fs = require("fs");
const PRMBackupHandler = require("./PRMBackupHandler.js");

let configPath = process.env.PRM_BACKUP_CONFIG_PATH;
if (!configPath) {
    if (process.argv.length != 3) {
        throw new Error("Missing argument: config path!");
    }
    configPath = process.argv[2];
}

const configFileContents = fs.readFileSync(configPath);
const config = JSON.parse(configFileContents);
console.log(`Parsed config: ${configFileContents}`);

new PRMBackupHandler(config).backup();