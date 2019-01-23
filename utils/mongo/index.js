let mongoClient = require("mongodb").MongoClient;
let config = require('../../config');
let _db;

const dbName = config.get('dev') ? config.get('db:dbName') : config.get('db:dbProdName');

module.exports.connect = (cb) => {
    mongoClient.connect(config.get('db:connection'), { useNewUrlParser: true }, function(err, client){
        if (!err) _db = client;
        cb(err);
    });
};

module.exports.getDb = function(){
    return {
        // return list of collections
        test : _db.db(dbName).collection("test"),
        rating : _db.db(dbName).collection("rating"),
        sessions : _db.db(dbName).collection("sessions"),
        views : _db.db(dbName).collection("views"),
        users : _db.db(dbName).collection("users"),
        devices : _db.db(dbName).collection("devices"),
        confirmation : _db.db(dbName).collection("confirmation"),
        objects : _db.db(dbName).collection("objects"),
        groups : _db.db(dbName).collection("groups"),
        pendingList : _db.db(dbName).collection("pendingList"),
        sights : _db.db(dbName).collection("sights"),
        tracks : _db.db(dbName).collection("tracks"),
        sightsData : _db.db(dbName).collection("sightsData"),
        soundtracksData : _db.db(dbName).collection("soundtracksData"),
        msgQueue : _db.db(dbName).collection("msgQueue"),
    }
};

module.exports.initIndexes = () => {
    try {
        _db.db(dbName).collection("devices").createIndex({"deviceId": 1}, {"unique": true});
        _db.db(dbName).collection("confirmation").createIndex({"confirmCode": 1}, {"unique": true});
        _db.db(dbName).collection("users").createIndex({"email": 1}, {"unique": true});
        _db.db(dbName).collection("users").createIndex({"userId": 1}, {"unique": true});
        _db.db(dbName).collection("objects").createIndex({"objectId": 1}, {"unique": true});
        _db.db(dbName).collection("sights").createIndex({"acquisitionData.deviceLocation.latitude": 1});
        _db.db(dbName).collection("sights").createIndex({"objectId": 1});
        _db.db(dbName).collection("sights").createIndex({"sightId": 1}, {"unique": true});
        _db.db(dbName).collection("tracks").createIndex({"objectId": 1});
        _db.db(dbName).collection("tracks").createIndex({"soundtrackId": 1}, {"unique": true});
        _db.db(dbName).collection("sightsData").createIndex({"sightId": 1}, {"unique": true});
        _db.db(dbName).collection("soundtracksData").createIndex({"fileId": 1}, {"unique": true});
        _db.db(dbName).collection("msgQueue").createIndex({"userId": 1});
        _db.db(dbName).collection("groups").createIndex({"groupId": 1});
        _db.db(dbName).collection("rating").createIndex({"userId": 1});
        _db.db(dbName).collection("views").createIndex({"userId": 1});
    } catch (e) {
        console.log('notice: Error on indexes initialization');
    }
};

module.exports.close = () => {_db.close()};
