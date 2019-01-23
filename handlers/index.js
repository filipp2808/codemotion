var db;
var mongoDB = require('../utils/mongo');
mongoDB.connect((err) => {  //connection to db init
    if (!err) {
        db = mongoDB.getDb();
        mongoDB.initIndexes();  //create indexes for all collections
        console.log('MongoDB connected - ', mongoDB.dbConnected);
    } else {
        console.log(err);
    }
});
var connections = {};
var adminConnections = [];
var config = require('../config');
var mailer = require('../utils/mailer');
var dumper = require('../utils/dumper');
var restore = require('../utils/dumper/restore');
var crypto = require('crypto');
var validator = require('email-validator');
var sharp = require('sharp');
const uuid = require('uuid/v1');

// ----- GLOBAL -----
let creatorsCache = {}; // creatorId : rank
let ipBlackList = {}, ipLog = {};   // black list for DDOS, ip log of request time

//-------------------------------------------

if (!config.get('dev')) dumper.startSchedule(); // if this is productive server  - add DUMP task to schedule

function isFunction(functionToCheck) {
    return functionToCheck && {}.toString.call(functionToCheck) === '[object Function]';
}

const timestamp = () => {
    let foo = new Date;
    return parseInt(foo.getTime() / 1000);
};
const cocoaTS = () => {
    let foo = new Date;
    return (foo.getTime() - 978307200000 ) / 1000;
};
const generateConfirmationEmail = (confirmCode) => {
    return `Verification link: <a href = 'https://triglav.paperus.eu/admin/${config.get('dev') ? 'dev/' : ''}confirmation.html?confirmCode=${confirmCode}'>here</a>`;
};
const log = function () {
    if (adminConnections.length > 0) {
        for (var i in adminConnections) {
            try {
                adminConnections[i].emit('log', arguments);
            } catch (e) {
                adminConnections.splice(i, 1);
            }
        }

    }
    console.log.apply(console, arguments);
    //if (config.get('dev')) console.log.apply(console, arguments);
};
const notifyAdmin = (header, msg) => {
    if (adminConnections.length > 0) {
        for (var i in adminConnections) {
            try {
                adminConnections[i].emit('notifyAdmin', header, msg);
            } catch (e) {
                adminConnections.splice(i, 1);
            }
        }
    }
};  // send changes to admin if online

//  GET OBJECT WITH all CONTENT
const objectContent = async objectId => {
    let creators = {};
    let res = await db.objects.findOne({objectId: objectId});
    if (!res) throw {msg: true};

    res.rank = calculateRank(res.rang || {}, await getCreatorRank(res.tags.CreatorId));
    res.sights = [];
    res.soundtracks = [];


    if (typeof res.tags.CreatorId !== 'undefined' && res.tags.CreatorId.indexOf('-') === -1 && typeof creators[res.tags.CreatorId] === 'undefined') {
        res.creator = await db.users.findOne({userId: res.tags.CreatorId});
        creators[res.tags.CreatorId] = res.creator;
    } else if (typeof creators[res.tags.CreatorId] !== 'undefined') {
        res.creator = creators[res.tags.CreatorId];
    } else {
        res.creator = null;
    }

    let response = res;

    // sights data
    let cursor = db.sights.find({objectId: objectId});
    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
        let sightData = await db.sightsData.findOne({sightId: doc.sightId});
        let creator;
        let creatorId = doc.tags.CreatorId.indexOf('-') === -1 ? doc.tags.CreatorId : null;
        if (typeof creators[creatorId] !== 'undefined') {
            creator = creators[creatorId];
        } else {
            creator = creatorId ? await db.users.findOne({userId: creatorId}) : null;
            if (creatorId) creators[creatorId] = creator;
        }

        response.sights.push({
            objectId: doc.objectId,
            sightId: doc.sightId,
            rang: doc.rang || {},
            creationTime: doc.creationTime,
            location: doc.acquisitionData.deviceLocation || null,
            creator: creator,
            rank: calculateRank(doc.rang || {}, await getCreatorRank(doc.tags.CreatorId)),
            recogImage: await resizeImg(sightData.recogImage, 255)
        });
    }


    // tracks data
    cursor = db.tracks.find({objectId: objectId});
    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
        creatorId = doc.tags.CreatorId || null;
        creatorId = creatorId.indexOf('-') === -1 ? creatorId : null;


        let creator = creatorId ? await db.users.findOne({userId: creatorId}, {
            projection: {
                nickname: 1,
                userId: 1,
                avatar: 1
            }
        }) : null;

        if (creator !== null && typeof creator.avatar !== 'undefined' && creator.avatar !== null) {
            creator.avatar = await resizeImg(creator.avatar, 30);
        }

        let soundtracksData = (doc.mimeType === 'text/plain') ? (await db.soundtracksData.findOne({fileId: doc.fileId})).fileData : null;
        response.soundtracks.push({
            mimeType: doc.mimeType || 'audio/m4a',
            soundtrackId: doc.soundtrackId,
            tags: doc.tags,
            creationTime: doc.creationTime,
            creator: creator,
            rank: calculateRank(doc.rang || {}),
            fileData: soundtracksData,
        });

    }
    return response;
};
// GET user info
const getUser = async (userId, avatarSize) => {
    avatarSize = avatarSize || 100;
    let user = await db.users.findOne({userId}, {projection: {avatar: 1, nickname: 1, userId: 1}});
    user.avatar = await resizeImg(user.avatar, avatarSize);

    return user;
};
//  Pending
const addToPending = async (queryName, data, userId, objectId, comment) => {
    let id = data.id || null;
    objectId = objectId || null;
    // Проверять права перед вызовом этого метода
    console.log('request add to pending list');
    let duplicateKey = await db.pendingList.findOne({id: id});
    if (!duplicateKey) {
        await db.pendingList.insertOne({
            id: id,
            userId: userId,
            queryName: queryName,
            comment: comment,
            data: data,
            objectId: objectId,
            timestamp: timestamp()
        });
        // return {response: 'Ok'};
        return {response: 'Pending'};
    } else {
        log('Request id DUPLICATED !');
        // return {response: 'Ok'};
        return {response: 'Pending'};
    }

};
// Check for allow some user edit some object
const checkAllowObject = async (objectId, user) => {  // Can THROW !!! // CHECK AUTHOR || RIGHTS
    let obj = await db.objects.findOne({objectId: objectId}, {projection: {'tags.CreatorId': 1}});
    if (!obj) throw {
        response: 'Failed', // parent object not exist
        message: "Destination object doesn't exist"
    };
    if (obj.tags.CreatorId !== user.userId) {
        if (!(typeof user.rights !== 'undefined' && checkRights(user.rights))) throw {
            response: 'Failed', // parent object not exist
            message: "You haven't permission to this object !"
        };
    } else {
        log('AUTHOR Confirmed!');
    }
};
// Check for allow some user edit some object
const checkAllowSetTags = async (data, user) => {  // Can THROW !!! // CHECK AUTHOR || RIGHTS
    let doc;

    if (data.type === 'recordings') {
        console.log('recs' + data.soundtrackId);
        doc = await db.tracks.findOne({soundtrackId: data.soundtrackId}, {projection: {'tags.CreatorId': 1}});
    } else {
        console.log('objs' + data.objectId);
        doc = await db.objects.findOne({objectId: data.objectId}, {projection: {'tags.CreatorId': 1}});
    }

    if (!doc) throw {
        response: 'Failed', // object not exist
        message: "Destination object doesn't exist"
    };
    if (doc.tags.CreatorId !== user.userId) {
        if (!(typeof user.rights !== 'undefined' && checkRights(user.rights))) throw {
            response: 'Failed', // parent object not exist
            message: "You haven't permission to this object !"
        };
    } else {
        log('AUTHOR Confirmed!');
    }
};
//
const setTags = async (data) => {
    notifyAdmin('setTags', data);
    if (data.type === 'object') {    // for objects only
        let obj = await db.objects.findOne({objectId: data.objectId});
        if (!obj) throw {
            response: 'Failed', // parent object not exist
            message: "Destination object doesn't exist"
        };
        // CHECK AUTHOR || RIGHTS
        // if (obj.tags.CreatorId !== socket.userId && !(typeof socket.user.rights !== 'undefined' && checkRights(socket.user.rights))) throw {errmsg: 'Author failed'};

        let oneTag = {};
        for (let key in data.data) {  // action for any tag of list
            if (!data.data.hasOwnProperty(key)) continue;

            if (data.data[key] === null) {
                log('null');
                let a1 = "tags." + key;
                oneTag = {};
                oneTag[a1] = "";
                await db.objects.updateOne({objectId: obj.objectId}, {$unset: oneTag});
            } else {
                let a1 = "tags." + key;
                let a2 = data.data[key];
                oneTag = {};
                oneTag[a1] = a2;
                await db.objects.updateOne({objectId: obj.objectId}, {$set: oneTag});

                if (key === 'ObjectCoords') {   // if it ObjectCoords - parse it and save in parsed format too
                    try {
                        let a1 = "tags.coords";
                        let c = data.data[key].split(',');
                        let a2 = {
                            lat: c[0].split(':')[1] * 1,
                            long: c[1].split(':')[1] * 1,
                            rad: c[2].split(':')[1] * 1
                        };
                        oneTag = {};
                        oneTag[a1] = a2;

                        await db.objects.updateOne({objectId: obj.objectId}, {$set: oneTag});
                    } catch (e) {
                        log('error on parse ObjectCoords', e);
                    }
                }
            }
            oneTag = {};
        }
        //Update revision
        await db.objects.updateOne({objectId: obj.objectId}, {$inc: {revision: 1}});
        return ({response: 'Ok'});

    } else if (data.type === 'recordings') {
        let obj = await db.tracks.findOne({soundtrackId: data.soundtrackId});
        if (!obj) throw {
            response: 'Failed', // parent object not exist
            message: "Destination soundtrack doesn't exist"
        };
        // CHECK AUTHOR || RIGHTS
        // if (obj.tags.CreatorId !== socket.userId) {
        //     if (!(typeof socket.user.rights !== 'undefined' && checkRights(socket.user.rights))) throw {errmsg: 'Author failed'};
        // } else {
        //     log('AUTHOR Confirmed!');
        // }

        let oneTag = {};
        for (let key in data.data) {  // action for any tag of list
            if (!data.data.hasOwnProperty(key)) continue;

            if (data.data[key] === null) {
                log('null');
                let a1 = "tags." + key;
                oneTag = {};
                oneTag[a1] = "";
                await db.tracks.updateOne({soundtrackId: obj.soundtrackId}, {$unset: oneTag});
            } else {
                let a1 = "tags." + key;
                let a2 = data.data[key];
                oneTag = {};
                oneTag[a1] = a2;
                await db.tracks.updateOne({soundtrackId: obj.soundtrackId}, {$set: oneTag});
            }
            oneTag = {};
        }
        //Update revision
        await db.tracks.updateOne({soundtrackId: obj.soundtrackId}, {$inc: {revision: 1}});
        await db.objects.updateOne({objectId: obj.objectId}, {$inc: {revision: 1}});
        return ({response: 'Ok'});

    }
};
//
const removeObject = async (data) => {
    let {operand, objectId, id} = data;
    notifyAdmin('remove', data);
    if (operand === 'soundtrack') {
        let soundtrack = await db.tracks.findOne({soundtrackId: id});

        await db.tracks.deleteOne({soundtrackId: id});
        await db.soundtracksData.deleteOne({fileId: soundtrack.fileId});

        await db.objects.updateOne({objectId: soundtrack.objectId}, {$inc: {revision: 1}});
        return {response: 'Ok'};
    }
    if (operand === 'object') {
        log('remove obj:' + objectId);
        //get all sights & tracks
        let sights = db.sights.find({objectId: objectId});
        let tracks = db.tracks.find({objectId: objectId});

        //delete all fileData & recogImgs
        let sightsIndexes = [];
        let tracksIndexes = [];
        for (let sight = await sights.next(); sight != null; sight = await sights.next()) {
            sightsIndexes.push(sight.sightId); // find all imgs for delete
        }
        for (let track = await tracks.next(); track != null; track = await tracks.next()) {
            tracksIndexes.push(track.fileId);  // find all sounds for delete
        }
        await db.sightsData.deleteMany({sightId: {$in: sightsIndexes}});
        await db.soundtracksData.deleteMany({fileId: {$in: tracksIndexes}});

        //delete sights & tracks & geo-index
        await db.sights.deleteMany({objectId: objectId});
        await db.tracks.deleteMany({objectId: objectId});
        // await db.geo.deleteMany({sid: {$in: sightsIndexes}});

        //delete object
        await db.objects.deleteOne({objectId: objectId});
        return {response: 'Ok'};
    }
    if (operand === 'sight') {
        await db.sights.deleteOne({sightId: id});
        await db.sightsData.deleteOne({sightId: id});
        // await db.geo.deleteOne({sid: id});

        await db.objects.updateOne({objectId: objectId}, {$inc: {revision: 1}});
        return {response: 'Ok'};
    }

};

