const mongoose = require("mongoose");
// const bcrypt = require("bcrypt");
const User = require("../models/users");

const verifyUser = async (email, password, tenant) => {
    const tenantCode = String(tenant?.code || "").trim().toUpperCase();
    const tenantId = tenant?._id ? new mongoose.Types.ObjectId(tenant._id) : null;

    const person = await User.findOne({
        email,
        password,
        tenantCode,
    });

    if (!person) {
        const fallbackPerson = await User.findOne({
            email,
            password,
            $or: [
                { tenantCode: { $exists: false } },
                { tenantCode: null },
                { tenantCode: "" },
            ],
        });

        if (!fallbackPerson || !tenantId) {
            return null;
        }

        fallbackPerson.tenantId = tenantId;
        fallbackPerson.tenantCode = tenantCode;
        await fallbackPerson.save();
        return fallbackPerson;
    }

    if ((!person.tenantId || !person.tenantCode) && tenantId) {
        person.tenantId = tenantId;
        person.tenantCode = tenantCode;
        await person.save();
    }

    return person;
};

module.exports = { verifyUser };
