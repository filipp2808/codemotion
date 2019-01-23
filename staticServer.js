let express = require('express');
let app = new express();
let http = require('http').Server(app);
let https = require('https');
let fs = require('fs');
let config = require('./config');
let sslOptions = {
    ca: fs.readFileSync('ssl/triglav.ca-bundle'),
    cert: fs.readFileSync('ssl/triglav.cer'),
    key: fs.readFileSync('ssl/triglav.key'),
};

app.use(express.static('public'));

app.use(function(req, res, next) {
    res.status(404).send('Sorry cant find that!');
    next();
});

app.use(function (err, req, res, next) {
    console.error(err);
    res.send(500, 'Something broke!');
    next();
});

if (config.get("dev")) http.listen(80, () => {console.log('Static server start ok');});
https.createServer(sslOptions, app).listen(443);