// addNew FUNCTIONS
const addNewObject = async (data) => {  // add new object to DB
    notifyAdmin('addNew', data);
    let dataObj = JSON.parse(data.data);
    dataObj.revision = 1;
    let sights = [];
    let soundtracks = [];
    // let geos = [];
    let sightsData = [];
    let soundtracksData = [];

    // slice sights
    if (typeof dataObj.sights !== 'undefined' && Object.keys(dataObj.sights).length > 0) {
        for (let key in dataObj.sights) {
            if (!dataObj.sights.hasOwnProperty(key)) continue;
            //prepare geo-indexing
            // if (typeof dataObj.sights[key].acquisitionData !== 'undefined') {
            //     let geo = {};
            //     let g = dataObj.sights[key].acquisitionData.deviceLocation;
            //     const earthR = 6371000;
            //
            //     geo.sid = key;
            //     geo.y = parseInt(Math.sin(g.latitude) * (earthR + g.altitude));
            //     geo.x = parseInt(Math.cos(g.longitude) * Math.cos(g.latitude) * (earthR + g.altitude));
            //     geo.z = parseInt(Math.sin(g.longitude) * Math.cos(g.latitude) * (earthR + g.altitude));
            //     geos.push(geo);
            // }

            log('photo', dataObj.sights[key].recogImage.length);
            //log( 'geo' , geos );
            dataObj.sights[key].objectId = dataObj.objectId;
            dataObj.sights[key].revision = 1;
            sightsData.push({
                sightId: key,
                recogImage: dataObj.sights[key].recogImage
            });
            delete dataObj.sights[key].recogImage;
            sights.push(dataObj.sights[key]);
        }
    }
    delete dataObj.sights;
    //slice sountracks
    if (typeof dataObj.recordings.soundtracks !== 'undefined' && Object.keys(dataObj.recordings.soundtracks).length > 0) {
        for (let key in dataObj.recordings.soundtracks) {
            if (!dataObj.recordings.soundtracks.hasOwnProperty(key)) continue;
            log(Object.keys(dataObj.recordings.soundtracks[key]));
            log('audio', dataObj.recordings.soundtracks[key].fileData.length);
            dataObj.recordings.soundtracks[key].objectId = dataObj.objectId;
            dataObj.recordings.soundtracks[key].revision = 1;

            soundtracksData.push({
                fileId: dataObj.recordings.soundtracks[key].fileId,
                fileData: dataObj.recordings.soundtracks[key].fileData
            });
            delete dataObj.recordings.soundtracks[key].fileData;
            soundtracks.push(dataObj.recordings.soundtracks[key]);
        }
    }
    delete dataObj.recordings;

    // if it contain ObjectCoords - parse it and save in parsed format too
    if (typeof dataObj.tags !== 'undefined' && typeof dataObj.tags.ObjectCoords !== 'undefined') {
        try {
            let c = dataObj.tags.ObjectCoords.split(',');
            dataObj.tags.coords = {
                lat: c[0].split(':')[1] * 1,
                long: c[1].split(':')[1] * 1,
                rad: c[2].split(':')[1] * 1
            };

        } catch (e) {
            log('error on parse ObjectCoords', e);
        }
    }

    dataObj.lastAccess = timestamp();

    await db.objects.insertOne(dataObj);
    if (sights.length > 0) db.sights.insertMany(sights);
    // if (geos.length > 0) db.geo.insertMany(geos);
    if (soundtracks.length > 0) db.tracks.insertMany(soundtracks);
    if (sightsData.length > 0) db.sightsData.insertMany(sightsData);
    if (soundtracksData.length > 0) db.soundtracksData.insertMany(soundtracksData);

    return ({response: 'Ok'});


};
const addNewSoundtrack = async (data) => {
    log('newSoundtrack');
    notifyAdmin('addNew', data);
    let dataObj = Object.assign({}, data);
    //check parameters of request
    if (typeof dataObj.fileId === 'undefined' || typeof dataObj.fileData === 'undefined') throw {
        response: 'Failed',
        reason: 'No enought parameters in addNew/soundtracks '
    };
    log('mime:', dataObj.mimeType);
    let soundtracksData = {
        mimeType: dataObj.mimeType || 'audio/m4a',
        fileId: dataObj.fileId,
        fileData: dataObj.fileData
    };

    delete dataObj.fileData;
    dataObj.revision = 1;

    await db.tracks.insertOne(dataObj);
    await db.soundtracksData.insertOne(soundtracksData);
    await db.objects.updateOne({objectId: dataObj.objectId}, {
        $inc: {revision: 1},
        $set: {lastAccess: timestamp()}
    });

    return {response: 'Ok'};

};
const rerecordSoundtrack = async (data) => {

    let soundtrackId = data.path.split('/recordings/')[1];
    let objectId = data.path.split('/recordings/')[0].split(':')[1];
    const params = data.params; //  FORMAT -  <mimeType>:<fileId>
    log('params: ', params);
    let fileId = params.indexOf(':') ? params.split(':')[1] : params;
    let fileData = data.data;
    let mimeType = params.indexOf(':') ? params.split(':')[0] : 'audio/m4a';
    log(objectId + '/' + soundtrackId + '/' + fileId);
    if (typeof soundtrackId === 'undefined' || typeof fileId === 'undefined' || typeof fileData === 'undefined') throw {
        response: 'Failed',
        reason: 'No enough parameters'
    };
    let soundtracksData = {mimeType, fileId, fileData};

    await db.soundtracksData.insertOne(soundtracksData);

    let tr = await db.tracks.findOne({objectId: objectId, soundtrackId: soundtrackId});
    await db.soundtracksData.deleteOne({fileId: tr.fileId}); //delete old fileData
    await db.tracks.updateOne({objectId: objectId, soundtrackId: soundtrackId}, {
        $set: {fileId: fileId},
        $inc: {revision: 1}
    }); //update tracks with new fileId

    await db.objects.updateOne({objectId: objectId}, {$inc: {revision: 1}});
    return {response: 'Ok'};

};
const addNewSight = async (data) => {
    notifyAdmin('addNew', data);
    if (typeof data.sightId === 'undefined' || typeof data.recogImage === 'undefined' || data.recogImage === null || typeof data.objectId === 'undefined') throw {
        response: 'Failed',
        message: 'Need more params',
        data: data
    };

    let sightsData = {
        sightId: data.sightId,
        recogImage: data.recogImage
    };

    delete data.recogImage;

    //prepare geo-indexing
    // let geo = {};
    // if (typeof data.acquisitionData !== 'undefined') {
    //
    //     let g = data.acquisitionData.deviceLocation;
    //     const earthR = 6371000;
    //     geo.sid = data.sightId;
    //     geo.y = parseInt(Math.sin(g.latitude) * (earthR + g.altitude));
    //     geo.x = parseInt(Math.cos(g.longitude) * Math.cos(g.latitude) * (earthR + g.altitude));
    //     geo.z = parseInt(Math.sin(g.longitude) * Math.cos(g.latitude) * (earthR + g.altitude));
    // }

    await db.sights.deleteOne({sightId: data.sightId});
    await db.sightsData.deleteOne({sightId: data.sightId});
    // await db.geo.deleteOne({sid: data.sightId});

    await db.sights.insertOne(data);
    await db.sightsData.insertOne(sightsData);
    // await db.geo.insertOne(geo);

    //revision
    await db.objects.updateOne({objectId: data.objectId}, {
        $inc: {revision: 1},
        $set: {lastAccess: timestamp()}
    });

    return {response: 'Ok'};
};
// get FUNCTIONS
const getSightImage = (data, cb) => {
    try {
        //log(data);
        if (typeof data.sightId !== 'undefined') {
            (async () => {
                let doc = await db.sightsData.findOne({sightId: data.sightId});
                if (typeof doc !== 'undefined' && doc) {
                    log(Object.keys(doc));
                    cb(doc.recogImage);
                } else {
                    log('getSightImage undefined data');
                    throw {
                        response: 'Failed', // parent object not exist
                        message: "Sight image doesn't exist"
                    };
                }
            })().catch(err => {
                log(err);
                if (typeof err.response !== 'undefined') {
                    cb(err);
                } else {
                    cb({
                        response: 'Failed',
                        message: 'Server error'
                    });
                }
            })
        } else {

            let response = {
                response: 'Failed',
                reason: 'No sightId in response',
                data: data
            };
            cb(response);
        }
    } catch (e) {
        log('f() getSightImage', e);
        let response = {
            response: 'Failed',
            message: 'Server error',
            data: data
        };
        cb(response);
    }

};
const getSoundtrackData = (data, cb) => {
    try {
        //log(data);
        if (typeof data.fileId !== 'undefined') {
            (async () => {
                let doc = await db.soundtracksData.findOne({fileId: data.fileId});
                if (typeof doc !== 'undefined' || typeof doc.fileData !== 'undefined') {
                    cb(doc.fileData);
                } else {
                    throw {
                        response: 'Failed', // parent object not exist
                        message: "Soundtrack doesn't exist"
                    };
                }
            })().catch(err => {
                log(err);
            })


        } else {
            cb({error: 'No file id in response'});
        }
    } catch (e) {
        log('f() getSoundtrackData', e);
        if (typeof err.response !== 'undefined') {
            cb(err);
        } else {
            cb({
                response: 'Failed',
                message: 'Server error'
            });
        }
    }
};

