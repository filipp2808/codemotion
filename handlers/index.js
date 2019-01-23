let db;
let mongoDB = require('../utils/mongo');
mongoDB.connect((err) => {  //connection to db init
    if (!err) {
        db = mongoDB.getDb();
        mongoDB.initIndexes();  //create indexes for all collections
        console.log('MongoDB connected - ', mongoDB.dbConnected);
    } else {
        console.log(err);
    }
});
let connections = {};
let adminConnections = [];
let config = require('../config');
let mailer = require('../utils/mailer');
let dumper = require('../utils/dumper');
let restore = require('../utils/dumper/restore');
const crypto = require('crypto');
const validator = require('email-validator');
const sharp = require('sharp');
const uuid = require('uuid/v1');

if (!config.get('dev')) dumper.startSchedule(); // if this is productive server  - add DUMP task to schedule

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
};
const emitErrorHandler = (err, cb) => {
    err.msg = err.msg || null;
    if (err.msg) {
        err.status = false;
        cb(err);
    } else {
        log(err);
    }
};

// socket connection processing
module.exports = function (socket) {
    log('Client connected');

    socket.__proto__.rights = checkSocketRights;

    //  GROUPS
    socket.on('webGroupCreate', function (data, cb) {
        (async () => {
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
            emitErrorHandler(err, cb);
        });
    });
    socket.on('webGroupsList', function (data, cb) {
        (async () => {
            let selector = {};
            if (!socket.rights('create'))  throw {msg: 'Permission denied'};
            if (!socket.rights('admin')) selector = {members: socket.user.userId};

            const groups = await db.groups.find(selector).toArray();

            cb(groups);
        })().catch(err => {
            emitErrorHandler(err, cb);
        });
    });
    socket.on('webGroupEdit', (data, cb) => {
        (async () => {
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
            emitErrorHandler(err, cb);
        });
    });
    socket.on('webGroupSetRights', function (data, cb) {
        (async () => {
            if (!socket.rights('admin')) throw {msg: 'Permission denied'};

            const {groupId, rights} = data;

            const group = await db.groups.findOne({groupId});
            if (!group)  throw {msg: 'Wrong group id!'};

            await db.groups.updateOne({groupId}, {$set: {rights}});

            cb({status: true});
        })().catch(err => {
            emitErrorHandler(err, cb);
        });
    });
    socket.on('webGroupRemove', function (data, cb) {
        (async () => {
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
            emitErrorHandler(err, cb);
        });
    });
    socket.on('webGroupSetUserRights', function (data, cb) {
        (async () => {
            if (!socket.rights('create')) throw {msg: 'Permission denied'};

            const {groupId, userId, rights} = data;
            const uid = socket.user.userId;

            const group = await db.groups.findOne({groupId, creatorId: uid});
            if (!group) throw {msg: 'Permission denied!'};

            await db.groups.updateOne({groupId}, {$addToSet: {admins: userId}});

            cb({status: true});
        })().catch(err => {
            emitErrorHandler(err, cb);
        });
    });
    socket.on('webGroupExclude', (data, cb) => {
        (async () => {
            if (!socket.rights('create')) throw {msg: 'Permission denied'};

            const {groupId, userId} = data;
            const uid = socket.user.userId;

            if (uid === userId)  throw {msg: 'Permission denied!'};

            const group = await db.groups.findOne({groupId, creatorId: uid});
            if (!group) throw {msg: 'Permission denied!'};

            await db.groups.updateOne({groupId}, {$pull: {members: userId, admins: userId}});

            cb({status: true});
        })().catch(err => {
            emitErrorHandler(err, cb);
        });
    });
    socket.on('webGroupGetFullInfo', function (data, cb) {
        (async () => {
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
            emitErrorHandler(err, cb);
        });
    });

    socket.on('disconnect', function () {
        if (typeof socket.user !== 'undefined' && typeof socket.user.admin !== 'undefined' && socket.user.admin) {
            log('admin disconnected');
            for (let i in adminConnections) {
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





