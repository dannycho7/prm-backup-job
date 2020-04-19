require("dotenv").config();

const PRMBackupHandler = require("./PRMBackupHandler.js");

const configPath = process.env.CONFIG_PATH || "./config.json";
const config = require(configPath);
new PRMBackupHandler(config).backup();