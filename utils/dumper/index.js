const cron = require('node-cron');
const backup = require('mongodb-backup');
const fs = require('fs');
let config = require('../../config');

const dumpDir = config.get('dump:dumpDir');   // '/var/www/html/admin/dump';
const urlDir = config.get('dump:urlDir');   // 'https://triglav.paperus.eu/admin/dump';


const getDateString = postfix => {
    const date = new Date();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
    return parseInt(date.getTime() / 1000) + '_' + date.getDate() + months[date.getMonth()] + date.getFullYear() + postfix;
};

const removeOldBackups = () => {
    const ts = parseInt((new Date()).getTime() / 1000);

    fs.readdirSync(dumpDir).forEach(file => {
        if (file.indexOf('.tar') > -1) {
            console.log(file);
            fs.chmodSync(dumpDir + '/' + file, '777');
            const dumpTS = file.split('_')[0];
            if ((ts - dumpTS) > 5 * 24 * 3600) fs.unlink(dumpDir + '/' + file, err => {
                if (err) console.error(err)
            });
        }
    })
};

const createNewBackup = (dbname = 'productiveTriglav') => {
    backup({
        uri: 'mongodb://localhost/' + dbname,
        root: dumpDir,
        parser: 'json',
        callback: err => { console.log(err ? err : 'Backup finish'); if (!err) removeOldBackups();},
        // collections: ['objects', 'sights'],
        tar:  getDateString(`_${dbname}.tar`),
    });
};

module.exports.getDumpList = () => {
    return fs.readdirSync(dumpDir).map(file => {
        if (file.indexOf('.tar') > -1) {
            return {
                name: file,
                url: urlDir + '/' + file,
            };
        } else {
            return null;
        }

    }).filter(file => {
        return !!file;
    });
};
module.exports.startSchedule = () => {
    cron.schedule(`0 2 * * *`,() => {
        createNewBackup();
    }, {

    });
};

if (!module.parent) createNewBackup();
