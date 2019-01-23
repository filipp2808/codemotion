let db;
let mongoDB = require('./mongo');
let sharp = require('sharp');

mongoDB.connect((err) => {  //connection to db init
    if (!err) db = mongoDB.getDb();
    console.log(!err ? 'Sight generator connected' : err);
});

let resizeImg = async (img, size) => {
    let buf = await sharp(Buffer.from(img, 'base64'))
        .resize(size)
        .toBuffer();
    return buf.toString('base64');
};

module.exports = async (sightId, size) => {
    let data = await db.sightsData.findOne({sightId: sightId});
    return resizeImg(data.recogImage, size);
};