const resizeImg = async (img, size) => {
    let buf = await sharp(Buffer.from(img, 'base64'))
        .resize(size)
        .toBuffer();
    return buf.toString('base64');
};
const calculateRank = (r, creatorRank) => {
    creatorRank = creatorRank || null;
    let rank;
    let views = r.views || 0;
    let good = r.good || 0;
    let bad = r.bad || 0;

    rank = (good + 1) / (bad + good + 2);

    if (creatorRank) {    // absolute rank
        return (Math.round(rank * 100) / 100 + creatorRank) / 2;
    } else {  // current one rank
        return Math.round(rank * 100) / 100;
    }

};
const checkRights = (rights) => {
    return rights.indexOf('admin') > -1 || rights.indexOf('developer') > -1 || rights.indexOf('edit') > -1;
};

const getCreatorRank = async (creatorId) => {    // !!!!!!!!!!!!  ASYNC -AWAIT
    if (typeof creatorsCache[creatorId] === 'undefined') {
        let creator = await db.users.findOne({userId: creatorId}, {projection: {rang: 1}});
        creatorsCache[creatorId] = creator ? calculateRank(creator.rang || {}) : 0.5;
    }
    return creatorsCache[creatorId];
};
// ---------------------------------------------
//Socket __proto__ functions
const checkSocketRights = function (right) {
    try {
        return (this.user.rights.indexOf(right) > -1);
    } catch (err) {
        return false;
    }
};

const antiDdos_ = function () {
    // minGeneralInterval - minimal allowed interval between firs & last request for all connections time
    // minLast50Interval - minimal allowed interval between last 50 request
    const minGeneralInterval = 0.05, minLast50Interval = 0.05, pardonTime = 30;
    const addr = this.conn.remoteAddress.split(':');
    const ip = (addr[addr.length - 1]).split('.').join('');
    let socket = this;
    ipLog[ip] = ipLog[ip] || [];
    socket.requestLog = socket.requestLog || [];

    // check in black list by IP
    if (ipBlackList.hasOwnProperty(ip) && (timestamp() - ipBlackList[ip]) < pardonTime) {
        console.log('IP in black list');
        socket.disconnect();
        throw {msg: 'Black list.'};
    } else if (ipBlackList.hasOwnProperty(ip) && (timestamp() - ipBlackList[ip]) >= pardonTime) {
        delete ipBlackList[ip];
    }

    // count general request-frequency
    socket.requestLog.push([timestamp()]);
    ipLog[ip].push([timestamp()]);

    // check the general frequency for socket
    if (socket.requestLog.length > 50) {
        const count = socket.requestLog.length;
        const generalInterval = socket.requestLog[count - 1] - socket.requestLog[0];
        const last50Interval = socket.requestLog[count - 1] - socket.requestLog[count - 51];

        if (generalInterval / count < minGeneralInterval || last50Interval / 50 < minLast50Interval) {
            //too frequently
            ipBlackList[ip] = timestamp();
            console.log(`Add to ipBlackList: general - ${generalInterval / count} sec, last 50 - ${last50Interval / 50} sec`);
            throw {msg: 'Too frequently.'};
        }
    }

    // check the general frequency for ip

    if (ipLog[ip].length > 50) {
        const count = ipLog[ip].length;
        const generalInterval = ipLog[ip][count - 1] - ipLog[ip][0];

        if (generalInterval / count < minGeneralInterval) {
            //too frequently
            ipBlackList[ip] = timestamp();
            console.log(`Add to ipBlackList: general - ${generalInterval / count} sec`);
            throw {msg: 'Too frequently.'};
        }
        console.log(generalInterval / count);
    }

};

const antiDdos = function () {

};

