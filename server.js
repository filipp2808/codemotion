let fs = require('fs');
let config = require('./config');
const sslOptions = {
    ca: fs.readFileSync('ssl/triglav.ca-bundle'),
    cert: fs.readFileSync('ssl/triglav.cer'),
    key: fs.readFileSync('ssl/triglav.key')
};
let https = require('https').createServer(sslOptions);
let io = require('socket.io')(https);
let socketHandlers = require('./handlers');

io.on('connection', socketHandlers);

const devMode = process.argv[2] ? !!(process.argv[2] === 'dev') : true;
const staticServer = process.argv[3] ? !!(process.argv[3] !== 'nostatic') : true;
config.set('dev', devMode);
config.set('staticServer', staticServer);

if (staticServer) require('./staticServer');  //  ports: 80, 443

if (devMode) {
    https.listen(config.get('port'), () => {console.log(`Listen on ${config.get('port')} port.`);} );
    console.log('Development mode');
} else {
    https.listen(config.get('productivePort'), () => {console.log(`Listen on ${config.get('productivePort')} port.`);} );
    console.log('Productive mode');
}

process.on('uncaughtException', err => {
    console.log('Caught exception: ' + err);
});