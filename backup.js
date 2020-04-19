require("dotenv").config();

const fs = require("fs");
const path = require("path");

const PRMBackupHandler = require("./PRMBackupHandler.js");

const configPath = process.env.PRM_BACKUP_CONFIG_PATH || path.join(__dirname, "./config.json");
const config = JSON.parse(fs.readFileSync(configPath));

new PRMBackupHandler(config).backup();