// socket connection processing
module.exports = function (socket) {
    log('Client connected');

    socket.__proto__.rights = checkSocketRights;
    socket.__proto__.ddos = antiDdos;

    socket.on('appStarted', function (data) {
        try {
            socket.ddos();
            let userId = data.userId || null;
            let deviceId = data.deviceId || null;
            log('appStarted -', deviceId, userId);
            socket.user = {};
            socket.deviceId = deviceId;
            socket.currentState = {};

            connections[deviceId] = socket;
            (async () => {
                let devices = await db.devices.findOne({deviceId: deviceId});
                if (devices) {
                    await db.devices.updateOne({deviceId: deviceId}, {$set: {lastVisit: timestamp()}});
                    let user = await db.users.findOne({userId: devices.userId});
                    if (user) {
                        socket.user = user;
                        db.users.updateOne({userId: devices.userId}, {$set: {lastAccess: timestamp()}});
                        let msgs = db.msgQueue.find({userId: devices.userId});

                        for (var msg = await msgs.next(); msg !== null; msg = await msgs.next()) {
                            socket.emit('localMessage', msg.msg);
                        }
                        db.msgQueue.deleteMany({userId: devices.userId});

                    }
                    socket.userId = devices.userId;

                } else {
                    socket.userId = null;

                }
            })().catch(err => {
                log('appStarted', err);
            });

        } catch (e) {
            log('appStarted', e);
        }
    });
    socket.on('currentState', function (data) {
        try {
            socket.ddos();
            log('currentState');

            log(data);
            //Change user dev state
            for (var key in data) {
                if (!data.hasOwnProperty(key)) continue;
                socket.currentState[key] = data[key];
            }

            let response = {};
            db.objects.find({}, {"objectId": 1, "revision": 1, _id: 0, tags: 0, creationTime: 0}).forEach((doc) => {

                response[doc.objectId] = doc.revision;

            }, (err) => {

                //log('currentState resp -', response);
                if (isFunction(arguments[arguments.length - 1])) arguments[arguments.length - 1](response);

            });


        } catch (e) {
            log('currentState', e);
        }
    });
    socket.on('getObjectList', function (data, cb) {    // data.locationBox{minLat, minLong, max ...}
        try {
            socket.ddos();
            let startProc = (new Date).getTime();
            log('getObjectList');
            log(Object.keys(data));
            let l = data.locationBox || null;
            let u = data.creatorId || data.userId || null;
            const limitCount = data.limit || null;
            log(l);
            let response = {}, responseArray = [], parentList = [], parents = {}, parentsArray = [];
            const objProjection = {
                projection: {
                    "objectId": 1,
                    "revision": 1,
                    "rang": 1,
                    "tags": 1
                }
            };

            (async () => {
                if (l) {  // request with locationBox
                    let criteriaSights = {
                        "acquisitionData.deviceLocation.latitude": {$gte: l.minLat, $lte: l.maxLat},
                        "acquisitionData.deviceLocation.longitude": {$gte: l.minLong, $lte: l.maxLong}
                    };

                    let objList = [];

                    // STEP 1 - search by sights devLocation
                    let sights = db.sights.find(criteriaSights, {
                        limit: 100,
                        projection: {objectId: 1, acquisitionData: 1}
                    });
                    for (let sight = await sights.next(); sight !== null; sight = await sights.next()) {
                        objList.push(sight.objectId);
                        //console.log(sight);
                        response[sight.objectId] = {
                            location: sight.acquisitionData.deviceLocation || null
                        };
                    }

                    let docs = db.objects.find({objectId: {$in: objList}}, objProjection);
                    for (let doc = await docs.next(); doc !== null; doc = await docs.next()) {
                        response[doc.objectId].revision = doc.revision;
                        response[doc.objectId].rank = calculateRank(doc.rang || {}, await getCreatorRank(doc.tags.CreatorId));
                        if (typeof doc.tags !== 'undefined' && typeof doc.tags.ParentObjectId !== 'undefined') {
                            response[doc.objectId].parent = doc.tags.ParentObjectId;
                        }
                    }

                    // STEP 2 - Find objects with tag ObjectCoords
                    let criteriaObjs = {
                        "tags.coords.lat": {$gte: l.minLat, $lte: l.maxLat},
                        "tags.coords.long": {$gte: l.minLong, $lte: l.maxLong}
                    };
                    let coordDocs = db.objects.find(criteriaObjs, objProjection);
                    for (let doc = await coordDocs.next(); doc !== null; doc = await coordDocs.next()) {
                        response[doc.objectId] = {};
                        response[doc.objectId].revision = doc.revision;
                        response[doc.objectId].rank = calculateRank(doc.rang || {}, await getCreatorRank(doc.tags.CreatorId));
                        if (typeof doc.tags.ParentObjectId !== 'undefined') {
                            response[doc.objectId].parent = doc.tags.ParentObjectId;
                        }
                    }

                }

                if (u) {    //  (if query have userId parameter )
                    log(`userId - ${u}`);
                    //  select user's groups
                    let docs = db.objects.find({userId: u, objectType : {$ne: 'object'}}, objProjection);
                    for (let doc = await docs.next(); doc !== null; doc = await docs.next()) {
                        response[doc.objectId].revision = doc.revision;
                        response[doc.objectId].rank = calculateRank(doc.rang || {}, await getCreatorRank(doc.tags.CreatorId));
                        if (typeof doc.tags !== 'undefined' && typeof doc.tags.ParentObjectId !== 'undefined') {
                            response[doc.objectId].parent = doc.tags.ParentObjectId;
                        }
                    }

                    //  select user's objects by sights
                    let sights = await db.sights.find({"tags.CreatorId": u}, {projection: {objectId: 1}}).toArray();
                    let objList = sights.map(item => item.objectId);
                    let objects = db.objects.find({objectId: {$in: objList}}, objProjection);
                    for (let doc = await objects.next(); doc !== null; doc = await objects.next()) {
                        response[doc.objectId] = {};
                        response[doc.objectId].revision = doc.revision;
                        response[doc.objectId].rank = calculateRank(doc.rang || {}, await getCreatorRank(doc.tags.CreatorId));
                        if (typeof doc.tags.ParentObjectId !== 'undefined') {
                            response[doc.objectId].parent = doc.tags.ParentObjectId;
                        }
                    }
                    if (u) log(Object.keys(response).length);
                }

                //  convert response to array, sort and splice
                responseArray = Object.keys(response).map(name => {
                    response[name].objectId = name;
                    return response[name];
                }).sort((a, b) => {
                    if (a.rank < b.rank) return 1;
                    if (a.rank > b.rank) return -1;
                    return 0;
                });
                if (limitCount) responseArray = responseArray.splice(0, limitCount || responseArray.length);

                //  get the parents list of filtered objects
                parentList = responseArray.map(item => item.parent).filter(id => !!id);

                // STEP 3   find all parents
                let recursionDeep = 10;
                for (let deep = 0; deep < recursionDeep; deep++) {
                    if (parentList.length > 0) { //  turn it to RECURSIVE Func
                        let curParentList = JSON.parse(JSON.stringify(parentList));
                        parentList = [];
                        //console.log(deep, curParentList);
                        docs = db.objects.find({objectId: {$in: curParentList}}, objProjection);
                        for (let doc = await docs.next(); doc !== null; doc = await docs.next()) {
                            parents[doc.objectId] = {};
                            parents[doc.objectId].revision = doc.revision;
                            parents[doc.objectId].rank = calculateRank(doc.rang || {}, await getCreatorRank(doc.tags.CreatorId));

                            if (typeof doc.tags !== 'undefined' && typeof doc.tags.ParentObjectId !== 'undefined') {
                                parentList.push(doc.tags.ParentObjectId);
                            }
                        }
                    } else {
                        break;
                    }
                }

                // put parents to list
                parentsArray = Object.keys(parents).map(name => {
                    parents[name].objectId = name;
                    return parents[name];
                });

                //  answer with objects list & parents list
                cb(responseArray.concat(parentsArray));
                if (u) log(responseArray.concat(parentsArray));
                console.log('execution time: ' + ((new Date).getTime() - startProc));
            })().catch((err) => {
                log(err);
            });

        } catch (e) {
            log('getObjectList', e);
        }
    });
    socket.on('appStopped', function () {
        try {
            socket.ddos();
            log('appStopped ' + socket.deviceId);

            // socket.emit('addNew', JSON.stringify({messageId:'123123123'}));
            let response = {response: 'Ok'};

            if (isFunction(arguments[arguments.length - 1])) arguments[arguments.length - 1](response);
        } catch (e) {
            log('appStopped', e);
        }
    });
    socket.on('addNew', function (data, cb) {
        (async () => {
            socket.ddos();
            log('addNew');

            console.log(data.path);
            console.log(data.params);

            if (data.path.indexOf('/recordings') > -1) {  // object:<id>/recordings/<id>
                let dataObj = JSON.parse(data.data);
                dataObj.id = data.id || null;
                dataObj.objectId = data.path.split('/')[0].split(':')[1];
                log('parsed id:', dataObj.objectId);

                await checkAllowObject(dataObj.objectId, socket.user);
                if (socket.rights('trusted') || socket.rights('admin')) {
                    cb(await addNewSoundtrack(dataObj)); // if sountrack
                } else {
                    cb(await addToPending('addNewSoundtrack', dataObj, socket.user.userId, dataObj.objectId, data.comment));
                }

            } else if (data.params.indexOf('sight') > -1) {
                let dataObj = JSON.parse(data.data);
                dataObj.id = data.id || null;
                dataObj.objectId = data.path.split(':')[1];

                await checkAllowObject(dataObj.objectId, socket.user);
                if (socket.rights('trusted') || socket.rights('admin')) {
                    cb(await addNewSight(dataObj));  // if sight
                } else {
                    cb(await addToPending('addNewSight', dataObj, socket.user.userId, dataObj.objectId, data.comment));
                }

            } else if (data.path.indexOf('/') === -1) {
                let dataObj = JSON.parse(data.data);
                if (socket.rights('trusted') || socket.rights('admin')) {
                    cb(await addNewObject(data));  // if object
                } else {
                    let objectId = data.path.split(':')[1];
                    cb(await addToPending('addNewObject', data, socket.user.userId, dataObj.objectId, data.comment));
                }

            }

            delete data.data;
            console.log(data);
        })().catch(err => {
            log('error on addNew - ', err);
            if (typeof err.response !== 'undefined') {
                cb(err);
            } else {
                cb({
                    response: 'Failed',
                    message: 'Server error'
                });
            }
        })

    });
    socket.on('objectData', function (data, cb) {
        let startProc = (new Date).getTime();
        (async () => {

            log('objectData');
            log(data);
            let response = {};
            socket.ddos();

            let res = await db.objects.findOne({objectId: data.objectId});
            if (!res) throw {
                response: 'Failed', // parent object not exist
                message: "Object doesn't exist"
            };

            response.revision = res.revision;
            delete res.revision;

            res.sights = {};
            res.recordings = {soundtracks: {}};

            res.rank = calculateRank(res.rang || {}, await getCreatorRank(res.tags.CreatorId));

            if (typeof res.tags.coords !== 'undefined') {
                delete res.tags.coords;
            }
            response.data = res;

            let cursor = db.sights.find({objectId: data.objectId});
            for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
                response.data.sights[doc.sightId] = doc;
            }
            cursor = db.tracks.find({objectId: data.objectId});
            for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
                doc.rank = calculateRank(doc.rang || {}, await getCreatorRank(doc.tags.CreatorId));   // tracks rank
                response.data.recordings.soundtracks[doc.soundtrackId] = doc;
            }

            response.data = JSON.stringify(response.data);
            cb(response);
        })().catch((err) => {
            log(err);
            if (typeof err.response !== 'undefined') {
                cb(err);
            } else {
                cb({
                    response: 'Failed',
                    message: 'Server error'
                });
            }
        });
        console.log('execution time: ' + ((new Date).getTime() - startProc));
    });
    socket.on('getSightImage', function (data, cb) {
        socket.ddos();
        log('getSightImage');
        getSightImage(data, cb);
    });
    socket.on('getSoundtrackData', function (data, cb) {
        socket.ddos();
        log('getSoundtrackData');
        getSoundtrackData(data, cb);
    });
    socket.on('remove', function (data, cb) {
        (async () => {
            socket.ddos();
            log('remove');
            log(data);

            let operand;
            let objectId;
            let id;
            let comment = data.comment;

            if (data.path === '' && data.params.indexOf('sight') === -1) {
                log('remove object');
                operand = 'object';
                objectId = data.params.split(':')[1];
            } else if (data.path.indexOf('/recordings') > -1) {
                log('remove soundtrack');
                operand = 'soundtrack';
                id = data.params;
                objectId = data.path.split('/')[0].split(':')[1];
            } else if (data.params.indexOf('sight') > -1) {
                log('remove sight');
                operand = 'sight';
                id = data.params.split(':')[1];
            }

            let newData = {operand, objectId, id, comment};

            if (socket.rights('trusted') || socket.rights('admin')) {

                cb(await removeObject(newData));
            } else {
                cb(await addToPending('remove', newData, socket.user.userId, newData.objectId, data.comment));
            }

        })().catch((err) => {
            log('err on remove', err);
            let response = {
                response: 'Failed'
            };
            cb(response);
        });

    });
    socket.on('setTags', function (data, cb) {
        try {
            socket.ddos();
            log('setTags');


            //parse params
            if (data.path.indexOf('/recordings/') > -1) {   // it's record
                data.type = 'recordings';
                data.objectId = data.path.split('/recordings/')[0].split(':')[1];
                data.soundtrackId = data.path.split('/recordings/')[1];
                log(data.objectId, '/', data.soundtrackId);
                data.data = JSON.parse(data.data);
            } else {  //  it's object
                data.objectId = data.path.split(':')[1];
                data.type = data.path.split(':')[0];
                data.data = JSON.parse(data.data);
            }
            log(data);
            (async () => {
                await checkAllowSetTags(data, socket.user);
                if (socket.rights('trusted') || socket.rights('admin')) {
                    cb(await setTags(data, cb));
                } else {
                    cb(await addToPending('setTags', data, socket.user.userId, data.objectId, data.comment));
                }

            })().catch((err) => {
                log('err on set tags', err);
                if (typeof err.response !== 'undefined') {
                    cb(err);
                } else {
                    cb({
                        response: 'Failed',
                        message: 'Server error'
                    });
                }
            });
        } catch (e) {
            log('setTags', e);
        }
    });
    socket.on('setSoundtrackFile', function (data, cb) {
        (async () => {
            socket.ddos();
            let objectId = data.path.split('/recordings/')[0].split(':')[1];
            log('setSoundtrackFile');
            await checkAllowObject(objectId, socket.user);
            if (socket.rights('trusted') || socket.rights('admin')) {
                cb(await rerecordSoundtrack(data));
            } else {
                cb(await addToPending('setSoundtrackFile', data, socket.user.userId, objectId, data.comment));
            }

        })().catch(err => {
            log('error on addNew track - ', err);
            if (typeof err.response !== 'undefined') {
                cb(err);
            } else {
                cb({
                    response: 'Failed',
                    message: 'Server error'
                });
            }
        });
    });
    socket.on('getObjectStatus', function (data, cb) {
        try {
            socket.ddos();
            log('getObjectStatus');
            let objectId, id, operand;
            if (data.path === '') {//object
                objectId = data.params.split(':')[1];
                operand = 'object';
            } else if (data.path.indexOf('/record') > -1) {
                id = data.params.split(':')[1] || data.params;
                operand = 'soundtrack';
            } else {
                id = data.params.split(':')[1] || data.params;
                operand = 'sight';
            }

            // processing
            if (operand === 'object') {
                (async () => {
                    let doc = await db.objects.findOne({objectId: objectId}, {projection: {'revision': 1, '_id': 0}});
                    cb({
                        revision: doc ? doc.revision : 0,
                        status: doc ? 1 : 0
                    });
                })().catch(err => log(err));
            }
            if (operand === 'sight') {
                (async () => {
                    let doc = await db.sights.findOne({sightId: id}, {projection: {'revision': 1, '_id': 0}});
                    cb({
                        revision: doc ? doc.revision : 0,
                        status: doc ? 1 : 0
                    });
                })().catch(err => log(err));
            }
            if (operand === 'soundtrack') {
                (async () => {
                    let doc = await db.tracks.findOne({soundtrackId: id}, {projection: {'revision': 1, '_id': 0}});
                    cb({
                        revision: doc ? doc.revision : 0,
                        status: doc ? 1 : 0
                    });
                })().catch(err => log(err));
            }

            if (!operand) {
                cb({
                    response: 'Failed'
                });
            }
        } catch (e) {
            log('getObjectStatus', e);
        }
    });
    socket.on('requestUserStatus', function (data, cb) {
        try {
            socket.ddos();
            let userId = data.userId || socket.userId || null;
            let resp = {response: 'Ok'};
            if (userId && userId === socket.userId) {
                resp.rights = socket.user.rights || '';
                resp.nickname = socket.user.nickname || null;
                if (data.withAvatar) resp.avatar = socket.user.avatar || null;

                cb(resp);
            } else {
                (async () => {
                    let u = await db.users.findOne({userId: userId}, {projection: {rights: 1, nickname: 1, avatar: 1}});
                    resp.rights = u ? u.rights : '';
                    resp.nickname = u ? u.nickname : null;
                    if (data.withAvatar) resp.avatar = u ? u.avatar : null;

                    cb(resp);
                })().catch(err => {
                    log(err);
                });
            }

        } catch (e) {
            log('requestUserStatus', e);
        }
    });
    socket.on('getPendingMessageIds', function (data, cb) {
        (async () => {
            let list = [];
            log ('getPendingMessageIds', data);
            const userId = data.userId || socket.user.userId;
            const cursor = db.pendingList.find({userId});
            for (let pend = await cursor.next(); pend !== null; pend = await cursor.next()) {
                list.push(pend.id);
            }
            cb(list);
        })().catch(err => {
            log(err);
            cb({
                response: 'Failed',
                reason: 'Server error.'
            });
        });
    });

    socket.on('setExperience', function (data, cb) {
        socket.ddos();
        // { 'object:987F67C9-0132-4D81-841E-DB842D977D78': { like: true, count: 1 } }
        let startProc = (new Date).getTime();
        log('setExperience');
        log(data);
        (async () => {
            for (let path in data) {
                if (!data.hasOwnProperty(path)) continue;
                let d = data[path], type, id, objectId;

                //Parse objectId, update access time
                objectId = path.split('/')[0].split(':')[1];
                await db.objects.updateOne({objectId: objectId}, {$set: {lastAccess: timestamp()}});

                // STEP 1 - PATH PARSING FOR THIS OBJECT
                if (path.indexOf('/recordings') > -1) {  // object:<id>/recordings/<id>
                    type = 'tracks';
                    id = path.split('/recordings/')[1];
                } else if (path.indexOf('sight') > -1) {
                    type = 'sights';
                    id = path.split('/sight:')[1];
                } else if (path.indexOf('/') === -1) {// object
                    type = 'objects';
                    id = path.split(':')[1];
                }

                // STEP 2 - ADD RATING FOR THIS OBJECT

                if (typeof d.like !== 'undefined') {
                    log('ADD RATING FROM LIST');
                    let val = d.like;

                    //Проверить таблицу оценок
                    let existsRate = await db.rating.findOne({
                        userId: socket.userId,
                        id: id
                    }, {projection: {'value': 1}});
                    // записать в таблицу если оценки нет, или она другая
                    if (!existsRate || existsRate.value !== val) {
                        await db.rating.updateOne({
                            userId: socket.userId || null,
                            path: path,
                            id: id,
                        }, {
                            $set: {
                                value: val
                            }
                        }, {
                            upsert: true
                        });
                    }

                    // Добавить или заменить оценку В ОБЪЕКТЕ
                    if (type && id) {   //  Если путь распарсен правильно
                        let selector, updater;
                        // SELECTOR
                        if (type === 'objects') selector = {objectId: id};
                        if (type === 'sights') selector = {sightId: id};
                        if (type === 'tracks') selector = {soundtrackId: id};

                        //UPDATER
                        if (existsRate && existsRate.value !== val) { // Изменение оценки
                            if (val) {
                                updater = {$inc: {'rang.good': 1, 'rang.bad': -1}};
                            } else {
                                updater = {$inc: {'rang.good': -1, 'rang.bad': 1}};
                            }

                        } else if (!existsRate) {  // засчитываем новую оценку
                            if (val) {
                                updater = {$inc: {'rang.good': 1}};  //Хорошо
                            } else {
                                updater = {$inc: {'rang.bad': 1}};  // Плохо
                            }

                        }

                        //UPDATE OBJECT RANG
                        if (existsRate && existsRate.value !== val || !existsRate) await db[type].updateOne(selector, updater);

                        //UPDATE CREATOR RANG
                        let ob = await db[type].findOne(selector, {projection: {'tags.CreatorId': 1, rang: 1}});
                        let creatorSelector = ob ? {userId: ob.tags.CreatorId} : null;
                        if (((existsRate && existsRate.value !== val) || !existsRate) && creatorSelector) await db.users.updateOne(creatorSelector, updater);

                        //  ---------UPDATE CACHE of Creators RANK--------------
                        let curentAuthorId = ob ? {userId: ob.tags.CreatorId} : null;
                        let creator, creatorRank, objectRank;
                        if (curentAuthorId) creator = await db.users.findOne({userId: curentAuthorId}, {projection: {rang: 1}});
                        if (creator) {   // calc creator RANK
                            creator.rang = creator.rang || {};
                            if (val) creator.rang.good++; else creator.rang.bad++;
                            creatorRank = calculateRank(creator.rang);
                        }
                        // SAVE CREATORS RANK TO CACHE
                        if (creatorRank) creatorsCache[curentAuthorId] = creatorRank;

                        //------------------------------------------

                    } else {  // Ошибка парсинга
                        log('Ошибка парсинга для Rating');
                        cb({
                            response: 'Failed',
                            reason: 'Path parsing error: ' + path
                        });
                    }

                }

                // STEP 3 - ADD COUNTER FOR THIS OBJECT
                if (typeof d.counter !== 'undefined') {
                    // ADD VIEWS FROM LIST
                    console.log('Add views');
                    let count = d.counter;

                    // записать в таблицу просмотров
                    await db.views.updateOne({
                        userId: socket.userId || null,
                        path: path,
                        id: id
                    }, {
                        $inc: {'views': count}
                    }, {upsert: true});

                    // Добавить просмотры объекту
                    if (type && id) {   //  Если путь распарсен правильно
                        //Добавляем просмотров в сам объект
                        if (type === 'objects') await db[type].updateOne({objectId: id}, {$inc: {'rang.views': count}});
                        if (type === 'sights') await db[type].updateOne({sightId: id}, {$inc: {'rang.views': count}});
                        if (type === 'tracks') await db[type].updateOne({soundtrackId: id}, {$inc: {'rang.views': count}});


                    } else {  // Ошибка парсинга
                        log('Ошибка парсинга для Views');
                        cb({
                            response: 'Failed',
                            reason: 'Path parsing error:' + path
                        });
                    }
                }


            }
            cb({
                response: 'Ok'
            });
        })().catch(err => {
            log(err);
            cb({
                response: 'Failed',
                reason: 'Server error.'
            });
        });
        console.log('execution time: ' + ((new Date).getTime() - startProc));
    });

    //  handlers only for administrative tool
    socket.on('adminLogin', function (data, cb) {
        try {
            if (data.secret === 'triglavKey') {
                log('admin here');
                socket.user = {admin: true, rights: 'create;edit;developer;admin'};
                if (typeof data.login !== 'undefined' && data.login.length > 2) socket.user.name = data.login;
                adminConnections.push(socket);
                cb({response: 'Ok'});
            } else {
                log('admin secret wrong');
                cb({response: 'Bad'});
            }
        } catch (e) {
            log('adminLogin', e);
        }
    });
    socket.on('adminGetObjectList', function (data, cb) {
        (async () => {
            socket.ddos();
            let startProc = (new Date).getTime();
            let skip = data.skip || 0;
            let userId = data.userId || null;
            let response = {
                objs: [],
                sights: {},
                status: true
            };

            //check rights
            if (!socket.hasOwnProperty('user') || !socket.rights('create')) throw {msg: true};

            // for creators set automatic filtering
            userId = !socket.rights('edit') ? socket.user.userId : userId;

            //set filter
            let selector = userId ? {'tags.CreatorId': userId} : {};

            let objs = [];
            response.count = await db.objects.countDocuments(selector);
            let cursor = db.objects.find(selector, {limit: 12, skip: skip, sort: [['_id', 'desc']]});
            for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
                response.objs.push(doc);
                objs.push(doc.objectId);
            }
            cursor = db.sights.find({objectId: {$in: objs}});
            for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
                response.sights[doc.sightId] = doc;
            }
            cb(response);


            console.log('adminGetList exec time: ' + ((new Date).getTime() - startProc));

        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminGetListOfObjects', function (data, cb) {
        (async () => {
            socket.ddos();
            let startProc = (new Date).getTime();
            let skip = data.skip || 0;
            let userId = data.userId || null;
            let filterGroupId = data.filterGroupId || null;
            let filterObjectType = data.filterObjectType || null;
            let filterObjectClass = data.filterObjectClass || null;
            const line = (data.line && data.line.length >= 2) ? data.line.toLowerCase() : null;
            let response = {
                objs: {},
                status: true
            };

            //check rights
            if (!socket.hasOwnProperty('user') || !socket.rights('create')) throw {msg: true};

            // for creators set automatic filtering
            userId = !socket.rights('edit') ? socket.user.userId : userId;

            //set filters
            let selector = {};
            if (filterObjectType) selector['objectType'] = filterObjectType;
            if (filterObjectClass) selector['tags.ObjectClass'] = filterObjectClass;
            if (filterGroupId) selector['tags.ParentObjectId'] = filterGroupId;
            if (userId) selector['tags.CreatorId'] = userId;

            response.count = await db.objects.countDocuments(selector);

            let options = {limit: 12, skip: skip, sort: [['_id', 'desc']], projection: {objectId: 1, tags: 1}};
            if (line) {
                options = {sort: [['_id', 'desc']], projection: {objectId: 1, tags: 1}};
                response.count = 0;
            }

            let cursor = db.objects.find(selector, options);

            for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
                if (line) { // !!! with search-line

                    if (Object.keys(doc.tags).reduce((acc, cur) => {
                        if (typeof doc.tags[cur] === 'string') {
                            return (doc.tags[cur].toLowerCase().indexOf(line) > -1) ? true : acc;
                        } else {
                            return acc;
                        }

                    }, false)) {
                        response.objs[doc.objectId] = null;
                        response.count++;
                    }
                } else {    // only filters
                    response.objs[doc.objectId] = null;
                }
            }
            cb(response);

            console.log('adminGetListOfObjects exec time: ' + ((new Date).getTime() - startProc));
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminGetObjectContent', function (data, cb) {
        (async () => {
            socket.ddos();
            let {objectId} = data;
            console.log('getObjCont - ', objectId);
            let startProc = (new Date).getTime();

            let selector = {objectId: objectId};

            //check rights
            if (!socket.rights('create')) throw {msg: true};
            if (!socket.rights('edit')) selector['tags.CreatorId'] = socket.user.userId;

            if ((await db.objects.countDocuments(selector)) < 1) throw {msg: true};

            let obj = await objectContent(objectId);
            cb(obj);

            console.log('adminGetObjCont exec time: ' + ((new Date).getTime() - startProc));
        })().catch((err) => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminSetSpeekText', function (data, cb) {
        (async () => {
            socket.ddos();
            log('adminSetSpeekText', data);
            let selector = {soundtrackId: data.soundtrackId, mimeType: 'text/plain'};
            //check rights
            if (data.fileData.length > 1000) throw {msg: true};
            if (!socket.rights('create')) throw {msg: true};
            if (!socket.rights('admin')) selector['tags.CreatorId'] = socket.user.userId;

            let soundtrack = await db.tracks.findOne(selector);
            if (!soundtrack)  throw {msg: true};
            if (!soundtrack.tags.hasOwnProperty('ParentSoundtrack') && data.fileData.length > 100)  throw {msg: true};

            await db.soundtracksData.updateOne({fileId: soundtrack.fileId}, {$set: {fileData: data.fileData}});

            cb({status: true});
        })().catch((err) => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminCheckRevision', function ({revision, objectId}, cb) {
        (async () => {
            socket.ddos();
            let selector = {objectId: objectId};
            //check rights
            if (!socket.rights('create')) throw {msg: true};
            if (!socket.rights('edit')) selector['tags.CreatorId'] = socket.user.userId;

            let res = await db.objects.findOne(selector);
            if (!res) throw {msg: 'No such object or access denied'};

            cb((res.revision !== revision) ? await objectContent(objectId) : {});
        })().catch((err) => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminUpdateTags', function (data, cb) {
        (async () => {
            socket.ddos();
            let objectId = data.objectId || null;
            let tags = data.tags || null;
            if (!objectId || !tags) throw {msg: 'Params error'};
            //security
            if (!socket.rights('edit') && !socket.rights('create')) throw {msg: 'Permission denied'};
            let selector = !socket.rights('edit') ? {
                objectId: data.objectId,
                'tags.creatorId': socket.user.userId
            } : {objectId: data.objectId};

            let updated = await db.objects.updateOne(selector, {$set: {tags: data.tags}, $inc: {revision: 1}});
            console.log(updated);
            if (updated.matchedCount > 0) {
                cb({response: 'Ok'});
            } else {
                cb({});
            }

        })().catch((err) => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });

    });
    socket.on('adminDeviceList', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('admin')) throw {msg: 'Permission denied'};
            let devices = {};
            for (let key in connections) {
                if (!connections.hasOwnProperty(key)) continue;
                devices[key] = {
                    currentState: connections[key].currentState || null,
                    userId: connections[key].userId || null,
                    user: connections[key].user || null
                };
            }
            cb(devices);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });

    });
    socket.on('adminUsersList', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('admin')) throw {msg: 'Permission denied'};
            let users = {};
            let cursor = db.users.find({}, {sort:[['lastAccess', 'desc']]});
            for (let u = await cursor.next(); u !== null; u = await cursor.next()) {
                users[u.userId] = u;
            }
            cb(users);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });

    });
    socket.on('adminRemoveUser', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('admin')) throw {msg: 'Permission denied'};
            await db.devices.deleteMany({userId: data.userId});
            await db.users.deleteOne({userId: data.userId});
            await db.pendingList.deleteMany({userId: data.userId});
            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });

    });
    socket.on('adminSendEmail', function (data, cb) {
        try {
            socket.ddos();
            if (validator.validate(data.to && socket.rights('admin'))) {
                mailer.send(data);
                cb(true);
            } else {
                cb(false);
            }
        } catch (e) {
            log(e);
        }
    });
    socket.on('adminDeviceMsg', function (data, cb) {
        try {
            socket.ddos();
            if (socket.rights('admin') && typeof data.uid !== 'undefined' && typeof data.msg !== 'undefined') {
                if (typeof data.devId !== 'undefined' && typeof connections[data.devId] !== 'undefined') {
                    connections[data.devId].emit('localMessage', data.msg, (answer) => {
                        //cb(true);
                    });
                } else if (typeof  data.uid !== 'undefined') {
                    let userOnline;
                    for (let did in connections) {
                        if (!connections.hasOwnProperty(did)) continue;
                        if (connections[did].userId === data.uid) {
                            connections[did].emit('localMessage', data.msg);
                            userOnline = true;
                            break;
                        }
                    }
                    if (!userOnline) {
                        // insert message to queue
                        db.msgQueue.insertOne({
                            userId: data.uid,
                            msg: data.msg,
                            ts: timestamp()
                        });
                        cb(true);
                    }
                }

            }
        } catch (err) {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        }
    });
    socket.on('adminRemoveItem', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('admin')) throw {msg: 'Permission denied'};
            if (!data.hasOwnProperty('type') || !data.hasOwnProperty('id') || !data.hasOwnProperty('objectId')) throw {msg: 1};

            if (data.type === 'sight') {
                await db.sights.deleteOne({sightId: data.id});
                await db.sightsData.deleteOne({sightId: data.id});
                // await db.geo.deleteOne({sid: data.id});

                await db.objects.updateOne({objectId: data.objectId}, {$inc: {revision: 1}});
            } else if (data.type === 'track') {
                let tr = await db.tracks.findOne({soundtrackId: data.id});
                await db.tracks.deleteOne({soundtrackId: data.id});
                await db.soundtracksData.deleteOne({fileId: tr.fileId});
                await db.objects.updateOne({objectId: data.objectId}, {$inc: {revision: 1}});
            } else if (data.type === 'object') {
                log('remove object start');
                //get all sights & tracks
                let sights = db.sights.find({objectId: data.objectId});
                let tracks = db.tracks.find({objectId: data.objectId});

                //delete all fileData & recogImgs
                let sightsIndexes = [];
                let tracksIndexes = [];
                for (let sight = await sights.next(); sight != null; sight = await sights.next()) {
                    sightsIndexes.push(sight.sightId); // find all imgs for delete
                }
                for (let track = await tracks.next(); track != null; track = await tracks.next()) {
                    tracksIndexes.push(track.fileId);  // find all sounds for delete
                }
                await db.sightsData.deleteMany({sightId: {$in: sightsIndexes}});
                await db.soundtracksData.deleteMany({fileId: {$in: tracksIndexes}});

                //delete sights & tracks & geo-index
                await db.sights.deleteMany({objectId: data.objectId});
                await db.tracks.deleteMany({objectId: data.objectId});
                // await db.geo.deleteMany({sid: {$in: sightsIndexes}});
                await db.pendingList.deleteMany({objectId: data.objectId});
                //delete object
                await db.objects.deleteOne({objectId: data.objectId});
            }
            cb(true);
        })().catch((err) => {
            err.msg = err.msg || null;
            if (err.msg) {

            } else {
                log(err);
            }
            cb(false);
        });

    });
    socket.on('adminGetUserInfo', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('admin') && !socket.rights('edit') && !socket.rights('create')) throw {msg: 'Permission denied'};
            if (!socket.rights('admin') && !socket.rights('edit')) data = socket.user.userId;
            let objs = [], devices = [];

            let user = await db.users.findOne({userId: data});
            user.rate = calculateRank(user.rang || {});

            let cursor = db.devices.find({userId: data});
            for (let d = await cursor.next(); d !== null; d = await cursor.next()) {
                devices.push(d);
            }
            cb({
                user: user,
                devices: devices,
                objects: objs
            });
        })().catch(err => {
            log(err);
            cb(null);
        });
    });
    socket.on('adminSetRights', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('admin')) throw {msg: 'Permission denied'};
            await db.users.updateOne({userId: data.userId}, {$set: {rights: data.rights}});
            cb(true);
        })().catch(err => {
            log(err);
            cb(false);
        });
    });
    socket.on('adminSaveSoundtrackDescription', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('create')) throw {msg: 'Permission denied'};

            if (data.objectId.length > 10 && data.soundtrackId.length > 10 && data.Description.length >= 0) {
            } else throw {msg: 'Error in params for adminSaveSoundtrackDescription'};
            let selector = {objectId: data.objectId, soundtrackId: data.soundtrackId};

            if (!socket.rights('edit') && !socket.rights('admin')) selector['tags.CreatorId'] = socket.user.userId;

            let updated = await db.tracks.updateOne(selector, {
                $set: {'tags.Description': data.Description}
            });
            if (!updated.matchedCount > 0) throw {msg: 'Updated count = 0'};
            await db.objects.updateOne({objectId: data.objectId}, {$inc: {revision: 1}});
            cb(true);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(false);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminNewSpeek', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('edit')) throw {msg: 'Permission denied'};

            if (data.objectId.length < 10 || data.language.length < 2 || data.speekText.length > 1000 || data.speekText.length < 2)
                throw {msg: 'Error in params for adminNewSpeek'};

            const fileId = uuid();
            const soundtrackId = uuid();

            let soundtrack = {
                tags: {
                    "Language": data.language,
                    "CreatorId": socket.user.userId,
                },
                fileId: fileId,
                soundtrackId: soundtrackId,
                creationTime: cocoaTS(),
                objectId: data.objectId,
                mimeType: 'text/plain',
                revision: 1
            };

            if (data.soundtrackId) {    // if ParentSoundtrack
                soundtrack.tags.ParentSoundtrack = data.soundtrackId;
                delete soundtrack.tags.Language;
            }

            let speekData = {
                fileId: fileId,
                fileData: data.speekText,
            };

            await db.tracks.insertOne(soundtrack);
            await db.soundtracksData.insertOne(speekData);
            await db.objects.updateOne({objectId: data.objectId}, {$inc: {revision: 1}});

            cb(true);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(false);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminRemoveDevice', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('admin')) throw {msg: 'Permission denied'};

            await db.devices.deleteOne({deviceId: data.deviceId});

            cb(true);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(false);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminGetDumpList', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('developer')) throw {msg: 'Permission denied'};
            cb(dumper.getDumpList());
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(false);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminRestoreBackup', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('developer')) throw {msg: 'Permission denied'};

            //restore
            restore.restoreFromBackup(data.backupFile, data.dbName, cb);

        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(false);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminSetParent', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('admin')) throw {msg: 'Permission denied'};
            let {objectId, ParentObjectId} = data;
            log(objectId, ParentObjectId);
            if (!ParentObjectId || !objectId || ParentObjectId === objectId)  throw {msg: 'Wrong params'};

            let obj = await db.objects.findOne({objectId});
            if (!obj) throw {msg: 'Object is not defined'};

            let parentObj = await db.objects.findOne({objectId: ParentObjectId});
            if (!parentObj) throw {msg: 'Parent object is not defined'};

            await db.objects.updateOne({objectId: objectId}, {$set: {"tags.ParentObjectId": ParentObjectId}});
            await db.objects.updateOne({objectId: objectId}, {$inc: {revision: 1}});

            cb(true);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(false);
            } else {
                log(err);
            }
        });
    });
    // socket.on('adminSearch', function (data, cb) {
    //     (async () => {
    //         socket.ddos();
    //         if (!socket.rights('admin')) throw {msg: 'Permission denied'};
    //
    //         const line = data.line.toLowerCase();
    //         let response = {
    //             objs: {},
    //             status: true,
    //             count: 0
    //         };
    //
    //         let cursor = db.objects.find({});
    //
    //         for (let doc = await cursor.next(); doc !== null; doc = await cursor.next()){
    //
    //             if (Object.keys(doc.tags).reduce((acc, cur) => {
    //                 if (typeof doc.tags[cur] === 'string') {
    //                     return (doc.tags[cur].toLowerCase().indexOf(line) > -1) ? true : acc;
    //                 } else {
    //                     return acc;
    //                 }
    //
    //             }, false)) {
    //                 response.objs[doc.objectId] = null;
    //                 response.count++;
    //             }
    //
    //         }
    //
    //         cb(response);
    //     })().catch(err => {
    //         err.msg = err.msg || null;
    //         if (err.msg) {
    //             err.status = false;
    //             cb(false);
    //         } else {
    //             log(err);
    //         }
    //     });
    // });

    //  pending list
    socket.on('adminGetPendingListOfObject', function (data, cb) {  // get pending changes for current object
        (async () => {
            if (!socket.rights('admin')) throw {msg: 'Permission denied'};
            const list = await db.pendingList.find({objectId: data.objectId}, {limit: 4}).toArray();
            list.forEach(item => {
                (async() => {
                    item.creator = await getUser(item.userId, 74);
                })().catch(err => console.log(err));
            });

            let object;
            let objectIsExists = await db.objects.findOne({objectId: data.objectId});
            if (objectIsExists) {
                object = await objectContent(data.objectId);
            }else{  //no object in DB, when this pending request must create current object
                let query = await db.pendingList.findOne({objectId: data.objectId, queryName: "addNewObject"});
                if (query){
                    object = JSON.parse(query.data.data);
                    object.creator = await getUser(object.tags.CreatorId);
                } else {    // object from pending list was deleted / remove pendings
                    db.pendingList.deleteMany({objectId: data.objectId});
                }
            }

            cb({object, list});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(false);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminGetPendingList', function (data, cb) {    // get list of objects in pending list
        (async () => {
            if (!socket.rights('admin')) throw {msg: 'Permission denied'};
            let objectList = {};
            let list = await db.pendingList.find({}, {$projection: {objectId: 1}}).toArray();
            list.forEach((item) => {
                objectList[item.objectId] = objectList[item.objectId] || 0;
                objectList[item.objectId]++;
            });

            cb(objectList);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(false);
            } else {
                log(err);
            }
        });
    });
    socket.on('adminAcceptPending', function (data, cb) {    // accept task from pending list
        (async () => {
            // data.id, data.objectId
            let task = await db.pendingList.findOne({id: data.id});
            await db.pendingList.deleteOne({id: data.id});

            if (!task) throw {response: 'No such pending'};

            if (task.queryName === 'setTags') {
                setTags(task.data, () => {
                });
            } else if (task.queryName === 'addNewSoundtrack') {
                await addNewSoundtrack(task.data);
            } else if (task.queryName === 'addNewObject') {
                await addNewObject(task.data);
            } else if (task.queryName === 'addNewSight') {
                await addNewSight(task.data);
            } else if (task.queryName === 'setSoundtrackFile') {
                await rerecordSoundtrack(task.data);
            } else if (task.queryName === 'remove') {
                await removeObject(task.data);
            }

            // in future check all another pending changes for possible to append
            cb(true);
        })().catch(err => {
            log('error on adminAcceptPending - ', err);
            if (typeof err.response !== 'undefined') {
                // cb(err);
                cb(false);
            } else {
                // cb({
                //     response: 'Failed',
                //     message: 'Server error'
                // });
                cb(false);
            }
        });
    });
    socket.on('adminDeclinePending', function (data, cb) {    // get list of objects in pending list
        (async () => {
            // data.id, data.objectId
            await db.pendingList.deleteOne({id: data.id});
            // in future check all another pending changes for possible to append
            cb(true);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(false);
            } else {
                log(err);
                cb(false);
            }
        });
    });

    // handlers for user registration and log in
    socket.on('verifyUser', function (data, cb) { // data {email, deviceId} ???
        (async () => {
            socket.ddos();
            let email, confirmCode, cf, usr, dev, deviceId;

            data = JSON.parse(data.userData);   // !!!!!
            deviceId = socket.deviceId || data.deviceId || null;

            log('verifyUser', data.email, deviceId);

            if (deviceId && typeof data.email !== 'undefined' && validator.validate(data.email)) {
                email = data.email.toLowerCase();
            }
            // if all ok => generate confirmCode , store email & hPass & confirmCode to 'confirmation'
            if (email) {
                confirmCode = crypto.createHash('md5').update(email + deviceId).digest("hex");
                cf = await db.confirmation.findOne({deviceId: deviceId});

                usr = await db.users.findOne({email: email});
                if (usr) dev = await db.devices.findOne({deviceId: deviceId, userId: usr.userId});
                if (usr && dev) confirmCode = null;
            }
            if (confirmCode && !cf) {
                if (data.avatar && data.avatar.length > 1000) {
                    let buf = await sharp(Buffer.from(data.avatar, 'base64'))
                        .rotate()
                        .resize(260)
                        .toBuffer();

                    data.avatar = buf.toString('base64');
                } else {
                    data.avatar = null;
                }
                await db.confirmation.insertOne({
                    email: email,
                    deviceId: deviceId,
                    confirmCode: confirmCode,
                    nickname: data.nickname || null,
                    avatar: data.avatar || null,
                    ts: timestamp()
                });

            }
            // send email

            if (confirmCode) {
                cb({response: 'Ok'});
                mailer.send({
                    to: email,
                    text: generateConfirmationEmail(confirmCode)
                });
                if (cf) { // if confirmation was generated earlier
                    socket.emit('localMessage', 'Check your email please.');
                }
            } else if (usr && dev) {  //renew avatar && nickname
                cb({response: 'Ok'});

                if (data.avatar && data.avatar.length > 1000) {
                    let buf = await sharp(Buffer.from(data.avatar, 'base64'))
                        .rotate()
                        .resize(260)
                        .toBuffer();

                    socket.user.avatar = data.avatar = buf.toString('base64');
                } else {
                    let oldUser = await db.users.findOne({userId: usr.userId}, {
                        projection: {
                            "avatar": 1,
                            "nickname": 1
                        }
                    });
                    data.avatar = oldUser ? oldUser.avatar : null;
                    data.nickname = data.nickname ? data.nickname : oldUser.nickname;
                }

                await db.users.updateOne({userId: usr.userId}, {$set: {avatar: data.avatar, nickname: data.nickname}});

                socket.emit('localMessage', 'Nickname and avatar uploaded.');
                socket.emit('setUserId', {
                    userId: usr.userId,
                    avatar: data.avatar || null,
                    nickname: data.nickname || null,
                    rights: usr.rights || ''
                });
            } else {
                cb({
                    response: 'Failed',
                    reason: 'Duplicate email.'
                });
            }

        })().catch(err => {
            log(err);
            cb({
                response: 'Failed',
                reason: 'Server error'
            });
        });
    });
    socket.on('userConfirmEmail', function (data, cb) { //data: confirmCode
        (async () => {
            socket.ddos();
            if (typeof data.confirmCode !== 'undefined' && data.confirmCode.length > 5) {
                let userId;
                let confirm = await db.confirmation.findOne({confirmCode: data.confirmCode});
                if (confirm) {
                    //detach deviceId from another userId
                    await db.devices.deleteOne({deviceId: confirm.deviceId}); // maybe deviceId connected to another UID

                    //find || add to USERS
                    let user = await db.users.findOne({email: confirm.email});
                    if (!user) {
                        //generate new userId
                        userId = crypto.createHash('md5').update('userId' + confirm.email).digest("hex");
                        let ts = timestamp();
                        await db.users.insertOne({
                            email: confirm.email,
                            avatar: confirm.avatar || null,
                            nickname: confirm.nickname || null,
                            userId: userId,
                            registrationTS: ts,
                            lastAccess: ts,
                            rights: 'create'
                        });
                    } else {
                        userId = user.userId;   // use old userId

                    }

                    //add to DEVICES
                    await db.devices.insertOne({
                        deviceId: confirm.deviceId,
                        userId: userId
                    });

                    await db.confirmation.deleteOne({confirmCode: data.confirmCode});
                    cb(true);
                    //try to send request SETUSERID to client APP
                    for (let did in connections) {
                        if (!connections.hasOwnProperty(did)) continue;
                        if (did === confirm.deviceId) {
                            try {
                                connections[did].emit('setUserId', {
                                    userId: userId,
                                    rights: user ? user.rights : ''
                                });
                                connections[did].emit('localMessage', 'Your account confirmed');
                                connections[did].userId = userId;
                                break;
                            } catch (e) {
                            }
                        }
                    }
                } else {
                    cb(false);
                }
            }
        })().catch(err => {
            console.log(err);
            cb(false);
        });
    }); //onlyForWeb


    socket.on('userSetInfo', function (data, cb) {
        (async () => {
            socket.ddos();
            log('User set info');
            log(data);
            if (socket.userId) {

                await db.users.updateOne({userId: socket.userId}, {
                    $set: {
                        name: data.name || null,
                        avatar: data.avatar || null
                    }
                }, {upsert: false});

                cb({
                    response: 'Ok'
                });
            }
        })().catch(err => {
            log(err);
        })
    });
    //----------------

    //  WEB-tool for everyone
    socket.on('webLogin', function (data, cb) {
        (async () => {
            socket.ddos();
            let email = data.email.toLowerCase() || null;
            email = email && validator.validate(email) ? email : null;
            if (!email) throw {msg: 'Email is incorrect.'};

            let password = data.password || null;
            if (!password || password.length < 6 || password.length > 10) throw {msg: `Incorrect form of password.`};

            // check email
            let user = await db.users.findOne({email: email});
            if (!user) throw {msg: `This email wasn't registered in application.`};
            if (typeof user.password === 'undefined' || !user.password) throw {msg: `Click 'Send my password on email' to get your pass on email.`};

            // check pass
            let authOk = (user.password === crypto.createHash('md5').update(password).digest("hex"));
            if (!authOk) throw {msg: `Email or password is incorrect.`};


            //new session start
            await db.sessions.deleteOne({userId: user.userId});
            let sessionId = crypto.createHash('md5').update(Math.random + user.userId).digest('hex');
            await db.sessions.insertOne({
                userId: user.userId,
                sessionId: sessionId,
                started: timestamp()
            });
            user.sessionId = sessionId;

            // store user info in socket
            socket.user = user;
            socket.user.admin = (user.rights.indexOf('admin') > -1);
            // adminConnections
            if (user.rights.indexOf('admin') > -1) adminConnections.push(socket);

            delete user.password;
            cb({status: true, user: user});

        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webSessionEnter', function (data, cb) {
        (async () => {
            socket.ddos();
            if (data.sessionId.indexOf('{') > -1) throw {msg: 'Session error'};

            let session = await db.sessions.findOne({sessionId: data.sessionId});
            if (!session) throw {msg: 'Session error'};

            let user = await db.users.findOne({userId: session.userId}, {projection: {password: 0}});
            if (!user) throw {msg: 'User error'};
            await db.sessions.updateOne({sessionId: data.sessionId}, {$set: {lastAccess: timestamp()}});

            user.sessionId = session.sessionId;

            // store user info in socket
            socket.user = user;
            socket.user.admin = (user.rights.indexOf('admin') > -1);
            if (user.rights.indexOf('admin') > -1) adminConnections.push(socket);

            // check for groups membership
            const groups = await db.groups.find({members: user.userId}).toArray();

            cb({status: true, user, groups});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webLogout', function (data, cb) {
        (async () => {
            socket.ddos();
            await db.sessions.deleteOne({userId: socket.user.userId});
            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });

    socket.on('webPasswordChange', function (data, cb) {
        (async () => {
            socket.ddos();
            let email = data.email.toLowerCase() || null;
            email = email && validator.validate(email) ? email : null;
            if (!email) throw {msg: 'Email is incorrect.'};

            // check user
            let user = await db.users.findOne({email: email}, {projection: {userId: 1, password: 1}});
            if (!user) throw {msg: 'This email not registered in apps.'};

            const hash = user.password;
            const uid = user.userId;

            // send @
            const dev = config.get('dev') ? 'dev/' : '';
            const link = `https://triglav.paperus.eu/admin/${dev}password.html?code=${hash}&uid=${uid}`;
            mailer.send({
                to: email,
                text: `Confirm password change - <a href="${link}">here</a>.`
            });

            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    }); //  Request for change password
    socket.on('webNewPasswordConfirm', function (data, cb) {
        (async () => {
            socket.ddos();

            // check user
            let user = await db.users.findOne({userId: data.uid, password: data.code}, {projection: {_id: 1, email: 1}});
            if (!user) throw {msg: 'This uid not registered in apps.'};

            // generate new pass
            let newPass = crypto.createHash('md5').update(timestamp() + '_' + Math.random()).digest("hex").substr(0, 8);
            let hashedNewPass = crypto.createHash('md5').update(newPass).digest("hex");

            //write newPass to db
            await db.users.updateOne({_id: user._id}, {$set: {password: hashedNewPass}});

            // send @
            mailer.send({
                to: user.email,
                text: `Your new password - ${newPass}`
            });

            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    }); //  confirmation via email link

    socket.on('webGetSoundtrackData', function (data, cb) {
        (async () => {
            socket.ddos();
            let track = await db.tracks.findOne({soundtrackId: data}, {projection: {fileId: 1}});
            cb((await db.soundtracksData.findOne({fileId: track.fileId})).fileData);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webSaveTags', function (data, cb) {
        (async () => {
            socket.ddos();
            log('webSaveTags');
            log(data);
            const obj = await db.objects.findOne({objectId: data.objectId});
            if (obj.tags.CreatorId !== socket.user.userId && (socket.rights('edit') !== true || socket.rights('admin') !== true)){
                throw {msg: `You haven't rights.`};
            }

            data.tags.forEach(item => {
                const key = Object.keys(item)[0];
                const val = item[key];
                let updater = {};
                updater['tags.' + key] = val;
                log(updater);
                if (val === false) {
                    db.objects.updateOne({objectId: data.objectId}, {$unset: updater});
                } else {
                    db.objects.updateOne({objectId: data.objectId}, {$set: updater});
                }

            });
            await db.objects.updateOne({objectId: data.objectId}, {$inc: {revision: 1}});
            cb(true);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });

    //  GROUPS
    socket.on('webGroupCreate', function (data, cb) {
        (async () => {
            socket.ddos();

            //  publicAccess[bool], name, description

            const userId = socket.user.userId;
            const groupId = crypto.createHash('md5').update(uuid()).digest("hex");
            const publicAccess = data.publicAccess;
            const groupName = data.name || null;
            const description = data.description || null;

            if (!socket.user.userId || !socket.rights('create')) throw {msg: 'Permission denied'};
            if (!groupName || !description) throw {msg: 'No enough params'};

            let group = {
                creatorId: userId,
                groupId,
                admins: [userId],
                members: [userId],
                publicAccess,
                name: groupName,
                registrationTS: timestamp(),
                description,
            };

            await db.groups.insertOne(group);

            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webGroupsList', function (data, cb) {
        (async () => {
            socket.ddos();

            let selector = {};
            if (!socket.rights('create'))  throw {msg: 'Permission denied'};
            if (!socket.rights('admin')) selector = {members: socket.user.userId};

            const groups = await db.groups.find(selector).toArray();

            cb(groups);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webGroupInvite', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('create')) throw {msg: 'Permission denied'};

            const userId = socket.user.userId;

            const email = data.email.toLowerCase();

            const user = await db.users.findOne({email: email}, {projection: {userId: 1}});
            const uid = user.userId;
            const gid = data.groupId;
            const group = await db.groups.findOne({groupId: gid});

            if (!user || !group)  throw {msg: 'Something wrong'};
            if (group.creatorId !== userId && group.admins.indexOf(userId) === -1) throw {msg: 'Access denied'};

            const hash = crypto.createHash('md5').update(`${uid}${gid}!`).digest('hex');
            const dev = config.get('dev') ? 'dev/' : '';
            const link = `https://triglav.paperus.eu/admin/${dev}invitation.html?code=${hash}&uid=${uid}&group=${gid}`;

            mailer.send({
                to: email,
                topic: 'New invitation',
                text: `You have new invitation to the group - <a href="${link}">here</a>.<br>
                Group name - '${group.name}'.`,
            });

            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webGroupJoin', function (data, cb) {
        (async () => {
            socket.ddos();

            const {code, uid, gid} = data;
            if (!code || !uid || !gid) throw {msg: 'Wrong parameters!'};

            const hash = crypto.createHash('md5').update(`${uid}${gid}!`).digest('hex');
            if (hash !== code) throw {msg: 'Wrong invitation code!'};

            const group = await db.groups.findOne({groupId: gid});
            const user = await db.users.findOne({userId: uid}, {projection: {_id: 1}});

            if (!group) throw {msg: 'Wrong group id!'};
            if (!user) throw {msg: 'Wrong user id!'};
            if (group.members.indexOf(uid) > -1)  throw {msg: 'You already a member of this group.'};

            // passed all checks - make a member
            await db.groups.updateOne({groupId: gid}, {$addToSet: {members: uid}});

            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webGroupEdit', (data, cb) => {
        (async () => {
            socket.ddos();
            if (!socket.rights('create')) throw {msg: 'Permission denied'};

            const {groupId, name, description, publicAccess, memberAccess} = data;
            const uid = socket.user.userId;

            const group = await db.groups.findOne({groupId});
            if (!group)  throw {msg: 'Wrong group id!'};
            if (group.creatorId !== uid && group.admins.indexOf(uid) === -1)  throw {msg: 'Permission denied'};

            let changes = {};
            if (name) changes.name = name;
            if (memberAccess) changes.memberAccess = memberAccess;
            if (description) changes.description = description;
            if (typeof publicAccess !== 'undefined') changes.publicAccess = publicAccess;
            if (Object.keys(changes).length < 1) throw {msg: 'No enough parameters'};

            await db.groups.updateOne({groupId}, {$set: changes});

            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webGroupSetRights', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('admin')) throw {msg: 'Permission denied'};

            const {groupId, rights} = data;

            const group = await db.groups.findOne({groupId});
            if (!group)  throw {msg: 'Wrong group id!'};

            await db.groups.updateOne({groupId}, {$set: {rights}});

            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webGroupRemove', function (data, cb) {
        (async () => {
            socket.ddos();

            const {groupId} = data;
            const uid = socket.user.userId;

            // check rights
            const group = await db.groups.findOne({groupId});
            if (!group)  throw {msg: 'Wrong group id!'};
            const hasRights = !!(group.creatorId === uid || group.admins.indexOf(uid) > -1);
            if (!hasRights && !socket.rights('admin')) throw {msg: 'Permission denied'};

            // release group's content !!!!

            // remove group
            await db.groups.deleteOne({groupId});

            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webGroupSetUserRights', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('create')) throw {msg: 'Permission denied'};

            const {groupId, userId, rights} = data;
            const uid = socket.user.userId;

            const group = await db.groups.findOne({groupId, creatorId: uid});
            if (!group) throw {msg: 'Permission denied!'};

            await db.groups.updateOne({groupId}, {$addToSet: {admins: userId}});

            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webGroupExclude', (data, cb) => {
        (async () => {
            socket.ddos();
            if (!socket.rights('create')) throw {msg: 'Permission denied'};

            const {groupId, userId} = data;
            const uid = socket.user.userId;

            if (uid === userId)  throw {msg: 'Permission denied!'};

            const group = await db.groups.findOne({groupId, creatorId: uid});
            if (!group) throw {msg: 'Permission denied!'};

            await db.groups.updateOne({groupId}, {$pull: {members: userId, admins: userId}});

            cb({status: true});
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });
    socket.on('webGroupGetFullInfo', function (data, cb) {
        (async () => {
            socket.ddos();
            if (!socket.rights('create')) throw {msg: 'Permission denied'};

            const uid = socket.user.userId;
            const {groupId} = data;
            const group = await db.groups.findOne({groupId});
            if (!group) throw {msg: 'Wrong group id!'};
            if (group.members.indexOf(uid) < 0 && group.creatorId !== uid && !socket.rights('admin')) throw {msg: 'Permission denied!'};

            const projection = {projection: {userId: 1, avatar: 1, nickname: 1}};
            let cursor = db.users.find({userId: {$in: group.members}}, projection);
            for (let doc = await cursor.next(); doc !== null; doc = await cursor.next()) {
                const index = group.members.indexOf(doc.userId);

                group.members[index] = {
                    userId: doc.userId,
                    nickname: doc.nickname,
                    avatar: doc.avatar ? await resizeImg(doc.avatar, 100) : null,
                };
            }

            cb(group);
        })().catch(err => {
            err.msg = err.msg || null;
            if (err.msg) {
                err.status = false;
                cb(err);
            } else {
                log(err);
            }
        });
    });

    // -----------------------

    socket.on('disconnect', function () {
        if (typeof socket.user !== 'undefined' && typeof socket.user.admin !== 'undefined' && socket.user.admin) {
            log('admin disconnected');
            for (var i in adminConnections) {
                if (adminConnections[i].id === socket.id) adminConnections.splice(i, 1);
            }
        } else if (typeof socket.deviceId !== 'undefined') {
            log('user disconnected');
            delete connections[socket.deviceId];
        } else {
            log('undefined client disconnected');
        }
    });

};





