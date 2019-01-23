let config = require('../../config');
const nodeMailer = require('nodemailer');

let transporter = nodeMailer.createTransport({
    service: 'gmail',
    auth: {
        user: config.get("mail:login"),
        pass: config.get("mail:pass")
    }
});

module.exports.send = data => {
    const mailOptions = {
        from: 'Triglav app',
        to: data.to,
        subject: data.topic || 'Access to account',
        text: data.text,
        html: data.text
    };

    transporter.sendMail(mailOptions, (error, inf) => {
        console.log(error ? error : inf);
    });
};
