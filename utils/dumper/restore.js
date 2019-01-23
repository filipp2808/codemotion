const restore = require('mongodb-restore');
const config = require('../../config');
const fs = require('fs');

const dumpDir = config.get('dump:dumpDir');

const restoreFromBackup = (backupFile, dbName, cb) => {
    dbName = dbName || backupFile.split('_')[2].split('.')[0];

    restore({
        uri: 'mongodb://localhost/' + dbName,
        root: dumpDir,
        tar: backupFile,
        parser: 'json',
        // drop: true,
        callback: err => {cb(!err); console.log(err ? err : 'Restore finish');},
    });
};

module.exports.restoreFromBackup = restoreFromBackup;

// if (!module.parent) restoreFromBackup('1545786000_26Dec2018_productiveTriglav.tar', 'test');


